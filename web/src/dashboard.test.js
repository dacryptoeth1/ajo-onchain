// Run with: npm test. The fixtures are trimmed copies of real testnet transactions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildHistory, normalizeTransaction, totals } from "./history.js";
import { withdrawalOutcome } from "./outcome.js";
import { buildNotifications, buildSchedule, summarize } from "./schedule.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const NEAR = 10n ** 24n;
const near = (tenths100) => (BigInt(tenths100) * NEAR) / 100n; // near(25) is 0.25 NEAR.

const finished = fixture("finished-circle");
const closed = fixture("closed-circle");
const historyOf = (data) => buildHistory(data.transactions.map(normalizeTransaction), data.circleId);
const finishedHistory = historyOf(finished);
const closedHistory = historyOf(closed);
const ofKind = (events, kind) => events.filter((event) => event.kind === kind);
const [m1, m2, m3] = finished.circle.members;

test("a finished circle: 9 contributions of 0.1 NEAR", () => {
  const contributions = ofKind(finishedHistory.events, "contribution");
  assert.equal(contributions.length, 9);
  assert.ok(contributions.every((event) => event.amount === near(10)));
  for (const round of [0, 1, 2]) assert.equal(contributions.filter((event) => event.round === round).length, 3);
});

test("payouts show what each winner actually received, after debts", () => {
  const payouts = ofKind(finishedHistory.events, "payout").sort((a, b) => a.round - b.round);
  assert.deepEqual(payouts.map((event) => event.account), [m1, m2, m3]);
  assert.deepEqual(payouts.map((event) => event.amount), [near(25), near(30), near(25)]);
});

test("the early withdrawal and its repayment are both recorded", () => {
  const [withdrawal] = ofKind(finishedHistory.events, "withdrawal");
  assert.equal(withdrawal.account, m3);
  assert.equal(withdrawal.amount, near(5));
  const [repayment] = ofKind(finishedHistory.events, "repayment");
  assert.equal(repayment.account, m1);
  assert.equal(repayment.debtor, m3);
  assert.equal(repayment.amount, near(5));
});

test("every NEAR paid in is accounted for", () => {
  const { contributed, paidOut } = totals(finishedHistory.events);
  assert.equal(contributed, near(90));
  assert.equal(paidOut, near(90));
  assert.equal(contributed - paidOut, BigInt(finished.circle.pot));
});

test("joins and creation are recorded, and carry no money", () => {
  assert.equal(ofKind(finishedHistory.events, "join").length, 3);
  assert.equal(ofKind(finishedHistory.events, "created").length, 1);
  assert.ok(ofKind(finishedHistory.events, "join").every((event) => event.amount === undefined));
});

test("events are newest first", () => {
  const times = finishedHistory.events.map((event) => event.timeMs);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test("a too-late approval is recorded with no money moved", () => {
  const [refused] = ofKind(closedHistory.events, "withdrawal-refused");
  assert.equal(refused.requested, near(1));
  assert.equal(refused.amount, undefined);
  assert.equal(ofKind(closedHistory.events, "withdrawal").length, 0);
});

test("a too-late approval shows its real outcome in a browser that never saw it", () => {
  const proposal = closed.proposals[0];
  assert.equal(proposal.status, "Approved");
  const outcome = withdrawalOutcome(proposal.status, closedHistory.proposalLogs.get(proposal.id));
  assert.equal(outcome.key, "too-late");
});

test("an on-time approval shows as paid in a browser that never saw it", () => {
  const proposal = finished.proposals[0];
  const outcome = withdrawalOutcome(proposal.status, finishedHistory.proposalLogs.get(proposal.id));
  assert.equal(outcome.key, "paid");
});

test("a closed circle: reclaims return what was paid in", () => {
  const { contributed, paidOut } = totals(closedHistory.events);
  assert.equal(contributed, near(20));
  assert.equal(paidOut, near(20));
  assert.equal(ofKind(closedHistory.events, "reclaim").length, 2);
  assert.equal(ofKind(closedHistory.events, "payout").length, 0);
});

test("a failed payment is listed but never counted", () => {
  const { circleId } = closed;
  const failed = {
    hash: "x", timeMs: 1, signer: "a.testnet", receiver: circleId,
    calls: [{ method_name: "contribute", deposit: String(near(10)) }],
    receipts: [{ executor: circleId, logs: [], failed: true }],
  };
  const { events } = buildHistory([failed], circleId);
  assert.equal(events[0].kind, "failed");
  assert.equal(totals(events).contributed, 0n);
});

test("a failed vote is listed but moves nothing", () => {
  const { circleId } = closed;
  const failed = {
    hash: "x", timeMs: 1, signer: "a.testnet", receiver: "dao.testnet",
    calls: [{ method_name: "act_proposal", args: btoa(JSON.stringify({ id: 7 })) }],
    receipts: [{ executor: circleId, logs: [], failed: true }],
  };
  const { events, proposalLogs } = buildHistory([failed], circleId);
  assert.equal(events[0].kind, "withdrawal-failed");
  assert.equal(totals(events).paidOut, 0n);
  assert.equal(withdrawalOutcome("Failed", proposalLogs.get(7)).key, "failed");
});

test("a payout whose transfer failed is flagged", () => {
  const { circleId } = closed;
  const tx = {
    hash: "x", timeMs: 1, signer: "a.testnet", receiver: circleId,
    calls: [{ method_name: "contribute", deposit: String(near(10)) }],
    receipts: [{
      executor: circleId,
      logs: [`round_paid round=0 winner=b.testnet amount=${near(20)}`, `transfer_failed recipient=b.testnet amount=${near(20)}`],
      failed: false,
    }],
  };
  assert.equal(buildHistory([tx], circleId).events.find((event) => event.kind === "payout").transferFailed, true);
});

test("schedule of a finished circle uses actual payouts", () => {
  const { rows } = buildSchedule(finished.circle, finishedHistory.events);
  assert.ok(rows.every((row) => row.status === "paid" && row.hash && row.timeMs));
  assert.deepEqual(rows.map((row) => row.amount), [near(25), near(30), near(25)]);
});

test("schedule of a closed circle cancels every unpaid position", () => {
  const { rows } = buildSchedule(closed.circle, closedHistory.events);
  assert.ok(rows.every((row) => row.status === "cancelled"));
});

const active = {
  phase: "Active", contribution: String(near(10)), round_duration_sec: 100,
  invited: ["a", "b", "c"], members: ["a", "b", "c"], round: 1, round_deadline_ns: "5000000000000",
  winner: "b", paid_this_round: ["c"], withdrawn_this_round: [["c", String(near(5))]],
  debts: [{ debtor: "c", creditor: "a", amount: String(near(5)) }], pot: String(near(5)),
};

test("schedule of an active circle follows the contract's fixed deadlines", () => {
  const { rows } = buildSchedule(active, []);
  assert.deepEqual(rows.map((row) => row.status), ["paid", "current", "upcoming"]);
  assert.equal(rows[1].latestMs, 5_000_000);
  assert.equal(rows[2].latestMs, 5_100_000);
});

test("expected payouts take off this round's withdrawals and the winner's own debts", () => {
  const { rows } = buildSchedule(active, []);
  assert.equal(rows[1].expected, near(25));
  assert.equal(rows[2].expected, near(25));
});

test("without history, totals are unknown rather than zero", () => {
  const summary = summarize(active, null);
  assert.equal(summary.contributed, null);
  assert.equal(summary.completedRounds, 1);
  assert.equal(summary.next.account, "b");
});

test("totals are flagged while the history lags behind the contract", () => {
  const lagging = { ...finished.circle, pot: String(near(20)), round: 1 };
  assert.equal(summarize(lagging, finishedHistory.events).historyCurrent, false);
  assert.equal(summarize(finished.circle, finishedHistory.events).historyCurrent, true);
  assert.equal(summarize(closed.circle, closedHistory.events).historyCurrent, true);
  assert.equal(summarize(active, null).historyCurrent, null);
});

test("notifications put what needs doing first, and name who must pay", () => {
  const items = buildNotifications(active, [], [], new Map(), 3);
  assert.deepEqual(items.map((item) => item.account), ["a", "b"]);
  assert.ok(items.every((item) => item.kind === "upcoming" && item.dueMs === 5_000_000));
});

test("notifications never report a too-late approval as a payment", () => {
  const items = buildNotifications(closed.circle, closedHistory.events, closed.proposals, closedHistory.proposalLogs, 3);
  const approval = items.find((item) => item.kind === "approval");
  assert.equal(approval.outcome, "too-late");
  assert.match(approval.detail, /No money moved/);
});
