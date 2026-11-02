//! One rotating savings circle.
//!
//! The members are fixed when the contract is deployed. Rotation order is the order they join.
//! Each round every member pays the same contribution, and the last payment automatically sends
//! the pot to that round's winner. Early withdrawals are DAO proposals: this contract only pays
//! one out when the call comes from the DAO account, so the DAO's voting rules decide it.
//!
//! Every round has a deadline. If a round is not fully paid by then, the circle closes for good
//! and the members who paid that round can take back what they are owed with `reclaim`.
//!
//! An early withdrawal is an advance on the recipient's own money, so nobody comes out ahead.
//! A recipient can only take up to one contribution per round, from a round they have paid, and
//! only before their own turn has passed. If it shortens another member's payout, the recipient
//! owes that member, and the debt is paid out of the recipient's next payout or reclaim.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

const GAS_FOR_TRANSFER_CALLBACK: Gas = Gas::from_tgas(10);
const NANOS_PER_SECOND: u64 = 1_000_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Unclaimed,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Waiting for every invited account to join.
    Joining,
    /// Rounds are running.
    Active,
    /// Every member has had their turn.
    Finished,
    /// A round missed its deadline. Nothing more can be paid in, only reclaimed.
    Closed,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CircleView {
    pub phase: Phase,
    pub dao_id: AccountId,
    pub contribution: U128,
    pub round_duration_sec: u32,
    pub invited: Vec<AccountId>,
    /// Members in rotation order. Member `n` wins round `n`.
    pub members: Vec<AccountId>,
    pub round: u32,
    /// Chain time in nanoseconds. Empty while joining and after the last round.
    pub round_deadline_ns: Option<U64>,
    pub winner: Option<AccountId>,
    /// Members whose payment for this round is still in the pot.
    pub paid_this_round: Vec<AccountId>,
    /// Early withdrawals taken from this round's pot, by recipient.
    pub withdrawn_this_round: Vec<(AccountId, NearToken)>,
    pub debts: Vec<Debt>,
    pub pot: U128,
}

/// An early withdrawal that shortened another member's payout.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Debt {
    pub debtor: AccountId,
    pub creditor: AccountId,
    pub amount: NearToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Circle {
    dao_id: AccountId,
    contribution: NearToken,
    round_duration_sec: u32,
    invited: Vec<AccountId>,
    members: Vec<AccountId>,
    round: u32,
    round_deadline_ns: Option<u64>,
    paid_this_round: Vec<AccountId>,
    withdrawn_this_round: Vec<(AccountId, NearToken)>,
    debts: Vec<Debt>,
    /// Tracked explicitly because the account balance also covers storage.
    pot: NearToken,
    /// Payouts whose transfer failed, waiting for the recipient to call `claim`.
    unclaimed: LookupMap<AccountId, NearToken>,
}

#[near]
impl Circle {
    /// Anyone could call this on an uninitialized contract, so deploy and initialize in one
    /// transaction. `#[init]` rejects any later call.
    #[init]
    pub fn new(
        dao_id: AccountId,
        contribution: U128,
        round_duration_sec: u32,
        invited: Vec<AccountId>,
    ) -> Self {
        require!(contribution.0 > 0, "ERR_ZERO_CONTRIBUTION");
        require!(round_duration_sec > 0, "ERR_ZERO_DURATION");
        require!(invited.len() >= 2, "ERR_TOO_FEW_MEMBERS");
        for (index, account) in invited.iter().enumerate() {
            require!(!invited[..index].contains(account), "ERR_DUPLICATE_INVITE");
        }
        Self {
            dao_id,
            contribution: NearToken::from_yoctonear(contribution.0),
            round_duration_sec,
            invited,
            members: Vec::new(),
            round: 0,
            round_deadline_ns: None,
            paid_this_round: Vec::new(),
            withdrawn_this_round: Vec::new(),
            debts: Vec::new(),
            pot: NearToken::from_yoctonear(0),
            unclaimed: LookupMap::new(StorageKey::Unclaimed),
        }
    }

    /// Takes the next place in the rotation. The last member to join starts round 0's clock.
    pub fn join(&mut self) {
        let account = env::predecessor_account_id();
        require!(self.invited.contains(&account), "ERR_NOT_INVITED");
        require!(!self.members.contains(&account), "ERR_ALREADY_JOINED");
        self.members.push(account);
        if self.members.len() == self.invited.len() {
            self.round_deadline_ns = Some(self.after_one_round(env::block_timestamp()));
        }
    }

    /// Pays this round's contribution. The last payment of a round pays the winner.
    /// A rejected call refunds the attached deposit.
    #[payable]
    pub fn contribute(&mut self) {
        require!(self.phase() == Phase::Active, "ERR_NOT_ACTIVE");
        let account = env::predecessor_account_id();
        require!(self.members.contains(&account), "ERR_NOT_MEMBER");
        require!(!self.paid_this_round.contains(&account), "ERR_ALREADY_PAID");
        require!(env::attached_deposit() == self.contribution, "ERR_WRONG_AMOUNT");

        self.paid_this_round.push(account);
        self.pot = self.pot.saturating_add(self.contribution);

        if self.paid_this_round.len() == self.members.len() {
            self.pay_winner();
        }
    }

    /// Pays an early withdrawal from the current pot. Only the DAO can call this, which it does
    /// when a FunctionCall proposal is approved. `round` must be the current round, so a proposal
    /// approved after its round has ended cannot take money from a later round's members.
    ///
    /// After a missed deadline this pays nothing but still returns normally. Sputnik keeps the
    /// proposer's bond when a call fails and returns it when a call succeeds, so a panic here
    /// would cost the proposer 0.1 NEAR for a vote that simply came too late. The proposal shows
    /// as Approved, and the log line and the unchanged pot show that nothing moved.
    pub fn execute_early_withdrawal(&mut self, recipient: AccountId, amount: U128, round: u32) {
        require!(env::predecessor_account_id() == self.dao_id, "ERR_ONLY_DAO");
        if self.phase() == Phase::Closed {
            env::log_str(&format!(
                "early_withdrawal_refused reason=deadline_passed round={} recipient={} amount={}",
                round, recipient, amount.0
            ));
            return;
        }
        require!(self.phase() == Phase::Active, "ERR_NOT_ACTIVE");
        require!(round == self.round, "ERR_WRONG_ROUND");
        let turn = self.members.iter().position(|member| *member == recipient);
        let turn = turn.unwrap_or_else(|| env::panic_str("ERR_NOT_MEMBER"));
        // Someone whose turn has passed has no later payout to repay this from.
        require!(turn as u32 >= self.round, "ERR_TURN_ALREADY_PAID");
        // Without this, a member could take money and then skip the round.
        require!(self.paid_this_round.contains(&recipient), "ERR_RECIPIENT_NOT_PAID");
        let amount = NearToken::from_yoctonear(amount.0);
        require!(!amount.is_zero(), "ERR_ZERO_AMOUNT");
        let total = self.withdrawn_by(&recipient).saturating_add(amount);
        require!(total <= self.contribution, "ERR_AMOUNT_EXCEEDS_SHARE");

        self.withdrawn_this_round.retain(|(account, _)| *account != recipient);
        self.withdrawn_this_round.push((recipient.clone(), total));
        self.pot = self.pot.saturating_sub(amount);
        env::log_str(&format!(
            "early_withdrawal round={} recipient={} amount={}",
            self.round,
            recipient,
            amount.as_yoctonear()
        ));
        self.send(recipient, amount);
    }

    /// Takes back this caller's contribution to the round that missed its deadline, less anything
    /// they already withdrew from it. Any debts from earlier rounds are paid out of it first.
    pub fn reclaim(&mut self) {
        require!(self.phase() == Phase::Closed, "ERR_NOT_CLOSED");
        let account = env::predecessor_account_id();
        let index = self.paid_this_round.iter().position(|paid| *paid == account);
        let index = index.unwrap_or_else(|| env::panic_str("ERR_NOTHING_TO_RECLAIM"));
        let share = self.contribution.saturating_sub(self.withdrawn_by(&account));

        self.paid_this_round.remove(index);
        self.withdrawn_this_round.retain(|(withdrawer, _)| *withdrawer != account);
        self.pot = self.pot.saturating_sub(share);
        env::log_str(&format!(
            "reclaimed round={} account={} amount={}",
            self.round,
            account,
            share.as_yoctonear()
        ));
        self.pay_after_debts(account, share);
    }

    /// Collects a payout whose transfer failed earlier.
    pub fn claim(&mut self) {
        let account = env::predecessor_account_id();
        let amount = self.unclaimed.remove(&account);
        let amount = amount.unwrap_or_else(|| env::panic_str("ERR_NOTHING_TO_CLAIM"));
        self.send(account, amount);
    }

    /// Records a failed transfer so the money stays claimable.
    #[private]
    pub fn on_transfer(
        &mut self,
        recipient: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            let owed = self.unclaimed.get(&recipient).copied().unwrap_or(NearToken::from_yoctonear(0));
            let total = owed.saturating_add(NearToken::from_yoctonear(amount.0));
            self.unclaimed.insert(recipient.clone(), total);
            env::log_str(&format!("transfer_failed recipient={} amount={}", recipient, amount.0));
        }
    }

    pub fn get_circle(&self) -> CircleView {
        CircleView {
            phase: self.phase(),
            dao_id: self.dao_id.clone(),
            contribution: U128(self.contribution.as_yoctonear()),
            round_duration_sec: self.round_duration_sec,
            invited: self.invited.clone(),
            members: self.members.clone(),
            round: self.round,
            round_deadline_ns: self.round_deadline_ns.map(U64),
            winner: self.members.get(self.round as usize).cloned(),
            paid_this_round: self.paid_this_round.clone(),
            withdrawn_this_round: self.withdrawn_this_round.clone(),
            debts: self.debts.clone(),
            pot: U128(self.pot.as_yoctonear()),
        }
    }

    pub fn get_unclaimed(&self, account_id: AccountId) -> U128 {
        U128(self.unclaimed.get(&account_id).map_or(0, |amount| amount.as_yoctonear()))
    }
}

impl Circle {
    fn phase(&self) -> Phase {
        if self.members.len() < self.invited.len() {
            Phase::Joining
        } else if (self.round as usize) >= self.members.len() {
            Phase::Finished
        } else if self.round_deadline_ns.is_some_and(|deadline| env::block_timestamp() >= deadline) {
            Phase::Closed
        } else {
            Phase::Active
        }
    }

    fn withdrawn_by(&self, account: &AccountId) -> NearToken {
        let entry = self.withdrawn_this_round.iter().find(|(withdrawer, _)| withdrawer == account);
        entry.map_or(NearToken::from_yoctonear(0), |(_, amount)| *amount)
    }

    /// Pays `account`'s creditors out of `amount`, then sends `account` whatever is left.
    fn pay_after_debts(&mut self, account: AccountId, amount: NearToken) {
        let mut left = amount;
        for mut debt in std::mem::take(&mut self.debts) {
            if debt.debtor == account && !left.is_zero() {
                let repaid = debt.amount.min(left);
                left = left.saturating_sub(repaid);
                debt.amount = debt.amount.saturating_sub(repaid);
                env::log_str(&format!(
                    "debt_repaid debtor={} creditor={} amount={}",
                    account,
                    debt.creditor,
                    repaid.as_yoctonear()
                ));
                self.send(debt.creditor.clone(), repaid);
            }
            if !debt.amount.is_zero() {
                self.debts.push(debt);
            }
        }
        if !left.is_zero() {
            self.send(account, left);
        }
    }

    fn after_one_round(&self, start_ns: u64) -> u64 {
        start_ns.saturating_add(self.round_duration_sec as u64 * NANOS_PER_SECOND)
    }

    /// State changes before the transfer, so nothing can be paid twice.
    fn pay_winner(&mut self) {
        let winner = self.members[self.round as usize].clone();
        let amount = self.pot;
        env::log_str(&format!(
            "round_paid round={} winner={} amount={}",
            self.round,
            winner,
            amount.as_yoctonear()
        ));
        self.pot = NearToken::from_yoctonear(0);
        self.paid_this_round.clear();
        // The winner's own withdrawals already came out of the pot they are receiving.
        for (recipient, withdrawn) in std::mem::take(&mut self.withdrawn_this_round) {
            if recipient != winner {
                self.debts.push(Debt {
                    debtor: recipient,
                    creditor: winner.clone(),
                    amount: withdrawn,
                });
            }
        }
        self.round += 1;
        // Deadlines stay on a fixed schedule, so paying early does not move the next one forward.
        self.round_deadline_ns = if (self.round as usize) < self.members.len() {
            self.round_deadline_ns.map(|deadline| self.after_one_round(deadline))
        } else {
            None
        };
        self.pay_after_debts(winner, amount);
    }

    fn send(&self, recipient: AccountId, amount: NearToken) {
        Promise::new(recipient.clone())
            .transfer(amount)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_TRANSFER_CALLBACK)
                    .on_transfer(recipient, U128(amount.as_yoctonear())),
            )
            .detach();
    }
}
