// Signs the demo's fixed steps on the server, so the demo accounts' keys never reach a browser.
// Keys come from the DEMO_KEY_M1, DEMO_KEY_M2 and DEMO_KEY_M3 environment variables.
import { Account, FailoverRpcProvider, JsonRpcProvider } from "near-api-js";
import config from "../src/demo-config.js";
import { CONTRIBUTION, STEPS } from "../src/demo-steps.js";

const TGAS = 10n ** 12n;
// Public endpoints are rate limited, so a request moves to the next one when it is refused.
const RPC_URLS = [process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"];
const provider = new FailoverRpcProvider(RPC_URLS.map((url) => new JsonRpcProvider({ url })));
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });
class Refused extends Error {}

function signer(label) {
  const key = process.env[`DEMO_KEY_${label.toUpperCase()}`];
  if (!key) throw new Refused("The demo is not configured: a DEMO_KEY environment variable is missing.");
  return new Account(config.accounts[label], provider, key);
}

/** The first run that nobody has started, checked on chain so the server keeps no state. */
async function nextRun() {
  for (const [run, circles] of config.runs.entries()) {
    const states = await Promise.all([view(circles.full, "get_circle"), view(circles.late, "get_circle")]);
    if (states.every((state) => state.members.length === 0)) return { run, ...circles, daoId: config.daoId };
  }
  throw new Refused("All the prepared demo circles have been used. Run scripts/prepare-demo.mjs to add more.");
}

async function send(account, receiverId, methodName, args, { gas = 100n, deposit = 0n } = {}) {
  const result = await account.callFunctionRaw({
    contractId: receiverId, methodName, args, gas: gas * TGAS, deposit, waitUntil: "FINAL",
  });
  const outcomes = [result.transaction_outcome, ...(result.receipts_outcome ?? [])];
  const failures = outcomes.flatMap((item) => (item?.outcome?.status?.Failure ? [JSON.stringify(item.outcome.status.Failure)] : []));
  if (failures.length > 0) throw new Refused(`The transaction failed: ${failures.join("; ")}`);
  const encoded = result.status?.SuccessValue;
  return {
    hash: result.transaction?.hash ?? result.transaction_outcome?.id,
    sender: account.accountId,
    value: encoded ? JSON.parse(Buffer.from(encoded, "base64").toString()) : undefined,
  };
}

async function runStep({ stepId, run, proposalId }) {
  const step = STEPS.find((candidate) => candidate.id === stepId);
  const circles = Number.isInteger(run) ? config.runs[run] : undefined;
  if (!step || !step.signer || !circles) throw new Refused("Unknown demo step.");
  const circleId = circles[step.circle];
  const account = signer(step.signer);

  switch (step.action) {
    case "join":
      return send(account, circleId, "join", {});
    case "pay":
      return send(account, circleId, "contribute", {}, { deposit: BigInt(CONTRIBUTION) });
    case "reclaim":
      return send(account, circleId, "reclaim", {});
    case "propose": {
      const args = { recipient: config.accounts[step.recipient], amount: step.amount, round: step.round };
      const kind = {
        FunctionCall: {
          receiver_id: circleId,
          actions: [{
            method_name: "execute_early_withdrawal",
            args: Buffer.from(JSON.stringify(args)).toString("base64"),
            deposit: "0",
            gas: String(150n * TGAS),
          }],
        },
      };
      const { proposal_bond: bond } = await view(config.daoId, "get_policy");
      return send(account, config.daoId, "add_proposal", { proposal: { description: step.text, kind } }, { deposit: BigInt(bond) });
    }
    case "vote": {
      if (!Number.isInteger(proposalId)) throw new Refused("Unknown proposal.");
      const proposal = await view(config.daoId, "get_proposal", { id: proposalId });
      // Votes are only ever cast on this circle's own withdrawal requests.
      if (proposal.kind?.FunctionCall?.receiver_id !== circleId) throw new Refused("That proposal is not part of this demo.");
      return send(account, config.daoId, "act_proposal", { id: proposalId, action: "VoteApprove", proposal: proposal.kind }, { gas: 300n });
    }
    default:
      throw new Refused("Unknown demo step.");
  }
}

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return reply(res, 405, { error: "Use POST." });
  try {
    const body = req.body ?? {};
    return reply(res, 200, body.action === "start" ? await nextRun() : await runStep(body));
  } catch (error) {
    if (error instanceof Refused) return reply(res, 400, { error: error.message });
    // Details stay in the server log. The message of an unexpected error is not sent to the browser.
    console.error(error);
    return reply(res, 500, { error: "The demo server hit an unexpected error. Please try again." });
  }
}
