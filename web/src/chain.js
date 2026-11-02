// Reads from NEAR testnet over JSON-RPC. Nothing here signs anything.
// Public endpoints are rate limited, so a read moves to the next one when it is refused.
const RPC_URLS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"];
let preferred = 0;
export const txUrl = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;
const YOCTO_PER_NEAR = 10n ** 24n;

async function rpc(method, params) {
  let lastError;
  for (let tried = 0; tried < RPC_URLS.length; tried += 1) {
    const index = (preferred + tried) % RPC_URLS.length;
    let body;
    try {
      const response = await fetch(RPC_URLS[index], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "ajo", method, params }),
      });
      body = await response.json();
      if (!response.ok && !body.error) throw new Error(`HTTP ${response.status}`);
      // A rate limit says nothing about the chain, so it counts as this endpoint being unavailable.
      if (body.error?.code === -429) throw new Error("rate limited");
    } catch (error) {
      lastError = error;
      continue;
    }
    preferred = index;
    if (body.error) throw new Error(body.error.data ?? body.error.message ?? "RPC error");
    return body.result;
  }
  throw lastError;
}

export async function view(contractId, method, args = {}) {
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contractId,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

/** Chain time in milliseconds. The chain decides deadlines, and a PC clock can be well off. */
export async function chainNowMs() {
  const block = await rpc("block", { finality: "final" });
  return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
}

// A final transaction never changes, so each one is only fetched once.
const transactions = new Map();
export async function fetchTransaction(hash, sender) {
  if (!transactions.has(hash)) {
    transactions.set(hash, await rpc("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" }));
  }
  return transactions.get(hash);
}

/** Every failure in a transaction, including failed cross-contract calls. */
export function failuresIn(transaction) {
  const outcomes = [transaction?.transaction_outcome, ...(transaction?.receipts_outcome ?? [])];
  return outcomes.flatMap((item) => (item?.outcome?.status?.Failure ? [JSON.stringify(item.outcome.status.Failure)] : []));
}

/** Parses a decimal NEAR string into yoctoNEAR without float rounding. Throws if it is not a number. */
export function parseNear(text) {
  if (!/^\d+(\.\d{1,24})?$/.test(text.trim())) throw new Error(`"${text}" is not a NEAR amount.`);
  const [whole, fraction = ""] = text.trim().split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(24, "0"));
}

export function formatNear(yocto) {
  const value = BigInt(yocto);
  const fraction = (value % YOCTO_PER_NEAR).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return `${value / YOCTO_PER_NEAR}${fraction ? `.${fraction}` : ""} NEAR`;
}

/** The DAO's withdrawal requests for this circle, newest first, with their arguments decoded. */
export async function loadWithdrawals(daoId, circleId) {
  const last = await view(daoId, "get_last_proposal_id");
  const limit = 50;
  const proposals = await view(daoId, "get_proposals", { from_index: Math.max(0, last - limit), limit });
  return proposals.flatMap((proposal) => {
    const call = proposal.kind?.FunctionCall;
    const action = call?.actions?.[0];
    if (call?.receiver_id !== circleId || action?.method_name !== "execute_early_withdrawal") return [];
    return [{ ...proposal, request: JSON.parse(atob(action.args)) }];
  }).reverse();
}
