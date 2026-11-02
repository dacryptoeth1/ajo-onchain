import { chainNowMs, failuresIn, fetchTransaction, formatNear, loadWithdrawals, parseNear, txUrl, view } from "./chain.js";
import { buildDaoPolicy } from "./dao-policy.js";
import { STEPS, runDemo } from "./demo-steps.js";
import { circleLogs, withdrawalOutcome } from "./outcome.js";
import { connectWallet, disconnectWallet, functionCall, sendTransaction, watchWallet } from "./wallet.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const FACTORY = "sputnikv2.testnet";
const DAO_DEPOSIT = 6n * 10n ** 24n;
const CIRCLE_FUNDING = 2n * 10n ** 24n;
const PROPOSAL_PERIOD_NS = String(72n * 3600n * 1_000_000_000n);
const PAYOUT_NOTE_MS = 4000;

const REFRESH_MS = 5000;
const app = { signer: null, circleId: null, circle: null, policy: null, withdrawals: [], clockOffsetMs: 0, demoRunning: false, readFailed: false };
const chainNow = () => Date.now() + app.clockOffsetMs;

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
function renderState() {
  const { circle, circleId } = app;
  if (!circle) return;
  const paid = new Set(circle.paid_this_round);
  const rows = circle.members.map((member, turn) => {
    const notes = [];
    if (turn === circle.round) notes.push("wins this round");
    else if (turn < circle.round) notes.push("has had their turn");
    if (circle.phase === "Active") notes.push(paid.has(member) ? "paid" : "not paid");
    // Reclaiming removes a member from the list, so on a closed circle it no longer means "never paid".
    if (circle.phase === "Closed") notes.push(paid.has(member) ? "can reclaim" : "nothing left to reclaim");
    return `<li><code>${escapeHtml(member)}</code>: ${escapeHtml(notes.join(", "))}</li>`;
  }).join("");
  const waiting = circle.invited.filter((account) => !circle.members.includes(account));
  const debts = circle.debts.map((debt) =>
    `<li><code>${escapeHtml(debt.debtor)}</code> owes <code>${escapeHtml(debt.creditor)}</code> ${formatNear(debt.amount)}</li>`).join("");
  const phaseText = {
    Joining: "Waiting for members to join",
    Active: "Active",
    Finished: "Finished: every member has had a turn",
    Closed: "Closed: a round missed its deadline. Members who paid it can reclaim.",
  }[circle.phase];
  const roundText = circle.phase === "Finished" ? `${circle.members.length} of ${circle.members.length} completed` : `${circle.round + 1} of ${circle.invited.length}`;
  $("state").innerHTML = `
    <p><code>${escapeHtml(circleId)}</code></p>
    <p><strong>${escapeHtml(phaseText)}</strong></p>
    <ul>
      <li>Round: ${roundText}</li>
      <li>Winner this round: ${circle.winner ? `<code>${escapeHtml(circle.winner)}</code>` : "none"}</li>
      <li>Pot: <strong>${formatNear(circle.pot)}</strong></li>
      <li>Contribution: ${formatNear(circle.contribution)} per round</li>
      <li>Deadline: <span id="countdown"></span></li>
    </ul>
    ${rows ? `<h3>Members in rotation order</h3><ul>${rows}</ul>` : ""}
    ${waiting.length ? `<p>Not joined yet: ${waiting.map((a) => `<code>${escapeHtml(a)}</code>`).join(", ")}</p>` : ""}
    ${debts ? `<h3>Early withdrawals still owed</h3><ul>${debts}</ul>` : ""}`;
  renderCountdown();
}

function renderCountdown() {
  const element = $("countdown");
  if (!element || !app.circle) return;
  const deadline = app.circle.round_deadline_ns;
  if (!deadline) {
    element.textContent = app.circle.phase === "Joining" ? "starts when everyone has joined" : "none";
    return;
  }
  const left = Math.floor((Number(BigInt(deadline) / 1_000_000n) - chainNow()) / 1000);
  if (app.circle.phase === "Closed" || left <= 0) {
    element.textContent = "passed";
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
    $("actions").innerHTML = "<p>Connect a wallet to join, pay or reclaim.</p>";
    return;
  }
  if (circle.phase === "Joining" && circle.invited.includes(signer) && !circle.members.includes(signer)) buttons.push(["join", "Join this circle"]);
  if (circle.phase === "Active" && circle.members.includes(signer) && !circle.paid_this_round.includes(signer)) buttons.push(["contribute", `Pay ${formatNear(circle.contribution)}`]);
  if (circle.phase === "Closed" && circle.paid_this_round.includes(signer)) buttons.push(["reclaim", "Reclaim my money"]);
  $("actions").innerHTML = buttons.length
    ? buttons.map(([action, text]) => `<button data-action="${action}">${escapeHtml(text)}</button>`).join("")
    : `<p>Nothing for <code>${escapeHtml(signer)}</code> to do in this circle right now.</p>`;
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
  return `${note}<button data-action="approve" data-id="${item.id}">Approve</button>`;
}

async function renderProposals() {
  const { circle, circleId, withdrawals } = app;
  if (!circle) return;
  if (withdrawals.length === 0) {
    $("proposals").innerHTML = "<p>No early withdrawals requested.</p>";
    return;
  }
  const memberCount = app.policy.roles[0].kind.Group?.length ?? circle.invited.length;
  const rows = await Promise.all(withdrawals.map(async (item) => {
    const logs = item.status === "Approved" ? await logsFor(circle.dao_id, item.id, circleId) : null;
    const outcome = withdrawalOutcome(item.status, logs);
    const yes = Object.values(item.votes).filter((vote) => vote === "Approve").length;
    return `<div class="proposal" data-outcome="${outcome.key}">
      <div>#${item.id}: ${formatNear(item.request.amount)} to <code>${escapeHtml(item.request.recipient)}</code>, round ${item.request.round + 1}. ${yes} of ${memberCount} approved.</div>
      <div>DAO status: ${escapeHtml(item.status)}</div>
      <div class="outcome">What really happened: ${escapeHtml(outcome.text)}</div>
      ${voteControl(item)}
    </div>`;
  }));
  $("proposals").innerHTML = rows.join("");
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
    if (app.readFailed) showError(null); // A passing read clears an earlier failed one.
    app.readFailed = false;
    renderState();
    renderActions();
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
  app.circleId = circleId;
  app.circle = null;
  $("circle-id").value = circleId;
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
    const members = [...new Set($("members").value.split(/\s+/).filter(Boolean))];
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
        log(`The accounts are <code>m1</code>, <code>m2</code> and <code>m3</code>. Each contribution is 0.1 NEAR.`);
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
        if (step.action === "vote") saveVote(daoId, result.proposalId, result.hash, result.sender);
        if (step.id === "late-vote-m3") tooLateProposal = result.proposalId;
      },
    });
    await refresh();
    const seconds = Math.round((Date.now() - started) / 1000);
    const { status } = await view(daoId, "get_proposal", { id: tooLateProposal });
    const outcome = withdrawalOutcome(status, await logsFor(daoId, tooLateProposal, app.circleId));
    log(`Demo finished in ${seconds} seconds.`, "section-title");
    log(`The late approval's DAO status is ${escapeHtml(status)}, but what really happened: <strong>${escapeHtml(outcome.text)}</strong>`);
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
  $("wallet-status").textContent = accountId ? `Connected as ${accountId}.` : "Not connected.";
  $("connect").hidden = Boolean(accountId);
  $("disconnect").hidden = !accountId;
  renderActions();
  renderProposals();
}
watchWallet(setSigner);

setInterval(renderCountdown, 1000);
setInterval(refresh, REFRESH_MS);
const fromUrl = new URL(location.href).searchParams.get("circle");
if (fromUrl) openCircle(fromUrl);
