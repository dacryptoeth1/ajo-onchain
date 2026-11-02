// Shared helpers for the testnet scripts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider } from "near-api-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const KEYS_FILE = join(ROOT, ".keys", "testnet-accounts.json");
export const DEPLOYER_FILE = join(ROOT, ".keys", "testnet-deployer.json");
export const DEPLOYMENT_FILE = join(ROOT, "deployments", "testnet.json");
export const SILENCE_DAO_FILE = join(ROOT, "deployments", "silence-dao.json");
export const RUN_FILE = join(ROOT, "deployments", "last-vote-test.json");

export const FACTORY = "sputnikv2.testnet";
export const FAUCET_URL = "https://helper.nearprotocol.com/account";
export const provider = new JsonRpcProvider({
  url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
});

const YOCTO_PER_NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;

/** Parses a decimal NEAR string such as "0.5" into yoctoNEAR without float rounding. */
export function near(amount) {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(24, "0"));
}

export function formatNear(yocto) {
  const value = BigInt(yocto);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const fraction = (abs % YOCTO_PER_NEAR).toString().padStart(24, "0").slice(0, 6);
  return `${sign}${abs / YOCTO_PER_NEAR}.${fraction} NEAR`;
}

export const txUrl = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;

export function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export function writeJson(file, value, options = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function loadAccounts() {
  const stored = readJson(KEYS_FILE);
  if (!stored) throw new Error("No accounts found. Run `npm run accounts` first.");
  const signer = ({ accountId, privateKey }) => new Account(accountId, provider, privateKey);
  return {
    members: stored.members.map(signer),
    outsider: signer(stored.outsider),
  };
}

/** Every deployer with a saved key, newest last. Older files held a single deployer. */
export function loadDeployers() {
  const stored = readJson(DEPLOYER_FILE);
  if (!stored) return [];
  return stored.deployers ?? [stored];
}

export function saveDeployers(deployers) {
  writeJson(DEPLOYER_FILE, { deployers }, { mode: 0o600 });
}

export function loadDeployment() {
  const deployment = readJson(DEPLOYMENT_FILE);
  if (!deployment) throw new Error("No DAO found. Run `npm run dao` first.");
  return deployment;
}

const ALL_MEMBERS = { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] };

/** Members-only DAO policy where every proposal kind needs 100% of members. */
export function buildDaoPolicy(memberIds, proposalPeriodNs) {
  return {
    // Only members can do anything. Sputnik's default "all" role, which lets anyone
    // file proposals, is left out on purpose.
    roles: [
      {
        name: "members",
        kind: { Group: memberIds },
        permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
        vote_policy: { transfer: ALL_MEMBERS },
      },
    ],
    // The default must also be 100%. At 50%, two members could pass a
    // remove_member_from_role or policy proposal and sidestep the transfer rule.
    default_vote_policy: ALL_MEMBERS,
    proposal_bond: near("0.1").toString(),
    proposal_period: proposalPeriodNs,
    bounty_bond: near("0.1").toString(),
    bounty_forgiveness_period: proposalPeriodNs,
  };
}

export const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
export const isAllMembers = (p) =>
  p?.threshold?.[0] === 1 && p?.threshold?.[1] === 1 && p?.weight_kind === "RoleWeight";

export const view = (contractId, method, args = {}) =>
  provider.callFunction({ contractId, method, args });

export const balanceOf = async (accountId) =>
  BigInt((await provider.viewAccount({ accountId })).amount);

/** Lists every failure in a transaction, including failed cross-contract receipts. */
function failuresIn(result) {
  const outcomes = [result.transaction_outcome, ...(result.receipts_outcome ?? [])];
  return outcomes.flatMap((item) => {
    const failure = item?.outcome?.status?.Failure;
    return failure ? [JSON.stringify(failure)] : [];
  });
}

/**
 * Sends a contract call and waits for finality. Returns instead of throwing on a contract
 * failure, so callers must look at `ok`. Network and RPC errors still throw.
 */
export async function call(account, contractId, methodName, args, { gas = 100n, deposit = 0n } = {}) {
  try {
    const result = await account.callFunctionRaw({
      contractId,
      methodName,
      args,
      gas: gas * TGAS,
      deposit,
      waitUntil: "FINAL",
    });
    const failures = failuresIn(result);
    const encoded = result.status?.SuccessValue;
    return {
      ok: failures.length === 0,
      hash: result.transaction?.hash ?? result.transaction_outcome?.id,
      value: encoded ? JSON.parse(Buffer.from(encoded, "base64").toString()) : undefined,
      error: failures.join("; ") || undefined,
    };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/ERR_|panicked|Smart contract/i.test(message)) return { ok: false, error: message };
    throw error;
  }
}
