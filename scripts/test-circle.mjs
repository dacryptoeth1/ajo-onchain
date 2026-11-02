// End-to-end tests for the circle contract on NEAR testnet, against real Sputnik DAOs.
// Each scenario deploys its own circle, at 2 NEAR that cannot be recovered, so run only what you need:
//   npm run test:circle -- window          one scenario
//   npm run test:circle -- window debt     several
//   npm run test:circle -- all             the full suite
// Exits non-zero if any check fails.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, KeyPair, actions } from "near-api-js";
import {
  FACTORY, FAUCET_URL, SILENCE_DAO_FILE, TGAS, balanceOf, buildDaoPolicy, call, formatNear, isAllMembers,
  loadAccounts, loadDeployers, loadDeployment, near, provider, readJson, sameSet, saveDeployers, txUrl, view,
  writeJson,
} from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(ROOT, "contract", "target", "wasm32-unknown-unknown", "release", "ajo_circle.wasm");
const RESULT_FILE = join(ROOT, "deployments", "last-circle-test.json");

const C = near("0.1"); // Contribution per round.
const AMOUNT = near("0.05"); // Early withdrawal used throughout.
const GAS_ALLOWANCE = near("0.01");
const CONTRACT_FUNDING = near("2"); // Storage for the contract and its state.
const DEPLOYER_MINIMUM = near("4"); // One contract plus the test accounts made under the deployer.
const SILENCE_PERIOD_S = 150;
const LONG_ROUND_S = 86400; // Long enough that the deadline plays no part in a test.
const SECOND_NS = 1_000_000_000n;
const runId = randomBytes(3).toString("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => sleep(3000); // Lets gas refund receipts land before balances are compared.

const results = [];
const circles = {};
let failed = 0;
const heading = (text) => console.log(`\n=== ${text}`);
function check(label, passed, detail = "") {
  if (!passed) failed += 1;
  results.push({ label, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
async function expectRejected(label, code, send) {
  const result = await send();
  const rejected = !result.ok && String(result.error).includes(code);
  check(label, rejected, rejected ? code : `got: ${result.ok ? "success" : result.error}`);
}
const isLessGas = (delta, amount) => delta > amount - GAS_ALLOWANCE && delta <= amount;

// Checked before anything else, so a bad scenario name cannot spend any NEAR.
const SCENARIO_NAMES = ["rules", "main", "silence", "payout", "late", "window", "debt", "idle"];
const requested = process.argv.slice(2);
const names = requested.includes("all") ? SCENARIO_NAMES : requested;
if (names.length === 0 || names.some((name) => !SCENARIO_NAMES.includes(name))) {
  console.error(`Choose what to run: npm run test:circle -- <${SCENARIO_NAMES.join("|")}|all>`);
  process.exit(1);
}

const { members: [m1, m2, m3], outsider } = loadAccounts();
const memberIds = [m1, m2, m3].map((m) => m.accountId);
const code = readFileSync(WASM);

async function ensureDeployer() {
  const deployers = loadDeployers();
  const current = deployers.at(-1);
  if (current && (await balanceOf(current.accountId)) >= DEPLOYER_MINIMUM) {
    return new Account(current.accountId, provider, current.privateKey);
  }
  const keyPair = KeyPair.fromRandom("ed25519");
  const accountId = `ajo-${randomBytes(3).toString("hex")}-deployer.testnet`;
  const response = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
  });
  if (!response.ok) throw new Error(`Faucet refused ${accountId}: ${response.status}`);
  saveDeployers([...deployers, { accountId, privateKey: keyPair.toString() }]);
  console.log(`created ${accountId}`);
  return new Account(accountId, provider, keyPair.toString());
}

/** Creates, deploys and initializes in one transaction, adding no access key to the account. */
async function deployCircle(prefix, daoId, contribution, invited, roundDurationSec = LONG_ROUND_S) {
  const deployer = await ensureDeployer();
  const contractId = `${prefix}-${runId}.${deployer.accountId}`;
  await deployer.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.createAccount(),
      actions.transfer(CONTRACT_FUNDING),
      actions.deployContract(code),
      actions.functionCall(
        "new",
        { dao_id: daoId, contribution: contribution.toString(), round_duration_sec: roundDurationSec, invited },
        100n * TGAS,
        0n,
      ),
    ],
    waitUntil: "FINAL",
  });
  console.log(`deployed ${contractId}`);
  circles[prefix] = contractId;
  return contractId;
}

const circleOf = (id) => view(id, "get_circle");
const pay = (account, circle, amount = C) => call(account, circle, "contribute", {}, { deposit: amount });
const potOf = async (circle) => BigInt((await circleOf(circle)).pot);
const reclaim = (account, circle) => call(account, circle, "reclaim", {});
const joinAll = async (circle, accounts = [m1, m2, m3]) => {
  for (const member of accounts) await call(member, circle, "join", {});
};
// Uses the chain's clock. A PC clock can be off by enough to act before the real deadline.
const chainTimeNs = async () => BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp_nanosec);
async function waitForRoundDeadline(circle) {
  const deadline = BigInt((await circleOf(circle)).round_deadline_ns);
  console.log("waiting on the chain clock for the round deadline");
  while ((await chainTimeNs()) < deadline) await sleep(3000);
}
/** Runs `send`, then returns how much `accountId`'s balance changed. */
async function balanceChange(accountId, send) {
  await settle();
  const before = await balanceOf(accountId);
  const result = await send();
  await settle();
  return { delta: (await balanceOf(accountId)) - before, result };
}

/** An early withdrawal request is a DAO proposal that calls the circle if everyone approves. */
function withdrawalKind(circle, recipient, amount, round) {
  const args = Buffer.from(JSON.stringify({ recipient, amount: amount.toString(), round })).toString("base64");
  return {
    FunctionCall: {
      receiver_id: circle,
      actions: [{ method_name: "execute_early_withdrawal", args, deposit: "0", gas: String(150n * TGAS) }],
    },
  };
}
async function propose(proposer, daoId, circle, recipient, amount, round, description) {
  const bond = BigInt((await view(daoId, "get_policy")).proposal_bond);
  const kind = withdrawalKind(circle, recipient, amount, round);
  const result = await call(proposer, daoId, "add_proposal", { proposal: { description, kind } }, { deposit: bond });
  if (!result.ok) throw new Error(`add_proposal failed: ${result.error}`);
  return { id: result.value, kind: (await view(daoId, "get_proposal", { id: result.value })).kind };
}
const act = (account, daoId, proposal, action) =>
  call(account, daoId, "act_proposal", { id: proposal.id, action, proposal: proposal.kind }, { gas: 300n });
const statusOf = async (daoId, proposal) => (await view(daoId, "get_proposal", { id: proposal.id })).status;
/** Every member approves. Returns the last vote, which is the one that runs the call. */
async function approveAll(daoId, proposal) {
  let last;
  for (const member of [m1, m2, m3]) last = await act(member, daoId, proposal, "VoteApprove");
  return last;
}
/** Asserts a fully approved withdrawal was refused by the circle for this reason, moving nothing. */
async function expectRefusedByCircle(label, reason, daoId, circle, recipient, amount, round) {
  const potBefore = await potOf(circle);
  const proposal = await propose(m2, daoId, circle, recipient, amount, round, label);
  const last = await approveAll(daoId, proposal);
  const status = await statusOf(daoId, proposal);
  const refused = status === "Failed" && String(last.error).includes(reason) && (await potOf(circle)) === potBefore;
  check(label, refused, refused ? reason : `${status}: ${last.error}`);
}

// ---------------------------------------------------------------------------------------------
async function rules() {
  heading("Deployment rules");
  const daoId = loadDeployment().daoId;
  const initRejected = async (label, codeText, contribution, invited, duration) => {
    try {
      await deployCircle(`bad${randomBytes(2).toString("hex")}`, daoId, contribution, invited, duration);
      check(label, false, "deploy succeeded");
    } catch (error) {
      check(label, String(error?.message ?? error).includes(codeText), codeText);
    }
  };
  await initRejected("rejects duplicate members", "ERR_DUPLICATE_INVITE", C, [memberIds[0], memberIds[0]]);
  await initRejected("rejects a one-member circle", "ERR_TOO_FEW_MEMBERS", C, [memberIds[0]]);
  await initRejected("rejects a zero contribution", "ERR_ZERO_CONTRIBUTION", 0n, memberIds);
  await initRejected("rejects a zero round duration", "ERR_ZERO_DURATION", C, memberIds, 0);
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const daoId = loadDeployment().daoId;
  const circle = await deployCircle("main", daoId, C, memberIds);
  const keys = await provider.viewAccessKeyList({ accountId: circle });
  check("contract has no access keys, so its code cannot be replaced", keys.keys.length === 0, `${keys.keys.length} keys`);
  await expectRejected("nobody can initialize it again", "already", () =>
    call(m1, circle, "new", { dao_id: m1.accountId, contribution: "1", round_duration_sec: 1, invited: [m1.accountId, m2.accountId] }));

  heading("Main circle: joining");
  await expectRejected("a stranger cannot join", "ERR_NOT_INVITED", () => call(outsider, circle, "join", {}));
  check("join m2", (await call(m2, circle, "join", {})).ok);
  await expectRejected("a member cannot join twice", "ERR_ALREADY_JOINED", () => call(m2, circle, "join", {}));
  await expectRejected("nobody can pay before everyone joined", "ERR_NOT_ACTIVE", () => pay(m2, circle));
  check("join m3", (await call(m3, circle, "join", {})).ok);
  check("no deadline runs until everyone has joined", (await circleOf(circle)).round_deadline_ns === null);
  const beforeLastJoin = await chainTimeNs();
  check("join m1", (await call(m1, circle, "join", {})).ok);
  const joined = await circleOf(circle);
  const firstDeadline = BigInt(joined.round_deadline_ns);
  const oneRoundNs = BigInt(LONG_ROUND_S) * SECOND_NS;
  check(
    "the last join starts round 0's deadline, one round away",
    firstDeadline >= beforeLastJoin + oneRoundNs && firstDeadline <= (await chainTimeNs()) + oneRoundNs,
  );
  check("rotation follows join order", joined.members.join() === [m2, m3, m1].map((m) => m.accountId).join(), "m2, m3, m1");
  check("circle is active once everyone joined", joined.phase === "Active" && joined.winner === m2.accountId);

  heading("Main circle: paying rules");
  const wrong = await balanceChange(m1.accountId, async () => {
    await expectRejected("underpayment is rejected", "ERR_WRONG_AMOUNT", () => pay(m1, circle, C - 1n));
    await expectRejected("overpayment is rejected", "ERR_WRONG_AMOUNT", () => pay(m1, circle, C + 1n));
  });
  check("rejected payments were refunded, only gas was spent", -wrong.delta < GAS_ALLOWANCE, formatNear(-wrong.delta));
  check("pot is still empty", (await potOf(circle)) === 0n);
  await expectRejected("a non-member cannot pay", "ERR_NOT_MEMBER", () => pay(outsider, circle));

  heading("Main circle round 0: winner m2. m2 and m1 pay, m3 has not");
  check("m2 pays", (await pay(m2, circle)).ok);
  await expectRejected("a member cannot pay twice in a round", "ERR_ALREADY_PAID", () => pay(m2, circle));
  check("m1 pays", (await pay(m1, circle)).ok);
  let state = await circleOf(circle);
  check("pot holds 2 contributions and the round is still open", BigInt(state.pot) === 2n * C && state.round === 0, formatNear(state.pot));

  heading("Early withdrawal: rules enforced by the circle");
  await expectRejected("a member cannot call the withdrawal directly", "ERR_ONLY_DAO", () =>
    call(m1, circle, "execute_early_withdrawal", { recipient: m1.accountId, amount: "1", round: 0 }));

  heading("Early withdrawal: 2 of 3 yes, 1 no");
  const refused = await propose(m2, daoId, circle, m1.accountId, AMOUNT, 0, "m1 asks for 0.05, m3 says no");
  await settle();
  const m1BeforeRefused = await balanceOf(m1.accountId);
  await act(m2, daoId, refused, "VoteApprove");
  await act(m3, daoId, refused, "VoteReject");
  const partial = await statusOf(daoId, refused);
  await settle();
  check("one no vote leaves it open and unpaid", partial === "InProgress" && (await balanceOf(m1.accountId)) === m1BeforeRefused, partial);
  await act(m1, daoId, refused, "VoteApprove");
  const twoYesOneNo = await statusOf(daoId, refused);
  check("2 yes and 1 no does not pass", twoYesOneNo === "InProgress", twoYesOneNo);
  check("the circle's pot did not move", (await potOf(circle)) === 2n * C);
  await expectRejected("the no voter cannot be counted again", "ERR_ALREADY_VOTED", () => act(m3, daoId, refused, "VoteApprove"));

  heading("Early withdrawal: the round's winner must agree too");
  check("m2 is this round's winner", (await circleOf(circle)).winner === m2.accountId);
  const winnerRefuses = await propose(m1, daoId, circle, m1.accountId, AMOUNT, 0, "Everyone but the winner agrees");
  await act(m1, daoId, winnerRefuses, "VoteApprove");
  await act(m3, daoId, winnerRefuses, "VoteApprove");
  const winnerSilent = await statusOf(daoId, winnerRefuses);
  check("yes from both others is not enough while the winner is silent", winnerSilent === "InProgress" && (await potOf(circle)) === 2n * C, winnerSilent);
  await act(m2, daoId, winnerRefuses, "VoteReject");
  const winnerNo = await statusOf(daoId, winnerRefuses);
  check("the winner's no blocks it", winnerNo === "InProgress" && (await potOf(circle)) === 2n * C, winnerNo);

  heading("Early withdrawal: 3 of 3 yes");
  const approved = await propose(m2, daoId, circle, m1.accountId, AMOUNT, 0, "m1 asks for 0.05, all agree");
  await act(m1, daoId, approved, "VoteApprove");
  await act(m2, daoId, approved, "VoteApprove");
  const atTwo = await statusOf(daoId, approved);
  check("still open at 2 of 3", atTwo === "InProgress" && (await potOf(circle)) === 2n * C, atTwo);
  const paid = await balanceChange(m1.accountId, () => act(m3, daoId, approved, "VoteApprove"));
  console.log(`third vote: ${txUrl(paid.result.hash)}`);
  const paidStatus = await statusOf(daoId, approved);
  check("approved at 3 of 3", paidStatus === "Approved", paidStatus);
  check("requester received exactly the amount", paid.delta === AMOUNT, formatNear(paid.delta));
  const votes = (await view(daoId, "get_proposal", { id: approved.id })).votes;
  check("the winner's approval is one of the 3 recorded votes", votes[m2.accountId] === "Approve" && Object.keys(votes).length === 3);
  check("pot went down by exactly the amount", (await potOf(circle)) === 2n * C - AMOUNT);
  await expectRejected("an approved proposal cannot run again", "ERR_PROPOSAL_NOT_IN_PROGRESS", () => act(m1, daoId, approved, "Finalize"));

  heading("Early withdrawal: approved, but the circle refuses");
  await expectRefusedByCircle("a request past one contribution fails", "ERR_AMOUNT_EXCEEDS_SHARE", daoId, circle, m2.accountId, C + 1n, 0);
  await expectRefusedByCircle("a second request past one contribution in total fails", "ERR_AMOUNT_EXCEEDS_SHARE", daoId, circle, m1.accountId, C - AMOUNT + 1n, 0);
  await expectRefusedByCircle("a member who has not paid this round cannot withdraw", "ERR_RECIPIENT_NOT_PAID", daoId, circle, m3.accountId, near("0.01"), 0);
  await expectRefusedByCircle("paying a non-member fails even with 3 yes votes", "ERR_NOT_MEMBER", daoId, circle, outsider.accountId, near("0.01"), 0);

  heading("A proposal for round 0 is left waiting for its last vote");
  const stale = await propose(m2, daoId, circle, m1.accountId, near("0.01"), 0, "Approved too late");
  await act(m1, daoId, stale, "VoteApprove");
  await act(m2, daoId, stale, "VoteApprove");

  heading("Main circle: m3's payment completes round 0");
  const round0 = await balanceChange(m2.accountId, () => pay(m3, circle));
  console.log(`m3's payment: ${txUrl(round0.result.hash)}`);
  state = await circleOf(circle);
  check("winner m2 is paid automatically: 3 contributions less the withdrawal", round0.delta === 3n * C - AMOUNT, formatNear(round0.delta));
  check("next round starts empty with winner m3", state.round === 1 && BigInt(state.pot) === 0n && state.winner === m3.accountId);
  check("paying early keeps the fixed schedule: the deadline moves exactly one round", BigInt(state.round_deadline_ns) === firstDeadline + oneRoundNs);
  const debt = state.debts[0];
  check(
    "m1 now owes m2 the withdrawal",
    state.debts.length === 1 && debt.debtor === m1.accountId && debt.creditor === m2.accountId && BigInt(debt.amount) === AMOUNT,
  );

  heading("Main circle round 1: winner m3");
  check("m3 pays", (await pay(m3, circle)).ok);
  check("m1 pays", (await pay(m1, circle)).ok);
  const staleBefore = await potOf(circle);
  await act(m3, daoId, stale, "VoteApprove");
  const staleStatus = await statusOf(daoId, stale);
  check("a round 0 approval cannot take round 1 money", staleStatus === "Failed" && (await potOf(circle)) === staleBefore, staleStatus);
  const round1 = await balanceChange(m3.accountId, () => pay(m2, circle));
  check("winner m3 receives exactly 3 contributions, the debt is not m3's", round1.delta === 3n * C, formatNear(round1.delta));

  heading("Main circle round 2: winner m1, who owes m2");
  check("m1 pays", (await pay(m1, circle)).ok);
  check("m2 pays", (await pay(m2, circle)).ok);
  await expectRefusedByCircle("a member whose turn has passed cannot withdraw", "ERR_TURN_ALREADY_PAID", daoId, circle, m2.accountId, near("0.01"), 2);
  await settle();
  const m1Before = await balanceOf(m1.accountId);
  const m2Before = await balanceOf(m2.accountId);
  check("m3 pays", (await pay(m3, circle)).ok);
  await settle();
  const m1Delta = (await balanceOf(m1.accountId)) - m1Before;
  const m2Delta = (await balanceOf(m2.accountId)) - m2Before;
  state = await circleOf(circle);
  check("m1's payout is reduced by the withdrawal it already had", m1Delta === 3n * C - AMOUNT, formatNear(m1Delta));
  check("m2, who was paid short in round 0, is made whole", m2Delta === AMOUNT, formatNear(m2Delta));
  check(
    "over the circle m1 and m2 both got exactly 3 contributions",
    AMOUNT + m1Delta === 3n * C && round0.delta + m2Delta === 3n * C,
  );
  check("no debts remain", state.debts.length === 0);
  check("circle is finished with nothing left in the pot", state.phase === "Finished" && BigInt(state.pot) === 0n && state.winner === null);
  check("a finished circle has no deadline", state.round_deadline_ns === null);
  await expectRejected("nobody can reclaim from a finished circle", "ERR_NOT_CLOSED", () => reclaim(m1, circle));
  await expectRejected("nobody can pay after the circle finished", "ERR_NOT_ACTIVE", () => pay(m1, circle));
}

// ---------------------------------------------------------------------------------------------
async function silence() {
  heading(`Silence counts as no, using a DAO with a ${SILENCE_PERIOD_S} second voting period`);
  let daoId = readJson(SILENCE_DAO_FILE)?.daoId;
  if (!daoId) {
    const name = `ajo-silence-${runId}`;
    daoId = `${name}.${FACTORY}`;
    const period = String(BigInt(SILENCE_PERIOD_S) * SECOND_NS);
    const args = Buffer.from(JSON.stringify({
      config: { name: "Ajo silence test", purpose: "Tests proposal expiry", metadata: "" },
      policy: buildDaoPolicy(memberIds, period),
    })).toString("base64");
    const created = await call(m3, FACTORY, "create", { name, args }, { gas: 300n, deposit: near("6") });
    if (!created.ok) throw new Error(`Silence DAO failed: ${created.error}`);
    writeJson(SILENCE_DAO_FILE, { daoId, periodSeconds: SILENCE_PERIOD_S });
  }
  console.log(`DAO: ${daoId}`);
  const circle = await deployCircle("silence", daoId, C, memberIds);
  await joinAll(circle);
  await pay(m1, circle);
  await pay(m2, circle);

  const noVotes = await propose(m2, daoId, circle, m1.accountId, AMOUNT, 0, "Nobody votes");
  const lateVote = await propose(m2, daoId, circle, m1.accountId, AMOUNT, 0, "m3 stays silent, then votes late");
  const neverVoted = await propose(m2, daoId, circle, m1.accountId, AMOUNT, 0, "m3 never votes");
  await act(m1, daoId, lateVote, "VoteApprove");
  await act(m2, daoId, lateVote, "VoteApprove");
  await act(m1, daoId, neverVoted, "VoteApprove");
  await act(m2, daoId, neverVoted, "VoteApprove");
  await expectRejected("finalize before expiry is rejected", "ERR_PROPOSAL_NOT_EXPIRED_OR_FAILED", () => act(m1, daoId, neverVoted, "Finalize"));
  const submitted = BigInt((await view(daoId, "get_proposal", { id: neverVoted.id })).submission_time);
  const expiresAtNs = submitted + BigInt(SILENCE_PERIOD_S) * SECOND_NS;
  console.log("waiting on the chain clock for proposals to expire");
  while ((await chainTimeNs()) <= expiresAtNs) await sleep(5000);
  check("every proposal's deadline has passed on chain before the late vote", (await chainTimeNs()) > expiresAtNs);

  const potAtExpiry = await potOf(circle);
  const late = await balanceChange(m1.accountId, () => act(m3, daoId, lateVote, "VoteApprove"));
  const lateStatus = await statusOf(daoId, lateVote);
  check("a third yes after expiry does not pass", lateStatus === "Expired", lateStatus);
  check("nothing was paid after the late vote", late.delta === 0n && (await potOf(circle)) === potAtExpiry);

  const finalize = await balanceChange(m2.accountId, () => act(m1, daoId, noVotes, "Finalize"));
  const noVoteStatus = await statusOf(daoId, noVotes);
  check("with no votes, the proposal expires", finalize.result.ok && noVoteStatus === "Expired", noVoteStatus);
  check("the proposer gets the bond back after finalize", finalize.delta === near("0.1"), formatNear(finalize.delta));
  await act(m1, daoId, neverVoted, "Finalize");
  const neverVotedStatus = await statusOf(daoId, neverVoted);
  check("with 2 of 3 yes and silence, the proposal expires", neverVotedStatus === "Expired", neverVotedStatus);
  check("the pot is untouched after all of that", (await potOf(circle)) === 2n * C);

  const round = await balanceChange(m1.accountId, () => pay(m3, circle)); // m1 joined first, so wins round 0.
  check("expired requests do not block the round: winner gets the full pot", round.delta === 3n * C, formatNear(round.delta));
}

// ---------------------------------------------------------------------------------------------
async function payout() {
  heading("Failed payout: the winner's account no longer exists");
  const parent = await ensureDeployer();
  const goneId = `gone-${runId}.${parent.accountId}`;
  const goneKey = KeyPair.fromRandom("ed25519");
  await parent.createSubAccount({ accountOrPrefix: `gone-${runId}`, publicKey: goneKey.getPublicKey(), nearToTransfer: near("0.5") });
  const gone = new Account(goneId, provider, goneKey.toString());
  const circle = await deployCircle("payout", loadDeployment().daoId, C, [goneId, m2.accountId]);
  await call(gone, circle, "join", {});
  await call(m2, circle, "join", {});
  await pay(gone, circle);
  await gone.deleteAccount(parent.accountId);
  await pay(m2, circle);
  await settle();
  const state = await circleOf(circle);
  const owed = BigInt(await view(circle, "get_unclaimed", { account_id: goneId }));
  check("the round still moves on", state.round === 1 && BigInt(state.pot) === 0n);
  check("the money is recorded as owed to the winner", owed === 2n * C, formatNear(owed));
  await expectRejected("nobody else can claim it", "ERR_NOTHING_TO_CLAIM", () => call(m2, circle, "claim", {}));

  const backKey = KeyPair.fromRandom("ed25519");
  await parent.createSubAccount({ accountOrPrefix: `gone-${runId}`, publicKey: backKey.getPublicKey(), nearToTransfer: near("0.5") });
  const back = new Account(goneId, provider, backKey.toString());
  const claimed = await balanceChange(goneId, () => call(back, circle, "claim", {}));
  const stillOwed = BigInt(await view(circle, "get_unclaimed", { account_id: goneId }));
  check("the winner recovers it with claim, less gas", claimed.result.ok && isLessGas(claimed.delta, 2n * C), formatNear(claimed.delta));
  check("nothing is owed afterwards", stillOwed === 0n);
  await expectRejected("it cannot be claimed twice", "ERR_NOTHING_TO_CLAIM", () => call(back, circle, "claim", {}));
  await back.deleteAccount(parent.accountId); // Its key is not saved, so return the money now.
}

// ---------------------------------------------------------------------------------------------
async function late() {
  heading("Deadline: a past winner stops paying");
  const circle = await deployCircle("late", loadDeployment().daoId, C, memberIds, 90);
  await joinAll(circle);
  await expectRejected("reclaim is refused while the round is open", "ERR_NOT_CLOSED", () => reclaim(m1, circle));
  await pay(m1, circle);
  await pay(m2, circle);
  const round0 = await balanceChange(m1.accountId, () => pay(m3, circle));
  let state = await circleOf(circle);
  check("m1 wins round 0 before the deadline", round0.delta === 3n * C && state.round === 1, formatNear(round0.delta));
  check("m2 pays round 1", (await pay(m2, circle)).ok);
  check("m3 pays round 1", (await pay(m3, circle)).ok);
  state = await circleOf(circle);
  check("round 1 is open, waiting on m1", state.phase === "Active" && BigInt(state.pot) === 2n * C, state.phase);
  await expectRejected("reclaim is refused before the deadline", "ERR_NOT_CLOSED", () => reclaim(m2, circle));

  await waitForRoundDeadline(circle);
  state = await circleOf(circle);
  check("the missed deadline closes the circle", state.phase === "Closed" && state.round === 1, state.phase);
  const refund = await balanceChange(m1.accountId, () =>
    expectRejected("a payment after the deadline is rejected", "ERR_NOT_ACTIVE", () => pay(m1, circle)));
  check("the late payment was refunded, only gas was spent", -refund.delta < GAS_ALLOWANCE, formatNear(-refund.delta));
  await expectRejected("the member who did not pay gets nothing back", "ERR_NOTHING_TO_RECLAIM", () => reclaim(m1, circle));
  await expectRejected("a non-member gets nothing back", "ERR_NOTHING_TO_RECLAIM", () => reclaim(outsider, circle));

  const m2Back = await balanceChange(m2.accountId, () => reclaim(m2, circle));
  console.log(`m2's reclaim: ${txUrl(m2Back.result.hash)}`);
  check("m2 gets the round 1 contribution back, less gas", m2Back.result.ok && isLessGas(m2Back.delta, C), formatNear(m2Back.delta));
  check("the pot drops by exactly one contribution", (await potOf(circle)) === C);
  await expectRejected("m2 cannot reclaim twice", "ERR_NOTHING_TO_RECLAIM", () => reclaim(m2, circle));
  const m3Back = await balanceChange(m3.accountId, () => reclaim(m3, circle));
  state = await circleOf(circle);
  check("m3 gets the round 1 contribution back, less gas", m3Back.result.ok && isLessGas(m3Back.delta, C), formatNear(m3Back.delta));
  check("the pot is empty and the circle stays closed", BigInt(state.pot) === 0n && state.phase === "Closed" && state.paid_this_round.length === 0);
  const m3Owed = BigInt(await view(circle, "get_unclaimed", { account_id: m3.accountId }));
  check(
    "known limit: m3's round 0 contribution is not recovered from m1",
    m3Owed === 0n && state.debts.length === 0,
    `m1 is up ${formatNear(2n * C)}, m3 is down ${formatNear(C)}`,
  );
}

// ---------------------------------------------------------------------------------------------
async function window() {
  heading("Deadline: an early withdrawal came out of the same round's pot");
  const daoId = loadDeployment().daoId;
  const circle = await deployCircle("window", daoId, C, memberIds, 150);
  await joinAll(circle);
  await pay(m1, circle);
  await pay(m2, circle);
  const onTime = await propose(m1, daoId, circle, m2.accountId, AMOUNT, 0, "Approved before the deadline");
  await approveAll(daoId, onTime);
  const onTimeStatus = await statusOf(daoId, onTime);
  check("a withdrawal approved before the deadline pays", onTimeStatus === "Approved" && (await potOf(circle)) === 2n * C - AMOUNT, onTimeStatus);
  const tooLate = await propose(m1, daoId, circle, m2.accountId, near("0.01"), 0, "Last vote comes after the deadline");
  await act(m1, daoId, tooLate, "VoteApprove");
  await act(m2, daoId, tooLate, "VoteApprove");
  const open = await circleOf(circle);
  check("the round was still open during the votes", open.phase === "Active", open.phase);

  await waitForRoundDeadline(circle);
  heading("An approval that lands after the deadline");
  const potAtClose = await potOf(circle);
  const bondBack = await balanceChange(m1.accountId, () => act(m3, daoId, tooLate, "VoteApprove"));
  console.log(`too-late vote: ${txUrl(bondBack.result.hash)}`);
  const tooLateStatus = await statusOf(daoId, tooLate);
  check("the proposer gets the 0.1 NEAR bond back", bondBack.delta === near("0.1"), formatNear(bondBack.delta));
  check("the call pays nothing: the pot is unchanged", (await potOf(circle)) === potAtClose);
  check("the DAO records it as Approved, because the call succeeded", tooLateStatus === "Approved", tooLateStatus);

  heading("Reclaim: nobody comes out ahead");
  const m1Back = await balanceChange(m1.accountId, () => reclaim(m1, circle));
  check("m1, who took nothing, gets a full contribution back, less gas", m1Back.result.ok && isLessGas(m1Back.delta, C), formatNear(m1Back.delta));
  check("the pot drops by exactly one contribution", (await potOf(circle)) === potAtClose - C);
  await expectRejected("m3 did not pay, so gets nothing", "ERR_NOTHING_TO_RECLAIM", () => reclaim(m3, circle));
  const m2Back = await balanceChange(m2.accountId, () => reclaim(m2, circle));
  console.log(`m2's reduced reclaim: ${txUrl(m2Back.result.hash)}`);
  check("m2's reclaim is reduced by what m2 already withdrew, less gas", m2Back.result.ok && isLessGas(m2Back.delta, C - AMOUNT), formatNear(m2Back.delta));
  check("no money is left behind", (await potOf(circle)) === 0n);
}

// ---------------------------------------------------------------------------------------------
async function debt() {
  heading("Deadline: a withdrawal from an earlier round is still owed");
  const daoId = loadDeployment().daoId;
  const circle = await deployCircle("debt", daoId, C, memberIds, 120);
  await joinAll(circle);
  await pay(m1, circle);
  await pay(m3, circle);
  const proposal = await propose(m1, daoId, circle, m3.accountId, AMOUNT, 0, "m3 asks for 0.05 in m1's round");
  await approveAll(daoId, proposal);
  const round0 = await balanceChange(m1.accountId, () => pay(m2, circle));
  let state = await circleOf(circle);
  check("m1 wins round 0, short by m3's withdrawal", round0.delta === 3n * C - AMOUNT && state.round === 1, formatNear(round0.delta));
  check("m3 owes m1", state.debts[0]?.debtor === m3.accountId && state.debts[0]?.creditor === m1.accountId && BigInt(state.debts[0]?.amount) === AMOUNT);
  check("m2 pays round 1", (await pay(m2, circle)).ok);
  check("m3 pays round 1", (await pay(m3, circle)).ok);

  await waitForRoundDeadline(circle);
  check("m1 misses the deadline and the circle closes", (await circleOf(circle)).phase === "Closed");
  await settle();
  const m1Before = await balanceOf(m1.accountId);
  const m3Back = await balanceChange(m3.accountId, () => reclaim(m3, circle));
  const m1Repaid = (await balanceOf(m1.accountId)) - m1Before;
  check("m3's reclaim pays the debt first, less gas", m3Back.result.ok && isLessGas(m3Back.delta, C - AMOUNT), formatNear(m3Back.delta));
  check("m1 is repaid exactly the amount", m1Repaid === AMOUNT, formatNear(m1Repaid));
  const m2Back = await balanceChange(m2.accountId, () => reclaim(m2, circle));
  check("m2 is unaffected: a full contribution back, less gas", m2Back.result.ok && isLessGas(m2Back.delta, C), formatNear(m2Back.delta));
  state = await circleOf(circle);
  check("no debts and no money are left", state.debts.length === 0 && BigInt(state.pot) === 0n);
}

// ---------------------------------------------------------------------------------------------
async function idle() {
  heading("Deadline: nobody pays");
  const circle = await deployCircle("idle", loadDeployment().daoId, C, [m1.accountId, m2.accountId], 20);
  await joinAll(circle, [m1, m2]);
  await waitForRoundDeadline(circle);
  check("the circle closes", (await circleOf(circle)).phase === "Closed");
  await expectRejected("no payments are accepted", "ERR_NOT_ACTIVE", () => pay(m1, circle));
  await expectRejected("nothing can be reclaimed", "ERR_NOTHING_TO_RECLAIM", () => reclaim(m1, circle));
}

// ---------------------------------------------------------------------------------------------
const SCENARIOS = { rules, main, silence, payout, late, window, debt, idle };

heading("Setup: the step 1 DAO must match the circle");
const policy = await view(loadDeployment().daoId, "get_policy");
check("DAO group is exactly the 3 circle members", sameSet(policy.roles[0].kind.Group, memberIds));
check("function call proposals need 100% of members", isAllMembers(policy.roles[0].vote_policy.call ?? policy.default_vote_policy));

for (const name of names) await SCENARIOS[name]();

writeJson(RESULT_FILE, { runId, scenarios: names, circles, checks: results });
console.log(`\n${results.length - failed}/${results.length} checks passed (${names.join(", ")})`);
for (const [name, id] of Object.entries(circles)) console.log(`${name}: ${id}`);
if (failed > 0) process.exit(1);
