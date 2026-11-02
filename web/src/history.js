// A circle's transaction history. The contract keeps no history, so this reads it from FastNEAR's
// transaction API and labels it using the method called and the circle's own log lines.
const API = "https://tx.test.fastnear.com/v0";
const PAGE_LIMIT = 200;
const DETAILS_CHUNK = 20;
// A very recent transaction may not have all its receipts indexed, so it is fetched again later.
const SETTLED_AFTER_MS = 60_000;
const settled = new Map();

async function post(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`History service returned ${response.status}`);
  return response.json();
}

export function normalizeTransaction(raw) {
  return {
    hash: raw.execution_outcome.id,
    timeMs: Number(raw.execution_outcome.block_timestamp) / 1e6,
    signer: raw.transaction.signer_id,
    receiver: raw.transaction.receiver_id,
    calls: raw.transaction.actions.flatMap((action) => (action?.FunctionCall ? [action.FunctionCall] : [])),
    receipts: raw.receipts.map((receipt) => ({
      executor: receipt.execution_outcome.outcome.executor_id,
      logs: receipt.execution_outcome.outcome.logs,
      failed: Boolean(receipt.execution_outcome.outcome.status?.Failure),
    })),
  };
}

export async function fetchCircleTransactions(circleId) {
  const { account_txs: found } = await post("/account", { account_id: circleId, limit: PAGE_LIMIT });
  const hashes = [...new Set(found.map((item) => item.transaction_hash))];
  const missing = hashes.filter((hash) => !settled.has(hash));
  const fresh = new Map();
  for (let start = 0; start < missing.length; start += DETAILS_CHUNK) {
    const { transactions } = await post("/transactions", { tx_hashes: missing.slice(start, start + DETAILS_CHUNK) });
    for (const raw of transactions) {
      const transaction = normalizeTransaction(raw);
      fresh.set(transaction.hash, transaction);
      if (Date.now() - transaction.timeMs > SETTLED_AFTER_MS) settled.set(transaction.hash, transaction);
    }
  }
  return hashes.flatMap((hash) => {
    const transaction = settled.get(hash) ?? fresh.get(hash);
    return transaction ? [transaction] : [];
  });
}

function parseLog(line) {
  const [name, ...pairs] = line.split(" ");
  return { name, ...Object.fromEntries(pairs.map((pair) => pair.split("="))) };
}

function proposalIdOf(call) {
  try {
    return JSON.parse(atob(call.args)).id;
  } catch {
    return undefined;
  }
}

/**
 * Turns transactions into events, newest first. Only events that moved money carry `amount`, so a
 * failed payment or a too-late approval can never be counted. `proposalLogs` holds the circle's log
 * lines for each proposal, which is what proves whether an approval really paid.
 */
export function buildHistory(transactions, circleId) {
  const events = [];
  const proposalLogs = new Map();
  let round = 0;

  for (const tx of [...transactions].sort((a, b) => a.timeMs - b.timeMs)) {
    const atCircle = tx.receipts.filter((receipt) => receipt.executor === circleId);
    const failed = atCircle.some((receipt) => receipt.failed);
    const lines = atCircle.flatMap((receipt) => receipt.logs);
    const logs = lines.map(parseLog);
    const method = tx.calls[0]?.method_name;
    const base = { hash: tx.hash, timeMs: tx.timeMs, account: tx.signer };

    if (method === "act_proposal") {
      const id = proposalIdOf(tx.calls[0]);
      if (id !== undefined) proposalLogs.set(id, [...(proposalLogs.get(id) ?? []), ...lines]);
      if (failed) events.push({ ...base, kind: "withdrawal-failed", round, proposalId: id });
    } else if (tx.receiver === circleId && failed) {
      events.push({ ...base, kind: "failed", method, round });
      continue;
    } else if (tx.receiver === circleId && method === "contribute") {
      events.push({ ...base, kind: "contribution", amount: BigInt(tx.calls[0].deposit), round });
    } else if (tx.receiver === circleId && method === "join") {
      events.push({ ...base, kind: "join" });
    } else if (tx.receiver === circleId && method === "new") {
      events.push({ ...base, kind: "created" });
    } else if (tx.receiver === circleId && method === "claim") {
      events.push({ ...base, kind: "claim" });
    }

    const repaidBy = (account) => logs
      .filter((log) => log.name === "debt_repaid" && log.debtor === account)
      .reduce((sum, log) => sum + BigInt(log.amount), 0n);
    const added = [];
    for (const log of logs) {
      if (log.name === "round_paid") {
        // The log gives the whole pot. Anything the winner owed went to someone else first.
        added.push({ ...base, kind: "payout", account: log.winner, round: Number(log.round), amount: BigInt(log.amount) - repaidBy(log.winner) });
        round = Number(log.round) + 1;
      } else if (log.name === "debt_repaid") {
        added.push({ ...base, kind: "repayment", account: log.creditor, debtor: log.debtor, amount: BigInt(log.amount) });
      } else if (log.name === "reclaimed") {
        added.push({ ...base, kind: "reclaim", account: log.account, round: Number(log.round), amount: BigInt(log.amount) - repaidBy(log.account) });
      } else if (log.name === "early_withdrawal") {
        added.push({ ...base, kind: "withdrawal", account: log.recipient, round: Number(log.round), amount: BigInt(log.amount) });
      } else if (log.name === "early_withdrawal_refused") {
        added.push({ ...base, kind: "withdrawal-refused", account: log.recipient, round: Number(log.round), requested: BigInt(log.amount) });
      }
    }
    for (const log of logs.filter((item) => item.name === "transfer_failed")) {
      const match = added.find((event) => event.account === log.recipient && event.amount === BigInt(log.amount));
      if (match) match.transferFailed = true;
    }
    events.push(...added);
  }
  return { events: events.reverse(), proposalLogs };
}

const MONEY_OUT = new Set(["payout", "repayment", "withdrawal", "reclaim"]);

export function totals(events) {
  let contributed = 0n;
  let paidOut = 0n;
  for (const event of events) {
    if (event.kind === "contribution") contributed += event.amount;
    if (MONEY_OUT.has(event.kind)) paidOut += event.amount;
  }
  return { contributed, paidOut };
}
