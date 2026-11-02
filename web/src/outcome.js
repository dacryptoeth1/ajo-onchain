// Works out what really happened to an early withdrawal.
//
// A proposal's status is not enough. After a missed deadline the circle pays nothing but returns
// normally, so Sputnik returns the bond and shows "Approved". Only the circle's own log line, from
// the transaction that ran the call, says whether money moved.

const NO_MONEY = "No money moved.";

/** Logs written by the circle itself. Another contract in the transaction could log anything. */
export function circleLogs(transaction, circleId) {
  return (transaction?.receipts_outcome ?? [])
    .filter((receipt) => receipt.outcome.executor_id === circleId)
    .flatMap((receipt) => receipt.outcome.logs);
}

/** "paid", "refused", or null when these logs say nothing about a withdrawal. */
export function readWithdrawalLogs(logs) {
  // The trailing space matters: "early_withdrawal_refused" also starts with "early_withdrawal".
  if (logs.some((log) => log.startsWith("early_withdrawal_refused "))) return "refused";
  if (logs.some((log) => log.startsWith("early_withdrawal "))) return "paid";
  return null;
}

/** `logs` is null when this browser never saw the transaction that ran the call. */
export function withdrawalOutcome(status, logs) {
  switch (status) {
    case "Approved": {
      const result = logs ? readWithdrawalLogs(logs) : null;
      if (result === "paid") return { key: "paid", text: "Paid to the recipient." };
      if (result === "refused") {
        return { key: "too-late", text: `Too late: the round's deadline had passed. ${NO_MONEY} The proposer's bond was returned.` };
      }
      return { key: "unknown", text: "Not confirmed. The DAO approved it, but this browser did not see the transaction, so it may not have paid." };
    }
    case "InProgress":
      return { key: "open", text: `Waiting for every member to approve. ${NO_MONEY}` };
    case "Failed":
      return { key: "failed", text: `The circle refused it. ${NO_MONEY} The proposer's bond was kept.` };
    case "Expired":
      return { key: "expired", text: `Nobody finished approving in time. ${NO_MONEY}` };
    default:
      return { key: "closed", text: `Ended as ${status}. ${NO_MONEY}` };
  }
}
