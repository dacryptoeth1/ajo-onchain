// Works out the schedule, the headline numbers and the notifications from a circle's state.
// `events` is null when the history service is unavailable, and nothing here guesses in that case.
import { totals } from "./history.js";
import { withdrawalOutcome } from "./outcome.js";

const deadlineMs = (circle) => (circle.round_deadline_ns ? Number(BigInt(circle.round_deadline_ns) / 1_000_000n) : null);
const owedBy = (circle, account) => circle.debts
  .filter((debt) => debt.debtor === account)
  .reduce((sum, debt) => sum + BigInt(debt.amount), 0n);

/** One row per payout position, in rotation order. Deadlines follow the contract's fixed schedule. */
export function buildSchedule(circle, events) {
  const contribution = BigInt(circle.contribution);
  const fullPot = contribution * BigInt(circle.invited.length);
  const firstDeadline = deadlineMs(circle);
  const roundMs = circle.round_duration_sec * 1000;

  const rows = circle.members.map((account, position) => {
    const payout = events?.find((event) => event.kind === "payout" && event.round === position);
    const row = { account, position };
    if (position < circle.round) {
      return { ...row, status: "paid", timeMs: payout?.timeMs, amount: payout?.amount, hash: payout?.hash, transferFailed: payout?.transferFailed };
    }
    if (circle.phase === "Closed") return { ...row, status: "cancelled" };
    if (circle.phase === "Joining") return { ...row, status: "waiting" };
    const taken = position === circle.round
      ? circle.withdrawn_this_round.reduce((sum, [, amount]) => sum + BigInt(amount), 0n)
      : 0n;
    return {
      ...row,
      status: position === circle.round ? "current" : "upcoming",
      latestMs: firstDeadline + (position - circle.round) * roundMs,
      expected: fullPot - taken - owedBy(circle, account),
    };
  });
  const waiting = circle.invited.filter((account) => !circle.members.includes(account));
  return { rows, waiting };
}

export function summarize(circle, events) {
  const money = events ? totals(events) : null;
  const schedule = buildSchedule(circle, events);
  const next = schedule.rows.find((row) => row.status === "current") ?? null;
  return {
    members: circle.members.length,
    invited: circle.invited.length,
    completedRounds: circle.round,
    totalRounds: circle.invited.length,
    contributed: money?.contributed ?? null,
    paidOut: money?.paidOut ?? null,
    // Money in minus money out must equal the contract's pot. If not, the history is still catching up.
    historyCurrent: money ? money.contributed - money.paidOut === BigInt(circle.pot) : null,
    next,
  };
}

/** Actions needed come first, then what already happened, newest first. */
export function buildNotifications(circle, events, proposals, proposalLogs, memberCount) {
  const action = [];
  const done = [];
  const deadline = deadlineMs(circle);

  if (circle.phase === "Joining") {
    for (const account of circle.invited.filter((item) => !circle.members.includes(item))) {
      action.push({ kind: "upcoming", title: "Waiting to join", account });
    }
  }
  if (circle.phase === "Active") {
    for (const account of circle.members.filter((item) => !circle.paid_this_round.includes(item))) {
      action.push({ kind: "upcoming", title: `Contribution due for round ${circle.round + 1}`, account, dueMs: deadline });
    }
  }
  if (circle.phase === "Closed") {
    action.push({ kind: "warning", title: `Round ${circle.round + 1} missed its deadline`, detail: "The circle has closed." });
    for (const account of circle.paid_this_round) action.push({ kind: "upcoming", title: "Can reclaim this round's money", account });
  }

  for (const proposal of proposals) {
    const recipient = proposal.request.recipient;
    if (proposal.status === "InProgress") {
      const yes = Object.values(proposal.votes).filter((vote) => vote === "Approve").length;
      action.push({ kind: "approval", title: `Early withdrawal #${proposal.id} needs approval`, detail: `${yes} of ${memberCount} approved`, account: recipient });
    } else {
      const outcome = withdrawalOutcome(proposal.status, proposalLogs?.get(proposal.id) ?? null);
      done.push({ kind: "approval", title: `Early withdrawal #${proposal.id}`, detail: outcome.text, account: recipient, outcome: outcome.key });
    }
  }

  for (const event of events ?? []) {
    if (event.kind === "contribution") {
      done.push({ kind: "payment", title: `Paid round ${event.round + 1}`, account: event.account, amount: event.amount, timeMs: event.timeMs, hash: event.hash });
    } else if (event.kind === "payout") {
      done.push({ kind: "payout", title: `Won round ${event.round + 1}`, account: event.account, amount: event.amount, timeMs: event.timeMs, hash: event.hash });
    } else if (event.kind === "repayment") {
      done.push({ kind: "payout", title: "Early withdrawal repaid", account: event.account, amount: event.amount, timeMs: event.timeMs, hash: event.hash });
    } else if (event.kind === "reclaim") {
      done.push({ kind: "payout", title: "Reclaimed", account: event.account, amount: event.amount, timeMs: event.timeMs, hash: event.hash });
    }
  }
  done.sort((a, b) => (b.timeMs ?? Infinity) - (a.timeMs ?? Infinity));
  return [...action, ...done];
}
