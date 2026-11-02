// Turns data into HTML. Nothing here reads the chain, and every value from it is escaped.
import { formatNear, txUrl } from "./chain.js";
import { withdrawalOutcome } from "./outcome.js";
import { buildNotifications, buildSchedule, summarize } from "./schedule.js";

export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const name = (account) => `<span class="account" title="${escapeHtml(account)}">${escapeHtml(String(account).replace(/\.testnet$/, ""))}</span>`;
const txLink = (hash, text = "View") => (hash
  ? `<a class="tx-link" href="${txUrl(hash)}" target="_blank" rel="noopener">${text}<span class="visually-hidden"> on NEAR Rocks, opens in a new tab</span></a>`
  : "");
const pill = (text, tone = "") => `<span class="pill ${tone}">${escapeHtml(text)}</span>`;
const empty = (text) => `<p class="empty">${escapeHtml(text)}</p>`;
const unavailable = "—";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const formatDate = (ms) => (ms ? DATE_FORMAT.format(new Date(ms)) : "");

export const PHASES = {
  Joining: { label: "Waiting for members", tone: "amber" },
  Active: { label: "Active", tone: "green" },
  Finished: { label: "Finished", tone: "blue" },
  Closed: { label: "Closed: missed deadline", tone: "red" },
};
const phasePill = (phase) => pill(PHASES[phase]?.label ?? phase, PHASES[phase]?.tone);

export function circleList(known, selectedId) {
  return known.map(({ id, circle, pinned }) => `
    <button class="circle-chip${id === selectedId ? " selected" : ""}" data-circle="${escapeHtml(id)}" ${id === selectedId ? 'aria-current="true"' : ""}>
      <span class="circle-chip-name" title="${escapeHtml(id)}">${escapeHtml(id.split(".")[0])}</span>
      <span class="circle-chip-meta">${circle ? phasePill(circle.phase) : pill("Loading")}${pinned ? '<span class="chip-note">Sample</span>' : ""}</span>
    </button>`).join("");
}

export function statCards(circle, events, activeCount) {
  const stat = (label, value, note = "") => `
    <div class="stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-note">${note}</div>
    </div>`;
  const summary = circle ? summarize(circle, events) : null;
  const next = summary?.next;
  const nextNote = !circle ? ""
    : next ? `${formatNear(next.expected)} by ${formatDate(next.latestMs)}`
      : { Joining: "Starts when everyone has joined", Finished: "All rounds paid", Closed: "Cancelled by the missed deadline" }[circle.phase] ?? "";
  return [
    stat("Active circles", activeCount, "Known to this browser"),
    stat("Total contributions", summary?.contributed != null ? formatNear(summary.contributed) : unavailable, !summary || summary.historyCurrent === null ? "History unavailable" : summary.historyCurrent ? `${formatNear(summary.paidOut)} paid out` : "Updating: history is catching up"),
    stat("Members", summary ? `${summary.members} of ${summary.invited}` : unavailable, circle ? `${formatNear(circle.contribution)} per round` : ""),
    stat("Next payout", next ? name(next.account) : "None", nextNote),
    stat("Completed rounds", summary ? `${summary.completedRounds} of ${summary.totalRounds}` : unavailable, circle ? `Pot now: ${formatNear(circle.pot)}` : ""),
  ].join("");
}

export function circleHead(circle, circleId) {
  const notes = { Closed: circle.paid_this_round.length ? "Members who paid this round can reclaim their money." : "Everything paid in this round has been reclaimed.", Joining: "The first deadline starts once everyone has joined.", Finished: "Every member has had a turn." };
  return `
    <div class="circle-head-main">
      <h2 class="circle-title">${escapeHtml(circleId)}</h2>
      <div class="circle-head-meta">${phasePill(circle.phase)}
        ${circle.phase === "Active" ? `<span class="muted">Round ${circle.round + 1} of ${circle.invited.length}</span>` : ""}
        ${notes[circle.phase] ? `<span class="muted">${notes[circle.phase]}</span>` : ""}
      </div>
    </div>
    <div class="circle-head-side">
      <div class="big-number-label">Deadline</div>
      <div class="big-number" id="countdown"></div>
    </div>`;
}

export function scheduleView(circle, events) {
  const { rows, waiting } = buildSchedule(circle, events);
  const detail = (row) => {
    switch (row.status) {
      case "paid":
        return `<div class="row-title">${row.amount !== undefined ? `${formatNear(row.amount)} received` : "Paid out"}</div>
          <div class="row-note">${row.transferFailed ? "Transfer failed, so it can be collected with claim." : row.timeMs ? formatDate(row.timeMs) : "Details appear when the history catches up."}</div>`;
      case "current":
      case "upcoming":
        return `<div class="row-title">About ${formatNear(row.expected)}</div>
          <div class="row-note">By ${formatDate(row.latestMs)}, or sooner if everyone pays early</div>`;
      case "cancelled":
        return '<div class="row-title">Will not be paid</div><div class="row-note">The circle closed before this turn.</div>';
      default:
        return '<div class="row-title">Not scheduled yet</div><div class="row-note">Dates start when everyone has joined.</div>';
    }
  };
  const labels = { paid: ["Paid", "green"], current: ["Up next", "amber"], upcoming: ["Upcoming", ""], cancelled: ["Cancelled", "red"], waiting: ["Waiting", ""] };
  const items = rows.map((row) => `
    <li class="timeline-item ${row.status}">
      <span class="timeline-dot" aria-hidden="true"></span>
      <div class="row-main"><div class="row-title">${row.position + 1}. ${name(row.account)}</div>${pill(...labels[row.status])}</div>
      <div class="row-detail">${detail(row)}</div>
      <div class="row-link">${txLink(row.hash)}</div>
    </li>`).join("");
  const open = waiting.length ? `<p class="muted small">${waiting.length} place${waiting.length > 1 ? "s" : ""} still open. Join order sets the rotation.</p>` : "";
  return `<ol class="timeline">${items}</ol>${open}${rows.length || waiting.length ? "" : empty("No members yet.")}`;
}

export function membersView(circle, events, proposals) {
  const paid = new Set(circle.paid_this_round);
  const contributedBy = (account) => (events ? events.filter((event) => event.kind === "contribution" && event.account === account).length : null);
  const statusOf = (account, position) => {
    if (circle.phase === "Finished") return pill("All rounds paid", "green");
    if (circle.phase === "Closed") return paid.has(account) ? pill("Can reclaim", "amber") : pill("Nothing to reclaim");
    return paid.has(account) ? pill("Paid this round", "green") : pill(position === undefined ? "Not joined" : "Not paid", "amber");
  };
  const row = (account, position) => {
    const owes = circle.debts.filter((debt) => debt.debtor === account);
    const owed = circle.debts.filter((debt) => debt.creditor === account);
    const count = contributedBy(account);
    const pending = proposals.filter((item) => item.status === "InProgress" && !item.votes[account]).length;
    const notes = [
      count !== null && position !== undefined ? `${count} payment${count === 1 ? "" : "s"} made` : "",
      ...owes.map((debt) => `Owes ${formatNear(debt.amount)}`),
      ...owed.map((debt) => `Is owed ${formatNear(debt.amount)}`),
      pending ? `${pending} approval${pending === 1 ? "" : "s"} to give` : "",
    ].filter(Boolean);
    const place = position === undefined ? "Invited"
      : position < circle.round ? `Position ${position + 1}, already paid`
        : position === circle.round && circle.phase === "Active" ? `Position ${position + 1}, wins this round`
          : `Position ${position + 1}`;
    return `<li class="member-row">
      <div><div class="row-title">${name(account)}</div><div class="row-note">${place}</div></div>
      <div class="member-status">${statusOf(account, position)}<div class="row-note">${notes.join(" · ")}</div></div>
    </li>`;
  };
  const waiting = circle.invited.filter((account) => !circle.members.includes(account));
  return `<ul class="member-list">${circle.members.map((account, position) => row(account, position)).join("")}${waiting.map((account) => row(account)).join("")}</ul>`;
}

/** `logsOf` gives the circle's log lines for a proposal, or null when they cannot be read. */
export function approvalsView(circle, proposals, memberCount, logsOf, voteControl) {
  if (proposals.length === 0) return empty("No early withdrawals requested for this circle.");
  return proposals.map((item) => {
    const outcome = withdrawalOutcome(item.status, logsOf(item.id));
    const yes = Object.values(item.votes).filter((vote) => vote === "Approve").length;
    const tones = { paid: "green", "too-late": "red", failed: "red", expired: "red", open: "amber", unknown: "amber" };
    const width = memberCount ? Math.round((yes / memberCount) * 100) : 0;
    return `<div class="proposal" data-outcome="${outcome.key}">
      <div class="proposal-head">
        <div class="row-title">#${item.id}: ${formatNear(item.request.amount)} to ${name(item.request.recipient)}</div>
        ${pill(`DAO status: ${item.status}`)}
      </div>
      <div class="meter" role="img" aria-label="${yes} of ${memberCount} approved"><div class="meter-fill" style="width:${width}%"></div></div>
      <div class="row-note">${yes} of ${memberCount} approved · round ${item.request.round + 1}</div>
      <div class="outcome tone-${tones[outcome.key] ?? "muted"}"><span class="outcome-label">What really happened</span> ${escapeHtml(outcome.text)}</div>
      ${voteControl(item)}
    </div>`;
  }).join("");
}

const EVENT_TEXT = {
  contribution: (e) => [`Paid round ${e.round + 1}`, "Contribution", "green"],
  payout: (e) => [`Won round ${e.round + 1}`, "Payout", "blue"],
  repayment: (e) => [`Repaid by ${escapeHtml(String(e.debtor).replace(/\.testnet$/, ""))}`, "Repayment", "blue"],
  withdrawal: (e) => [`Early withdrawal, round ${e.round + 1}`, "Withdrawal", "amber"],
  "withdrawal-refused": (e) => [`Approval for ${formatNear(e.requested)} came too late. No money moved.`, "Too late", "red"],
  "withdrawal-failed": () => ["The circle refused a withdrawal. No money moved.", "Refused", "red"],
  reclaim: (e) => [`Reclaimed from round ${e.round + 1}`, "Reclaim", "blue"],
  join: () => ["Joined the circle", "Joined", ""],
  created: () => ["Circle deployed", "Created", ""],
  claim: () => ["Collected a failed payout", "Claim", "blue"],
  failed: (e) => [`A ${escapeHtml(e.method ?? "call")} call failed. No money moved.`, "Failed", "red"],
};
const FILTERS = {
  all: () => true,
  contributions: (e) => e.kind === "contribution",
  payouts: (e) => ["payout", "repayment", "withdrawal", "reclaim", "claim"].includes(e.kind),
};

export function historyFilters(current) {
  return [["all", "All"], ["contributions", "Contributions"], ["payouts", "Payouts"]].map(([key, label]) =>
    `<button class="filter${key === current ? " selected" : ""}" data-filter="${key}" aria-pressed="${key === current}">${label}</button>`).join("");
}

export function historyView(events, filter, sessionTxs) {
  if (events === undefined) return empty("Loading the circle's transactions...");
  if (events === null) {
    const rows = sessionTxs.map((tx) => `<li class="history-row"><div class="row-main"><div class="row-title">${escapeHtml(tx.text)}</div></div><div class="row-link">${txLink(tx.hash)}</div></li>`).join("");
    return `<p class="notice">The history service is unavailable, so totals and past transactions cannot be shown right now.${rows ? " These are the transactions this browser saw." : ""}</p>${rows ? `<ul class="history-list">${rows}</ul>` : ""}`;
  }
  const shown = events.filter(FILTERS[filter]);
  if (shown.length === 0) return empty("Nothing here yet.");
  return `<ul class="history-list">${shown.map((event) => {
    const [text, label, tone] = EVENT_TEXT[event.kind](event);
    return `<li class="history-row">
      <div class="row-main">${pill(label, tone)}<div><div class="row-title">${name(event.account)}</div><div class="row-note">${text}${event.transferFailed ? " Transfer failed, so it can be collected with claim." : ""}</div></div></div>
      <div class="history-side"><div class="row-title amount">${event.amount !== undefined ? formatNear(event.amount) : ""}</div><div class="row-note">${formatDate(event.timeMs)}</div>${txLink(event.hash)}</div>
    </li>`;
  }).join("")}</ul>`;
}

export function notificationsView(circle, events, proposals, proposalLogs, memberCount) {
  const items = buildNotifications(circle, events, proposals, proposalLogs, memberCount).slice(0, 14);
  if (items.length === 0) return empty("Nothing to report for this circle.");
  const icons = { upcoming: "◷", payment: "✓", payout: "↗", approval: "✎", warning: "!" };
  const tone = (item) => (item.outcome === "too-late" || item.outcome === "failed" || item.kind === "warning" ? "red" : item.kind === "upcoming" || item.outcome === "unknown" ? "amber" : item.kind === "approval" && !item.outcome ? "amber" : "green");
  return `<ul class="notification-list">${items.map((item) => `
    <li class="notification">
      <span class="notification-icon tone-${tone(item)}" aria-hidden="true">${icons[item.kind]}</span>
      <div class="notification-body">
        <div class="row-title">${escapeHtml(item.title)}${item.amount !== undefined ? `: ${formatNear(item.amount)}` : ""}</div>
        <div class="row-note">${[item.account ? name(item.account) : "", item.detail ? escapeHtml(item.detail) : "", item.dueMs ? `Due by ${formatDate(item.dueMs)}` : "", item.timeMs ? formatDate(item.timeMs) : ""].filter(Boolean).join(" · ")}</div>
      </div>
      ${txLink(item.hash)}
    </li>`).join("")}</ul>`;
}
