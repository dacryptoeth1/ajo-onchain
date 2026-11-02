// Creates a 3-member Sputnik DAO where every proposal kind needs 100% of members,
// then reads the policy back from chain and checks it before reporting success.
import { randomBytes } from "node:crypto";
import { DEPLOYMENT_FILE, FACTORY, buildDaoPolicy, call, formatNear, isAllMembers, loadAccounts, near, readJson, sameSet, txUrl, view, writeJson } from "./lib.mjs";

const PROPOSAL_PERIOD_NS = String(72n * 3600n * 1_000_000_000n); // 72 hours
const CREATE_DEPOSIT = near("6"); // Pays for the DAO's contract storage.

const { members } = loadAccounts();
const memberIds = members.map((m) => m.accountId);

const policy = buildDaoPolicy(memberIds, PROPOSAL_PERIOD_NS);

// The name is saved before sending, so a rerun checks this DAO instead of paying for another.
const saved = readJson(DEPLOYMENT_FILE);
const name = saved?.daoId.split(".")[0] ?? `ajo-test-${randomBytes(3).toString("hex")}`;
const daoId = `${name}.${FACTORY}`;

if (saved) {
  console.log(`Found ${daoId} in ${DEPLOYMENT_FILE}, checking it without creating a new one`);
} else {
  writeJson(DEPLOYMENT_FILE, { network: "testnet", factory: FACTORY, daoId, members: memberIds });
  const args = Buffer.from(
    JSON.stringify({
      config: { name: "Ajo test circle", purpose: "Ajo onchain testnet check: 3 of 3 withdrawals", metadata: "" },
      policy,
    }),
  ).toString("base64");

  console.log(`Creating ${daoId} with ${formatNear(CREATE_DEPOSIT)} from ${memberIds[0]}`);
  const result = await call(members[0], FACTORY, "create", { name, args }, { gas: 300n, deposit: CREATE_DEPOSIT });
  if (!result.ok) throw new Error(`DAO creation failed: ${result.error}`);
  console.log(`tx: ${txUrl(result.hash)}`);
  writeJson(DEPLOYMENT_FILE, { ...readJson(DEPLOYMENT_FILE), createTx: result.hash });
}

// The factory return value is empty on testnet, so the DAO state below is the proof of success.
const onChain = await view(daoId, "get_policy");
const role = onChain.roles.find((r) => r.name === "members");
const checks = {
  "exactly one role": onChain.roles.length === 1,
  "group is the 3 members": sameSet(role?.kind?.Group ?? [], memberIds),
  "transfer threshold is 100%": isAllMembers(role?.vote_policy?.transfer),
  "default threshold is 100%": isAllMembers(onChain.default_vote_policy),
  "proposal period is 72h": onChain.proposal_period === PROPOSAL_PERIOD_NS,
};
for (const [label, passed] of Object.entries(checks)) console.log(`${passed ? "PASS" : "FAIL"}  ${label}`);
if (!Object.values(checks).every(Boolean)) process.exit(1);

console.log(`factory info: ${JSON.stringify(await view(daoId, "get_factory_info"))}`);
console.log(`DAO ready: ${daoId}`);
