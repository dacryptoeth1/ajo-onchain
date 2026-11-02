// The demo script. The server signs only these steps, so nobody can use the demo accounts for
// anything else. This file holds no keys.
export const CONTRIBUTION = "100000000000000000000000"; // 0.1 NEAR
export const FULL_ROUND_SECONDS = 86400;
export const LATE_ROUND_SECONDS = 60;
const WITHDRAWAL = "50000000000000000000000"; // 0.05 NEAR
const LATE_WITHDRAWAL = "10000000000000000000000"; // 0.01 NEAR

const join = (circle, signer) => ({ id: `${circle}-join-${signer}`, circle, signer, action: "join", text: `${signer} joins` });
const pay = (circle, signer, round, payoutText) => ({
  id: `${circle}-pay-${round}-${signer}`, circle, signer, action: "pay",
  text: payoutText ?? `${signer} pays round ${round + 1}`,
  payout: Boolean(payoutText),
});
const vote = (circle, signer, text) => ({ id: `${circle}-vote-${signer}`, circle, signer, action: "vote", text });

export const STEPS = [
  { section: "Part 1: a full circle. Everyone pays, and each member wins once." },
  join("full", "m1"), join("full", "m2"), join("full", "m3"),
  pay("full", "m1", 0), pay("full", "m3", 0),
  {
    id: "full-propose", circle: "full", signer: "m1", action: "propose", recipient: "m3", amount: WITHDRAWAL, round: 0,
    text: "m3 asks to take 0.05 NEAR early, and m1 files it with the DAO",
  },
  vote("full", "m1", "m1 approves (1 of 3)"),
  vote("full", "m2", "m2 approves (2 of 3)"),
  vote("full", "m3", "m3 approves (3 of 3). m3 receives 0.05 NEAR"),
  pay("full", "m2", 0, "m2 pays. Round 1 is complete: m1 wins 0.25 NEAR, short by m3's advance"),
  pay("full", "m1", 1), pay("full", "m3", 1),
  pay("full", "m2", 1, "m2 pays. Round 2 is complete: m2 wins 0.30 NEAR"),
  pay("full", "m1", 2), pay("full", "m2", 2),
  pay("full", "m3", 2, "m3 pays. Round 3 is complete: m3 wins 0.25 NEAR, and the 0.05 NEAR advance goes back to m1"),

  { section: "Part 2: a missed deadline. m3 stops paying in a 60 second round." },
  join("late", "m1"), join("late", "m2"), join("late", "m3"),
  pay("late", "m1", 0), pay("late", "m2", 0),
  {
    id: "late-propose", circle: "late", signer: "m1", action: "propose", recipient: "m2", amount: LATE_WITHDRAWAL, round: 0,
    text: "m2 asks to take 0.01 NEAR early, and m1 files it with the DAO",
  },
  vote("late", "m1", "m1 approves (1 of 3)"),
  vote("late", "m2", "m2 approves (2 of 3). m3 stays silent"),
  { id: "late-wait", circle: "late", action: "wait", text: "Waiting for the round's deadline on the chain clock" },
  vote("late", "m3", "m3 approves after the deadline (3 of 3)"),
  { id: "late-reclaim-m1", circle: "late", signer: "m1", action: "reclaim", text: "m1 reclaims the 0.1 NEAR paid this round" },
  { id: "late-reclaim-m2", circle: "late", signer: "m2", action: "reclaim", text: "m2 reclaims the 0.1 NEAR paid this round" },
];

/** Runs the whole demo. `callApi` reaches the server, and the hooks report progress to the page. */
export async function runDemo({ callApi, waitForDeadline, onStart, onSection, onStep, onResult }) {
  const run = await callApi({ action: "start" });
  onStart(run);
  const proposalIds = {};
  for (const step of STEPS) {
    if (step.section) {
      onSection(step.section);
      continue;
    }
    const circleId = run[step.circle];
    onStep(step, circleId);
    if (step.action === "wait") {
      await waitForDeadline(circleId);
      onResult(step, circleId, {});
      continue;
    }
    const result = await callApi({ action: "step", stepId: step.id, run: run.run, proposalId: proposalIds[step.circle] });
    if (step.action === "propose") proposalIds[step.circle] = result.value;
    onResult(step, circleId, { ...result, proposalId: proposalIds[step.circle], sender: result.sender });
  }
  return run;
}
