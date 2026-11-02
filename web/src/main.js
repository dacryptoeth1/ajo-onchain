import "./styles.css";
import { chainNowMs, failuresIn, fetchTransaction, formatNear, loadWithdrawals, parseNear, txUrl, view } from "./chain.js";
import { buildDaoPolicy } from "./dao-policy.js";
import { STEPS, runDemo } from "./demo-steps.js";
import { buildHistory, fetchCircleTransactions } from "./history.js";
import { circleLogs, readWithdrawalLogs, withdrawalOutcome } from "./outcome.js";
import { approvalsView, circleHead, circleList, escapeHtml, historyFilters, historyView, membersView, notificationsView, scheduleView, statCards } from "./views.js";
import { connectWallet, disconnectWallet, functionCall, sendTransaction, watchWallet } from "./wallet.js";

const $ = (id) => document.getElementById(id);
const FACTORY = "sputnikv2.testnet";
const DAO_DEPOSIT = 6n * 10n ** 24n;
const CIRCLE_FUNDING = 2n * 10n ** 24n;
const PROPOSAL_PERIOD_NS = String(72n * 3600n * 1_000_000_000n);
const PAYOUT_NOTE_MS = 4000;

const REFRESH_MS = 5000;
const HISTORY_RETRY_MS = 8000;
const HISTORY_SETTLE_MS = 24000; // The history service can lag the chain by a few seconds.
const KNOWN_LIMIT = 8;
// Real circles from earlier demo runs, so the first view is not empty: one that finished with an
// early withdrawal repaid, and one that missed its deadline with a too-late approval.
const SAMPLE_CIRCLES = ["demo-full-dec9b2.ajo-c81e59-deployer.testnet", "demo-late-337121.ajo-c81e59-deployer.testnet"];

const app = {
  signer: null, circleId: null, circle: null, policy: null, withdrawals: [], clockOffsetMs: 0, demoRunning: false, readFailed: false,
  // undefined while loading, and null when the history service cannot be reached.
  events: undefined, proposalLogs: null, historySignature: null, historyFreshUntil: 0, historyFetchedAt: 0, historyFilter: "all",
  sessionTxs: [], known: new Map(),
};
const chainNow = () => Date.now() + app.clockOffsetMs;

/** Skips the write when nothing changed, which keeps scroll positions and open controls in place. */
const lastHtml = new Map();
function setHtml(id, html) {
  if (lastHtml.get(id) === html) return false;
  lastHtml.set(id, html);
  $(id).innerHTML = html;
  return true;
}

// --- The circles this browser knows about. The chain has no list of all circles.
function savedCircles() {
  try {
    return JSON.parse(localStorage.getItem("ajo-circles")) ?? [];
  } catch {
    return [];
  }
}
function rememberCircle(circleId) {
  if (SAMPLE_CIRCLES.includes(circleId)) return;
  try {
    const list = [circleId, ...savedCircles().filter((id) => id !== circleId)].slice(0, KNOWN_LIMIT);
    localStorage.setItem("ajo-circles", JSON.stringify(list));
  } catch {
    // Without storage the circle is still listed until the page is reloaded.
  }
}
function renderCircleList() {
  const known = [...app.known.entries()].map(([id, circle]) => ({ id, circle, pinned: SAMPLE_CIRCLES.includes(id) }));
  setHtml("circle-list", circleList(known, app.circleId));
}
async function loadKnownCircles() {
  const ids = [...new Set([...savedCircles(), ...app.known.keys(), ...SAMPLE_CIRCLES])];
  for (const id of ids) if (!app.known.has(id)) app.known.set(id, null);
  renderCircleList();
  await Promise.allSettled(ids.map(async (id) => { app.known.set(id, await view(id, "get_circle")); }));
  renderCircleList();
  renderStats();
}
function renderStats() {
  const active = [...app.known.values()].filter((circle) => circle?.phase === "Active").length;
  setHtml("stats", statCards(app.circle, app.events ?? null, active));
}

function showError(error) {
  const message = error ? String(error.message ?? error) : "";
  $("error").textContent = message;
  $("error").hidden = !message;
}

/** A short note that a round paid out. It works without motion too, and then it just disappears. */
let payoutNoteTimer;
function showPayoutNote(text) {
  const note = $("payout-note");
  clearTimeout(payoutNoteTimer);
  note.textContent = text;
  note.hidden = false;
  note.classList.remove("show");
  void note.offsetWidth; // Restarts the animation when payouts come close together.
  note.classList.add("show");
  payoutNoteTimer = setTimeout(() => { note.hidden = true; }, PAYOUT_NOTE_MS);
}

function setDemoProgress(fraction, running) {
  const bar = $("demo-progress");
  bar.hidden = false;
  bar.classList.toggle("running", running);
  bar.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
  bar.firstElementChild.style.transform = `scaleX(${fraction})`;
}

// --- Which transactions this browser saw for each proposal, so their logs can be read later.
const voteKey = (daoId, id) => `ajo-votes:${daoId}:${id}`;
function savedVotes(daoId, id) {
  try {
    return JSON.parse(localStorage.getItem(voteKey(daoId, id))) ?? [];
  } catch {
    return [];
  }
}
function saveVote(daoId, id, hash, sender) {
  try {
    localStorage.setItem(voteKey(daoId, id), JSON.stringify([...savedVotes(daoId, id), { hash, sender }]));
  } catch {
    // Without storage the outcome shows as not confirmed. It is never guessed.
  }
}
/** The circle's logs from the votes this browser saw, or null if it saw none it can still read. */
async function logsFor(daoId, proposalId, circleId) {
  const votes = savedVotes(daoId, proposalId);
  if (votes.length === 0) return null;
  const settled = await Promise.allSettled(votes.map((vote) => fetchTransaction(vote.hash, vote.sender)));
  const found = settled.filter((item) => item.status === "fulfilled");
  return found.length ? found.flatMap((item) => circleLogs(item.value, circleId)) : null;
}

// --- Rendering
const memberCount = () => app.policy?.roles[0].kind.Group?.length ?? app.circle?.invited.length ?? 0;

function renderCircle() {
  const { circle, circleId } = app;
  if (!circle) return;
  $("circle-head").hidden = false;
  if (setHtml("circle-head", circleHead(circle, circleId))) renderCountdown();
  renderStats();
  renderCircleList();
  setHtml("schedule", scheduleView(circle, app.events ?? null));
  setHtml("members", membersView(circle, app.events ?? null, app.withdrawals));
  setHtml("history-filter", historyFilters(app.historyFilter));
  setHtml("history", historyView(app.events, app.historyFilter, app.sessionTxs));
  setHtml("member-options", circle.members.map((member) => `<option value="${escapeHtml(member)}"></option>`).join(""));
  renderActions();
}

function renderCountdown() {
  const element = $("countdown");
  if (!element || !app.circle) return;
  const deadline = app.circle.round_deadline_ns;
  if (!deadline) {
    element.textContent = app.circle.phase === "Joining" ? "Not started" : "None";
    return;
  }
  const left = Math.floor((Number(BigInt(deadline) / 1_000_000n) - chainNow()) / 1000);
  if (app.circle.phase === "Closed" || left <= 0) {
    element.textContent = "Passed";
    return;
  }
  const parts = [[Math.floor(left / 86400), "d"], [Math.floor(left / 3600) % 24, "h"], [Math.floor(left / 60) % 60, "m"], [left % 60, "s"]];
  element.textContent = parts.filter(([value, unit]) => value > 0 || unit === "s").map(([value, unit]) => `${value}${unit}`).join(" ");
}

function renderActions() {
  const { circle, signer } = app;
  if (!circle) return;
  const buttons = [];
  if (!signer) {
    setHtml("actions", "<p>Connect a wallet to join, pay or reclaim.</p>");
    return;
  }
  if (circle.phase === "Joining" && circle.invited.includes(signer) && !circle.members.includes(signer)) buttons.push(["join", "Join this circle"]);
  if (circle.phase === "Active" && circle.members.includes(signer) && !circle.paid_this_round.includes(signer)) buttons.push(["contribute", `Pay ${formatNear(circle.contribution)}`]);
  if (circle.phase === "Closed" && circle.paid_this_round.includes(signer)) buttons.push(["reclaim", "Reclaim my money"]);
  setHtml("actions", buttons.length
    ? buttons.map(([action, text]) => `<button class="button button-primary" data-action="${action}">${escapeHtml(text)}</button>`).join("")
    : `<p>Nothing for ${escapeHtml(signer)} to do in this circle right now.</p>`);
}

function voteControl(item) {
  const { circle, policy, signer } = app;
  if (item.status !== "InProgress" || !signer || item.votes[signer]) return "";
  if (!policy.roles[0].kind.Group?.includes(signer)) return "";
  const expiresMs = Number((BigInt(item.submission_time) + BigInt(policy.proposal_period)) / 1_000_000n);
  // A vote on an expired proposal or a past round loses the proposer's bond, so it is not offered.
  if (chainNow() >= expiresMs) return "<p>This request's voting period is over.</p>";
  if (circle.phase === "Finished" || (circle.phase === "Active" && item.request.round !== circle.round)) return "<p>This request's round has ended.</p>";
  const note = circle.phase === "Closed" ? "<p>The deadline has passed: approving moves no money and returns the proposer's bond.</p>" : "";
  return `${note}<button class="button button-primary" data-action="approve" data-id="${item.id}">Approve</button>`;
}

/** The circle's log lines for a proposal, from the history service or this browser's own votes. */
async function loadProposalLogs(item) {
  const fromHistory = app.proposalLogs?.get(item.id);
  if (fromHistory && readWithdrawalLogs(fromHistory)) return fromHistory;
  if (item.status !== "Approved") return fromHistory ?? null;
  return (await logsFor(app.circle.dao_id, item.id, app.circleId)) ?? fromHistory ?? null;
}

async function renderProposals() {
  const { circle, withdrawals } = app;
  if (!circle) return;
  const logs = new Map(await Promise.all(withdrawals.map(async (item) => [item.id, await loadProposalLogs(item)])));
  if (circle !== app.circle) return; // A newer read has replaced this one.
  setHtml("proposals", approvalsView(circle, withdrawals, memberCount(), (id) => logs.get(id) ?? null, voteControl));
  setHtml("notifications", notificationsView(circle, app.events ?? null, withdrawals, logs, memberCount()));
}

/** Reads the history only when the circle has changed, because the chain's state says when that is. */
async function refreshHistory(circleId) {
  const { circle, withdrawals } = app;
  const signature = JSON.stringify([circle.phase, circle.round, circle.pot, circle.members.length, circle.paid_this_round.length, withdrawals.map((item) => item.status)]);
  const now = Date.now();
  if (signature !== app.historySignature) {
    app.historySignature = signature;
    app.historyFreshUntil = now + HISTORY_SETTLE_MS;
  } else if (now > app.historyFreshUntil && app.events) {
    return;
  }
  if (now - app.historyFetchedAt < HISTORY_RETRY_MS) return;
  app.historyFetchedAt = now;
  try {
    const transactions = await fetchCircleTransactions(circleId);
    if (circleId !== app.circleId) return;
    const { events, proposalLogs } = buildHistory(transactions, circleId);
    Object.assign(app, { events, proposalLogs });
  } catch (error) {
    if (circleId !== app.circleId) return;
    // Totals become unknown rather than wrong. The demo and everything else carry on.
    if (!app.events) Object.assign(app, { events: null, proposalLogs: null });
    console.warn("History unavailable:", error.message);
  }
}

// --- Loading
let refreshing = false;
async function refresh() {
  if (!app.circleId || refreshing) return;
  refreshing = true;
  const circleId = app.circleId;
  try {
    const [circle, now] = await Promise.all([view(circleId, "get_circle"), chainNowMs()]);
    // A DAO's policy does not change during a demo or a vote, so it is read once.
    const policy = app.policy?.daoId === circle.dao_id ? app.policy : { ...(await view(circle.dao_id, "get_policy")), daoId: circle.dao_id };
    const withdrawals = await loadWithdrawals(circle.dao_id, circleId);
    if (circleId !== app.circleId) return; // Another circle was opened meanwhile.
    // The round only moves on when the winner's payout has been sent, whoever made the last payment.
    const previous = app.circle;
    if (previous && circle.round > previous.round) {
      showPayoutNote(`Round ${previous.round + 1} complete: payout sent to ${previous.members[previous.round]}.`);
    }
    Object.assign(app, { circle, policy, withdrawals, clockOffsetMs: now - Date.now() });
    app.known.set(circleId, circle);
    rememberCircle(circleId);
    if (app.readFailed) showError(null); // A passing read clears an earlier failed one.
    app.readFailed = false;
    renderCircle();
    await renderProposals();
    await refreshHistory(circleId);
    if (circleId !== app.circleId) return;
    renderCircle();
    await renderProposals();
  } catch (error) {
    app.readFailed = true;
    showError(new Error(`Could not read ${circleId}: ${error.message}`));
  } finally {
    refreshing = false;
  }
}

function openCircle(circleId) {
  showError(null);
  if (circleId !== app.circleId) lastHtml.clear();
  Object.assign(app, { circleId, circle: null, withdrawals: [], events: undefined, proposalLogs: null, historySignature: null, historyFreshUntil: 0, historyFetchedAt: 0 });
  $("circle-id").value = circleId;
  renderCircleList();
  const url = new URL(location.href);
  url.searchParams.set("circle", circleId);
  history.replaceState(null, "", url);
  return refresh();
}

// --- Wallet actions
async function signAndCheck(receiverId, actions) {
  const hash = await sendTransaction(app.signer, receiverId, actions);
  const transaction = await fetchTransaction(hash, app.signer);
  const failures = failuresIn(transaction);
  if (failures.length > 0) throw new Error(`The transaction failed: ${failures.join("; ")}`);
  return hash;
}

async function act(run) {
  showError(null);
  try {
    await run();
    await refresh();
  } catch (error) {
    showError(error);
  }
}

$("actions").addEventListener("click", (event) => {
  const action = event.target.dataset?.action;
  if (!action) return;
  const { circle, circleId } = app;
  const calls = {
    join: () => functionCall("join", {}),
    contribute: () => functionCall("contribute", {}, { deposit: BigInt(circle.contribution) }),
    reclaim: () => functionCall("reclaim", {}),
  };
  act(() => signAndCheck(circleId, [calls[action]()]));
});

$("circle-list").addEventListener("click", (event) => {
  const id = event.target.closest("[data-circle]")?.dataset.circle;
  if (id && id !== app.circleId) openCircle(id);
});

$("history-filter").addEventListener("click", (event) => {
  const filter = event.target.dataset?.filter;
  if (!filter) return;
  app.historyFilter = filter;
  renderCircle();
});

$("proposals").addEventListener("click", (event) => {
  if (event.target.dataset?.action !== "approve") return;
  const id = Number(event.target.dataset.id);
  const item = app.withdrawals.find((candidate) => candidate.id === id);
  const daoId = app.circle.dao_id;
  act(async () => {
    const hash = await sendTransaction(app.signer, daoId, [
      functionCall("act_proposal", { id, action: "VoteApprove", proposal: item.kind }, { gas: 300n }),
    ]);
    saveVote(daoId, id, hash, app.signer);
  });
});

/** The circle's own rules. A request it refuses costs the proposer the bond, so check them first. */
function withdrawalProblem(recipient, amount) {
  const { circle, policy, signer } = app;
  if (!signer) return "Connect a wallet first.";
  if (!policy?.roles[0].kind.Group?.includes(signer)) return "Only a member of the circle's DAO can file a request.";
  if (circle.phase !== "Active") return "Early withdrawals are only possible while a round is active.";
  const turn = circle.members.indexOf(recipient);
  if (turn === -1) return "The recipient is not a member of this circle.";
  if (turn < circle.round) return "The recipient's turn has passed, so there is no later payout to repay this from.";
  if (!circle.paid_this_round.includes(recipient)) return "The recipient has not paid this round yet.";
  if (amount <= 0n) return "The amount must be more than zero.";
  const entry = circle.withdrawn_this_round.find(([account]) => account === recipient);
  const taken = entry ? BigInt(entry[1]) : 0n;
  if (taken + amount > BigInt(circle.contribution)) return `A member can take at most ${formatNear(circle.contribution)} per round.`;
  return null;
}

$("propose-form").addEventListener("submit", (event) => {
  event.preventDefault();
  act(async () => {
    if (!app.circle) throw new Error("Open a circle first.");
    const recipient = $("recipient").value.trim();
    const amount = parseNear($("amount").value);
    const problem = withdrawalProblem(recipient, amount);
    if (problem) throw new Error(problem);
    const args = { recipient, amount: String(amount), round: app.circle.round };
    const kind = {
      FunctionCall: {
        receiver_id: app.circleId,
        actions: [{ method_name: "execute_early_withdrawal", args: btoa(JSON.stringify(args)), deposit: "0", gas: "150000000000000" }],
      },
    };
    await signAndCheck(app.circle.dao_id, [
      functionCall("add_proposal", { proposal: { description: "Early withdrawal", kind } }, { deposit: BigInt(app.policy.proposal_bond) }),
    ]);
  });
});

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = (text) => { $("create-status").textContent = text; };
  try {
    if (!app.signer) throw new Error("Connect a wallet first.");
    const members = [...new Set($("members-input").value.split(/\s+/).filter(Boolean))];
    if (members.length < 2) throw new Error("A circle needs at least 2 different members.");
    const contribution = parseNear($("contribution").value);
    if (contribution <= 0n) throw new Error("The contribution must be more than zero.");
    const roundDuration = Number($("duration").value);
    const suffix = Math.random().toString(16).slice(2, 8);

    status("Step 1 of 2: approve creating the DAO in your wallet.");
    const name = `ajo-${suffix}`;
    const daoId = `${name}.${FACTORY}`;
    const daoArgs = {
      config: { name: "Ajo circle", purpose: "Approves early withdrawals", metadata: "" },
      policy: buildDaoPolicy(members, PROPOSAL_PERIOD_NS),
    };
    await sendTransaction(app.signer, FACTORY, [
      functionCall("create", { name, args: btoa(JSON.stringify(daoArgs)) }, { gas: 300n, deposit: DAO_DEPOSIT }),
    ]);
    // The factory returns nothing useful, so reading the DAO back is the proof it exists.
    const policy = await view(daoId, "get_policy");
    if (policy.roles[0].kind.Group?.join() !== members.join()) throw new Error("The DAO's members do not match the circle's.");

    status("Step 2 of 2: approve deploying the circle in your wallet.");
    const circleId = `circle-${suffix}.${app.signer}`;
    const code = new Uint8Array(await (await fetch("/ajo_circle.wasm")).arrayBuffer());
    await signAndCheck(circleId, [
      { type: "CreateAccount" },
      { type: "Transfer", params: { deposit: String(CIRCLE_FUNDING) } },
      { type: "DeployContract", params: { code } },
      functionCall("new", { dao_id: daoId, contribution: String(contribution), round_duration_sec: roundDuration, invited: members }),
    ]);
    status(`Created ${circleId}. Share this page's address with the members so they can join.`);
    await openCircle(circleId);
  } catch (error) {
    status(`Could not create the circle: ${error.message ?? error}`);
  }
});

// --- Demo
const log = (html, className = "") => {
  const item = document.createElement("li");
  item.className = className;
  item.innerHTML = html;
  $("demo-log").append(item);
  $("demo-log").scrollTop = $("demo-log").scrollHeight;
  return item;
};

async function callDemoApi(body) {
  const response = await fetch("/api/demo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply = await response.json();
  if (!response.ok) throw new Error(reply.error ?? "The demo server refused the request.");
  return reply;
}

async function waitForDeadline(circleId) {
  const { round_deadline_ns: deadline } = await view(circleId, "get_circle");
  const deadlineMs = Number(BigInt(deadline) / 1_000_000n);
  while ((await chainNowMs()) < deadlineMs) await new Promise((resolve) => setTimeout(resolve, 2000));
}

$("run-demo").addEventListener("click", async () => {
  if (app.demoRunning) return;
  app.demoRunning = true;
  $("run-demo").disabled = true;
  $("demo-log").innerHTML = "";
  const totalSteps = STEPS.filter((step) => step.action).length;
  let finishedSteps = 0;
  setDemoProgress(0, true);
  const started = Date.now();
  let daoId;
  let current;
  let tooLateProposal;
  try {
    await runDemo({
      callApi: callDemoApi,
      waitForDeadline,
      onStart: (run) => {
        daoId = run.daoId;
        log("Three test accounts, m1, m2 and m3, each contribute 0.1 NEAR per round.");
        rememberCircle(run.late);
        rememberCircle(run.full);
        loadKnownCircles();
      },
      onSection: (text) => log(escapeHtml(text), "section-title"),
      onStep: (step, circleId) => {
        current = log(`${escapeHtml(step.text)}...`, "pending");
        if (circleId !== app.circleId) openCircle(circleId);
      },
      onResult: (step, circleId, result) => {
        const check = step.payout ? '<span class="check" aria-hidden="true">✓</span> ' : "";
        current.classList.remove("pending");
        current.innerHTML = check + (result.hash
          ? `${escapeHtml(step.text)}. <a href="${txUrl(result.hash)}" target="_blank" rel="noopener">transaction</a>`
          : `${escapeHtml(step.text)}. Done.`);
        finishedSteps += 1;
        setDemoProgress(finishedSteps / totalSteps, true);
        if (result.hash) app.sessionTxs.unshift({ text: step.text, hash: result.hash });
        if (step.action === "vote") saveVote(daoId, result.proposalId, result.hash, result.sender);
        if (step.id === "late-vote-m3") tooLateProposal = result.proposalId;
      },
    });
    await refresh();
    const seconds = Math.round((Date.now() - started) / 1000);
    const { status } = await view(daoId, "get_proposal", { id: tooLateProposal });
    const outcome = withdrawalOutcome(status, await logsFor(daoId, tooLateProposal, app.circleId));
    log(`<strong>Demo finished in ${seconds} seconds.</strong> The late approval's DAO status is ${escapeHtml(status)}, but what really happened: <strong>${escapeHtml(outcome.text)}</strong>`, "result");
    loadKnownCircles();
    setDemoProgress(1, false);
  } catch (error) {
    log(`The demo stopped: ${escapeHtml(error.message ?? error)}`, "error");
    $("demo-progress").hidden = true; // A full or moving bar would suggest it is still working.
  } finally {
    app.demoRunning = false;
    $("run-demo").disabled = false;
  }
});

// --- Start
$("load-form").addEventListener("submit", (event) => {
  event.preventDefault();
  openCircle($("circle-id").value.trim());
});
$("connect").addEventListener("click", () => connectWallet().catch(showError));
$("disconnect").addEventListener("click", () => disconnectWallet().then(() => setSigner(null)).catch(showError));

function setSigner(accountId) {
  app.signer = accountId;
  $("wallet-status").textContent = accountId ?? "";
  $("connect").hidden = Boolean(accountId);
  $("disconnect").hidden = !accountId;
  renderActions();
  renderCircle();
  renderProposals();
}
watchWallet(setSigner);

setInterval(renderCountdown, 1000);
setInterval(refresh, REFRESH_MS);
renderStats();
loadKnownCircles();
const fromUrl = new URL(location.href).searchParams.get("circle");
openCircle(fromUrl ?? SAMPLE_CIRCLES[0]);
