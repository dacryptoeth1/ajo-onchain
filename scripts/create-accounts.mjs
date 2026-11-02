// Creates three member accounts and one non-member account on testnet.
// Keys are generated locally and stored in .keys/ (gitignored). They are never printed.
import { randomBytes } from "node:crypto";
import { Account, KeyPair } from "near-api-js";
import { FAUCET_URL, KEYS_FILE, balanceOf, formatNear, near, provider, readJson, writeJson } from "./lib.mjs";

if (readJson(KEYS_FILE)) {
  console.log(`Accounts already exist in ${KEYS_FILE}. Delete that file to create a new set.`);
  process.exit(0);
}

const runId = randomBytes(3).toString("hex");
const members = [];
const save = (extra = {}) =>
  writeJson(KEYS_FILE, { network: "testnet", runId, members, ...extra }, { mode: 0o600 });

for (const label of ["m1", "m2", "m3"]) {
  const keyPair = KeyPair.fromRandom("ed25519");
  const accountId = `ajo-${runId}-${label}.testnet`;
  const response = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      newAccountId: accountId,
      newAccountPublicKey: keyPair.getPublicKey().toString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`Faucet refused ${accountId}: ${response.status} ${await response.text()}`);
  }
  // Saved after each account so a later failure cannot strand a funded account.
  members.push({ accountId, privateKey: keyPair.toString() });
  save();
  console.log(`created ${accountId}`);
}

// The non-member is the payout target and the "outsider tries to vote" test account.
const m1 = new Account(members[0].accountId, provider, members[0].privateKey);
const outsiderKey = KeyPair.fromRandom("ed25519");
const outsiderId = `payout.${members[0].accountId}`;
await m1.createSubAccount({
  accountOrPrefix: "payout",
  publicKey: outsiderKey.getPublicKey(),
  nearToTransfer: near("0.5"),
});
save({ outsider: { accountId: outsiderId, privateKey: outsiderKey.toString() } });
console.log(`created ${outsiderId}`);

for (const id of [...members.map((m) => m.accountId), outsiderId]) {
  console.log(`${id}: ${formatNear(await balanceOf(id))}`);
}
