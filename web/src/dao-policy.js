// The one definition of a circle's DAO policy, used by the page and by the testnet scripts.
const ALL_MEMBERS = { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] };
const BOND = "100000000000000000000000"; // 0.1 NEAR

/** Members-only DAO policy where every proposal kind needs 100% of members. */
export function buildDaoPolicy(memberIds, proposalPeriodNs) {
  return {
    // Only members can do anything. Sputnik's default "all" role, which lets anyone
    // file proposals, is left out on purpose.
    roles: [
      {
        name: "members",
        kind: { Group: memberIds },
        permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
        vote_policy: { transfer: ALL_MEMBERS },
      },
    ],
    // The default must also be 100%. At 50%, two members could pass a
    // remove_member_from_role or policy proposal and sidestep the transfer rule.
    default_vote_policy: ALL_MEMBERS,
    proposal_bond: BOND,
    proposal_period: proposalPeriodNs,
    bounty_bond: BOND,
    bounty_forgiveness_period: proposalPeriodNs,
  };
}
