// Files one Transfer proposal and checks it stays unpaid at 2 of 3 votes, then pays at 3 of 3.
// Exits non-zero if any check fails.
import { NEAR } from "near-api-js/tokens";
import { RUN_FILE, balanceOf, call, formatNear, loadAccounts, loadDeployment, near, txUrl, view, writeJson } from "./lib.mjs";

const CONTRIBUTION = near("0.5");
const WITHDRAWAL = near("1");

const { daoId } = loadDeployment();
const { members, outsider } = loadAccounts();
const [m1, m2, m3] = members;
const receiverId = outsider.accountId;
const policy = await view(daoId, "get_policy");
const bond = BigInt(policy.proposal_bond);

const log = [];
let failed = 0;
const check = (label, passed, detail = "") => {
  if (!passed) failed += 1;
  log.push({ label, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};
const heading = (text) => console.log(`\n=== ${text}`);
const snapshot = async (id) => {
  const proposal = await view(daoId, "get_proposal", { id });
  return {
    status: proposal.status,
    approvals: Object.values(proposal.votes).filter((v) => v === "Approve").length,
    kind: proposal.kind,
    pot: BigInt(await view(daoId, "get_available_amount")),
    receiver: await balanceOf(receiverId),
  };
};
const describe = (s) =>
  `status=${s.status}, approvals=${s.approvals}/3, pot=${formatNear(s.pot)}, receiver=${formatNear(s.receiver)}`;
const send = async (account, action, id, kind) => {
  const result = await call(account, daoId, "act_proposal", { id, action, proposal: kind }, { gas: 200n });
  console.log(`${account.accountId} ${action}: ${result.ok ? txUrl(result.hash) : `rejected: ${result.error}`}`);
  return result;
};
const expectRejected = async (label, code, account, action, id, kind) => {
  const result = await send(account, action, id, kind);
  check(label, !result.ok && String(result.error).includes(code), result.ok ? "transaction SUCCEEDED" : code);
};

heading("Members pay in");
const startPot = BigInt(await view(daoId, "get_available_amount"));
for (const member of members) {
  await member.transfer({ token: NEAR, amount: CONTRIBUTION, receiverId: daoId });
  console.log(`${member.accountId} paid ${formatNear(CONTRIBUTION)}`);
}
const fundedPot = BigInt(await view(daoId, "get_available_amount"));
console.log(`Available pot: ${formatNear(startPot)} -> ${formatNear(fundedPot)}`);

heading("m1 files a Transfer proposal");
const created = await call(
  m1,
  daoId,
  "add_proposal",
  {
    proposal: {
      description: "Early withdrawal test",
      kind: { Transfer: { token_id: "", receiver_id: receiverId, amount: WITHDRAWAL.toString() } },
    },
  },
  { deposit: bond },
);
if (!created.ok) throw new Error(`add_proposal failed: ${created.error}`);
const id = created.value;
console.log(`proposal id ${id}: ${txUrl(created.hash)}`);
const initial = await snapshot(id);
console.log(describe(initial));
const kind = initial.kind;

heading("2 of 3 approve");
await send(m1, "VoteApprove", id, kind);
await send(m2, "VoteApprove", id, kind);
const atTwo = await snapshot(id);
console.log(describe(atTwo));
check("status is still InProgress at 2 of 3", atTwo.status === "InProgress", atTwo.status);
check("2 approvals were recorded", atTwo.approvals === 2);
check("receiver was not paid at 2 of 3", atTwo.receiver === initial.receiver);

heading("Attempts to force it through at 2 of 3");
await expectRejected("m1 cannot vote a second time", "ERR_ALREADY_VOTED", m1, "VoteApprove", id, kind);
await expectRejected("a non-member cannot vote", "ERR_PERMISSION_DENIED", outsider, "VoteApprove", id, kind);
await expectRejected("m1 cannot finalize early", "ERR_PROPOSAL_NOT_EXPIRED_OR_FAILED", m1, "Finalize", id, kind);
const afterAttempts = await snapshot(id);
console.log(describe(afterAttempts));
check("status is unchanged after those attempts", afterAttempts.status === "InProgress", afterAttempts.status);
// The receiver is also the non-member voter, so its rejected vote cost it a little gas.
check("receiver is still unpaid after those attempts", afterAttempts.receiver <= atTwo.receiver);

heading("3 of 3 approve");
const proposerBefore = await balanceOf(m1.accountId);
await send(m3, "VoteApprove", id, kind);
const atThree = await snapshot(id);
console.log(describe(atThree));
check("status is Approved at 3 of 3", atThree.status === "Approved", atThree.status);
check(
  "receiver gained exactly the withdrawal amount",
  atThree.receiver - afterAttempts.receiver === WITHDRAWAL,
  formatNear(atThree.receiver - afterAttempts.receiver),
);
const bondBack = (await balanceOf(m1.accountId)) - proposerBefore;
check("proposer got the bond back", bondBack === bond, formatNear(bondBack));

writeJson(RUN_FILE, { daoId, proposalId: id, proposalTx: created.hash, checks: log });
console.log(`\n${log.length - failed}/${log.length} checks passed`);
if (failed > 0) process.exit(1);
