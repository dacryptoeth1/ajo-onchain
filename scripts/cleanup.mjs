// Deletes the test accounts this project holds keys for and sends their balances to your account.
// Shows the plan and changes nothing unless --execute is passed.
//   npm run cleanup -- --to <your-account.testnet>
//   npm run cleanup -- --to <your-account.testnet> --execute
//   npm run cleanup -- --to <your-account.testnet> --deployer <id> --execute   (one deployer only)
//
// Circle contracts and DAOs have no access keys, so their balances cannot be recovered.
import { existsSync, renameSync, rmSync } from "node:fs";
import { Account } from "near-api-js";
import {
  DEPLOYMENT_FILE, KEYS_FILE, SILENCE_DAO_FILE, balanceOf, formatNear, loadDeployers, provider, readJson,
  saveDeployers,
} from "./lib.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const to = option("--to");
const onlyDeployer = option("--deployer");
const execute = process.argv.includes("--execute");

function stop(message) {
  console.error(message);
  process.exit(1);
}
const exists = async (accountId) => {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch (error) {
    if (/does not exist|UNKNOWN_ACCOUNT|doesn't exist/i.test(String(error?.message ?? error))) return false;
    throw error; // An RPC failure must not read as "already deleted".
  }
};

if (!to) stop("Pass the account that receives the balances: npm run cleanup -- --to <your-account.testnet>");
if (!to.endsWith(".testnet")) stop(`${to} is not a testnet account.`);

const stored = readJson(KEYS_FILE);
const people = onlyDeployer || !stored ? [] : [stored.outsider, ...stored.members].filter(Boolean);
const deployers = loadDeployers().filter((d) => !onlyDeployer || d.accountId === onlyDeployer);
if (onlyDeployer && deployers.length === 0) stop(`No saved key for deployer ${onlyDeployer}.`);
const targets = [...people, ...deployers];

// Deleting an account into itself or into another account on the list would lose the money.
if (targets.some((t) => t.accountId === to)) stop(`${to} is on the delete list, so it cannot receive the balances.`);
if (to.endsWith(".testnet") && targets.some((t) => to.endsWith(`.${t.accountId}`))) {
  console.log(`Note: ${to} is a subaccount of an account being deleted. It keeps working on its own.`);
}
if (!(await exists(to))) stop(`${to} does not exist on testnet, so nothing was changed.`);

let total = 0n;
const plan = [];
for (const target of targets) {
  const live = await exists(target.accountId);
  const balance = live ? await balanceOf(target.accountId) : 0n;
  total += balance;
  plan.push({ ...target, live, balance });
  console.log(`${live ? formatNear(balance).padStart(18) : "already gone".padStart(18)}  ${target.accountId}`);
}
console.log(`${formatNear(total).padStart(18)}  total, less gas, would go to ${to}`);
if (people.length > 0) console.log("Deleting the members also retires both DAOs. Run `npm run accounts` and `npm run dao` to start again.");

if (!execute) {
  console.log("\nNothing changed. Add --execute to delete these accounts. This cannot be undone.");
  process.exit(0);
}

const before = await balanceOf(to);
const failures = [];
const isGone = new Set();
for (const target of plan) {
  try {
    if (target.live) await new Account(target.accountId, provider, target.privateKey).deleteAccount(to);
    if (await exists(target.accountId)) throw new Error("account still exists after delete");
    isGone.add(target.accountId);
    // Saved after each delete, so a later failure leaves an accurate key file.
    saveDeployers(loadDeployers().filter((d) => d.accountId !== target.accountId));
    console.log(`deleted ${target.accountId}`);
  } catch (error) {
    failures.push(target.accountId);
    console.error(`FAILED ${target.accountId}: ${error?.message ?? error}`);
  }
}

// The member keys are removed only once every one of those accounts is gone, and the DAOs are
// kept as retired records because their members no longer exist.
if (people.length > 0 && people.every((p) => isGone.has(p.accountId))) {
  rmSync(KEYS_FILE);
  for (const file of [DEPLOYMENT_FILE, SILENCE_DAO_FILE]) {
    if (existsSync(file)) renameSync(file, file.replace(/\.json$/, `.retired-${Date.now()}.json`));
  }
}
if (loadDeployers().length === 0 && !onlyDeployer) rmSync(new URL("../.keys/testnet-deployer.json", import.meta.url), { force: true });

await new Promise((resolve) => setTimeout(resolve, 3000));
const received = (await balanceOf(to)) - before;
console.log(`\n${to} received ${formatNear(received)}`);
if (failures.length > 0) stop(`${failures.length} accounts could not be deleted. Their keys were kept, so you can run this again.`);
