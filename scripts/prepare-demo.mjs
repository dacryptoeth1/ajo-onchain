// Deploys demo circles and writes their public IDs to web/src/demo-config.js. Each run uses two
// circles at 2 NEAR each. Also writes the demo keys to web/.env.local, which is gitignored.
//   npm run demo:prepare -- 5
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { actions } from "near-api-js";
import { CONTRIBUTION, FULL_ROUND_SECONDS, LATE_ROUND_SECONDS } from "../web/src/demo-steps.js";
import { KEYS_FILE, TGAS, ensureDeployer, loadDeployment, near, readJson, view } from "./lib.mjs";
import { randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(ROOT, "contract", "target", "wasm32-unknown-unknown", "release", "ajo_circle.wasm");
const CONFIG_FILE = join(ROOT, "web", "src", "demo-config.js");
const ENV_FILE = join(ROOT, "web", ".env.local");

const count = Number(process.argv[2]);
if (!Number.isInteger(count) || count < 0) {
  console.error("Say how many demo runs to add: npm run demo:prepare -- 5");
  process.exit(1);
}

const { members } = readJson(KEYS_FILE);
const accounts = { m1: members[0].accountId, m2: members[1].accountId, m3: members[2].accountId };
const { daoId } = loadDeployment();
const policy = await view(daoId, "get_policy");
if (policy.roles[0].kind.Group?.slice().sort().join() !== Object.values(accounts).sort().join()) {
  throw new Error(`${daoId} does not have the demo accounts as its members.`);
}

// The page deploys this exact contract when someone creates a circle.
copyFileSync(WASM, join(ROOT, "web", "public", "ajo_circle.wasm"));
writeFileSync(ENV_FILE, members.map((member, index) => `DEMO_KEY_M${index + 1}=${member.privateKey}\n`).join(""), { mode: 0o600 });

const code = readFileSync(WASM);
async function deploy(prefix, roundSeconds) {
  const deployer = await ensureDeployer(near("3"));
  const contractId = `${prefix}-${randomBytes(3).toString("hex")}.${deployer.accountId}`;
  await deployer.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.createAccount(),
      actions.transfer(near("2")),
      actions.deployContract(code),
      actions.functionCall(
        "new",
        { dao_id: daoId, contribution: CONTRIBUTION, round_duration_sec: roundSeconds, invited: Object.values(accounts) },
        100n * TGAS,
        0n,
      ),
    ],
    waitUntil: "FINAL",
  });
  console.log(`deployed ${contractId}`);
  return contractId;
}

const existing = (await import(pathToFileURL(CONFIG_FILE))).default;
const runs = [];
if (existing.daoId === daoId) {
  for (const run of existing.runs) {
    const states = await Promise.all([view(run.full, "get_circle"), view(run.late, "get_circle")]);
    if (states.every((state) => state.members.length === 0)) runs.push(run); // Used runs are dropped.
  }
}
const save = () => writeFileSync(
  CONFIG_FILE,
  `// Written by scripts/prepare-demo.mjs. Public account IDs only, never keys.\nexport default ${JSON.stringify({ daoId, accounts, runs }, null, 2)};\n`,
);
save();
for (let index = 0; index < count; index += 1) {
  runs.push({ full: await deploy("demo-full", FULL_ROUND_SECONDS), late: await deploy("demo-late", LATE_ROUND_SECONDS) });
  save(); // After each run, so a later failure cannot strand a deployed circle.
}
console.log(`${runs.length} demo runs in web/src/demo-config.js`);
