// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { circleLogs, readWithdrawalLogs, withdrawalOutcome } from "./outcome.js";

// Copied from real testnet transactions:
// p2orkWfSbDt88NcrxNXt5ZvwoeeSoPqZqF1GzG57xHq and 5yHvZW9XwhMNTyksAPeDamGAY6cSex289sRrrqX9UeUV
const REFUSED = "early_withdrawal_refused reason=deadline_passed round=0 recipient=ajo-5e550a-m2.testnet amount=10000000000000000000000";
const PAID = "early_withdrawal round=0 recipient=ajo-5e550a-m1.testnet amount=50000000000000000000000";

test("a too-late approval is not reported as paid, even though the status is Approved", () => {
  const outcome = withdrawalOutcome("Approved", [REFUSED]);
  assert.equal(outcome.key, "too-late");
  assert.match(outcome.text, /No money moved/);
});

test("an approval that ran on time is reported as paid", () => {
  assert.equal(withdrawalOutcome("Approved", [PAID]).key, "paid");
});

test("the refused log is not mistaken for the paid log", () => {
  assert.equal(readWithdrawalLogs([REFUSED]), "refused");
  assert.equal(readWithdrawalLogs([PAID]), "paid");
  assert.equal(readWithdrawalLogs(["round_paid round=0 winner=a.testnet amount=1"]), null);
});

test("Approved with no transaction seen is never reported as paid", () => {
  assert.equal(withdrawalOutcome("Approved", null).key, "unknown");
  assert.equal(withdrawalOutcome("Approved", []).key, "unknown");
});

test("other statuses say no money moved", () => {
  for (const status of ["InProgress", "Failed", "Expired", "Rejected", "Removed"]) {
    assert.match(withdrawalOutcome(status, null).text, /No money moved/);
  }
});

test("only the circle's own logs count", () => {
  const transaction = {
    receipts_outcome: [
      { outcome: { executor_id: "fake.testnet", logs: [PAID] } },
      { outcome: { executor_id: "circle.testnet", logs: [REFUSED] } },
    ],
  };
  assert.deepEqual(circleLogs(transaction, "circle.testnet"), [REFUSED]);
});
