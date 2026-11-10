# Ajo onchain

A rotating savings circle on NEAR, built for the NEAR Hackathon (tracks 08 Real-world money and 12 Social money).

Members pay in each round, and the pot automatically goes to that round's winner in rotation order. An early withdrawal needs approval from ALL members through a Sputnik DAO, and silence counts as no. Everything runs onchain on NEAR, on testnet for now.

**Live site:** https://ajo-onchain-vert.vercel.app

## How it works

Each circle is one contract (`contract/src/lib.rs`) paired with one DAO.

1. **Deploy:** the contract is created with a list of invited members, a fixed contribution, a round duration and a DAO. The account has no access keys, so nobody can replace its code.
2. **Join:** every invited member calls `join`. Join order sets the rotation, so the first to join wins round 0. The last join starts the first round's deadline.
3. **Pay:** each member calls `contribute` with the exact amount, once per round, before the deadline. The last payment of a round sends the pot to the winner in the same call.
4. **Finish:** the circle ends after every member has had a turn, or closes early if a round misses its deadline.

The contract holds the money, not the DAO. Automatic payouts need no vote, which is impossible if the DAO holds the funds.

### Early withdrawals

A request is a `FunctionCall` proposal on the DAO that calls `execute_early_withdrawal(recipient, amount, round)` on the circle. The circle only accepts that call from the DAO account, so the DAO's voting rules decide it.

An early withdrawal is an advance on the recipient's own money, so nobody comes out ahead.

- The money comes out of the current round's pot, so that round's winner receives less at first.
- Every member must approve, including that round's winner.
- If the recipient is not the winner, they now owe the winner that amount. The debt comes out of the recipient's own later payout or reclaim and goes to the winner. `get_circle` lists open debts.
- The recipient must be a circle member who has paid this round and whose turn has not passed. They can take at most one contribution per round. Together, these rules mean their own later payout always covers what they owe.
- `round` must be the current round, so a late approval cannot take money from a later round.
- If nobody approves in time, the proposal expires and nothing moves. A pending request never blocks the rotation.
- An approval that lands after the round's deadline moves no money, and the proposer gets the 0.1 NEAR bond back. See [Approvals after the deadline](#approvals-after-the-deadline).

### Round deadlines

Each round has a deadline, set by `round_duration_sec` at deployment. For a monthly circle, use `2592000` (30 days).

- Deadlines follow a fixed schedule: each one is exactly one round after the last. A round that is fully paid early pays its winner straight away, and the next deadline does not move.
- If a round is not fully paid by its deadline, the circle closes for good. This happens by itself on the chain's clock, and `get_circle` then reports the phase as `Closed`.
- After that, no payments or early withdrawals are accepted. Each member who paid that round calls `reclaim` once.
- A member gets back their contribution, less anything they withdrew early in that round. Anything they still owe from an earlier round goes to the member they owe first.
- Later rounds never run, and earlier rounds are not reversed.

### Approvals after the deadline

Sputnik keeps the proposer's bond when a proposal's call fails and returns it when the call succeeds. So after a missed deadline, `execute_early_withdrawal` pays nothing but returns normally, and the proposer gets the bond back.

The proposal therefore shows as `Approved` even though no money moved. To tell the two apart, read the `early_withdrawal_refused` log line or the pot, not the proposal status. A frontend must do this too.

If a payout's transfer fails, for example because the account was deleted, the round still moves on and the recipient can collect the money with `claim`.

## Run it

These commands use testnet only and were tested on Node.js 24 and Rust 1.99.

```bash
npm install
npm run accounts       # creates 3 member accounts and 1 non-member from the testnet faucet
npm run dao            # creates the DAO and checks its policy on chain
npm run test:vote      # step 1: Transfer proposal at 2 of 3, then 3 of 3 votes
npm run contract:build # builds contract/target/wasm32-unknown-unknown/release/ajo_circle.wasm
npm run test:circle -- window   # step 2: runs one scenario. Name one or more, or `all` for the full suite
npm run cleanup -- --to <your-account.testnet>   # shows what would be deleted
```

- Private keys are generated locally in `.keys/`, which is gitignored. Never commit that folder.
- `deployments/` holds the DAO names and the last test results.
- The scenarios are `rules`, `main`, `silence`, `payout`, `late`, `window`, `debt` and `idle`. With no name, nothing runs.
- Each scenario deploys a contract at 2 NEAR, and that money cannot be recovered. The full suite deploys 7. A new faucet account is requested whenever the deployer runs low. The first `silence` run also spends 6 NEAR on a test DAO with a 150 second voting period, which later runs reuse.

### Cleanup

`npm run cleanup -- --to <your-account.testnet>` lists the member, non-member and deployer accounts with saved keys, and their balances. It changes nothing until you add `--execute`. It then deletes those accounts and sends their balances to your account, which cannot be undone.

- Deleting the members retires both DAOs. Run `npm run accounts` and `npm run dao` before testing again.
- Circle contracts and DAOs have no access keys, so their balances cannot be recovered.

### Building on Windows

Use the `stable-x86_64-pc-windows-gnu` Rust toolchain with the `wasm32-unknown-unknown` target. `contract/.cargo/config.toml` holds two required settings:

- `--cfg near` makes near-sdk use real NEAR host calls. Without it the contract still deploys, but every error becomes an opaque trap. `cargo-near` sets this for you and plain `cargo` does not.
- The `getrandom` backend setting avoids a `dlltool` failure on this toolchain.

The tests all run on testnet, because near-sdk's local `unit-testing` feature needs a C toolchain that this machine does not have.

## Frontend

`web/` is a single-page dashboard: wallet connection through NEAR Connect, circle stats, payout schedule, transaction history, members, approvals and notifications. **Run demo** walks through a full circle and a missed deadline on testnet, with no wallet, in under 3 minutes.

Nothing on the page is mocked. Circle state comes from the contract and DAO. Past transactions come from FastNEAR's transaction API, because the contract keeps no history. If that API is unavailable, totals show as unknown and the demo still runs. The chain has no list of all circles, so the dashboard lists two real sample circles plus the ones opened in that browser.

```bash
npm run demo:prepare -- 5   # deploys 5 demo runs (20 NEAR, not recoverable), and writes web/.env.local
cd web
npm install
npm test                    # real-outcome logic
npm run dev                 # http://localhost:5173
```

- **Keys:** the demo's keys are server-only environment variables (`DEMO_KEY_M1`, `DEMO_KEY_M2`, `DEMO_KEY_M3`), read by `web/api/demo.js`. That function signs only the fixed steps in `web/src/demo-steps.js`, on the circles in `web/src/demo-config.js`. Never give these variables a `VITE_` prefix, because Vite copies those into the public page.
- **Deploying:** create a Vercel project with `web` as its root directory, and set the three keys in its environment variables.
- **Withdrawal outcomes:** a proposal's status does not say whether money moved. The page reads the circle's own log line from the vote's transaction, through the history API or this browser's own votes. If neither is available, it shows "Not confirmed" rather than guessing.
- **Demo runs are used up:** each run takes two fresh circles. Run `npm run demo:prepare` again to add more, which also drops used ones. An interrupted run's circles are not reused.
- **Cleanup deletes the demo accounts:** do not run `npm run cleanup` while the demo needs to work.

## DAO policy

| Setting | Value |
| --- | --- |
| Roles | One `members` group. Non-members cannot file proposals or vote. |
| Threshold for every proposal kind | 100% of members |
| Proposal period | 72 hours |
| Proposal bond | 0.1 NEAR, returned when a proposal is approved and runs, or expires and is finalized |

The default threshold is also 100% because thresholds are set per proposal kind. If only `transfer` were 100%, two members could use a 50% proposal to remove the third member, then approve withdrawals without them.

## Known limits

- **A winner who leaves without paying is not recovered.** The deadline only returns the current round's money, and the debt rules only cover early withdrawals. For example, in a 3 member circle with a 0.1 NEAR contribution, if the round 0 winner stops paying in round 1, they stay 0.2 NEAR up, and the member who never had a turn stays 0.1 NEAR down. There is no collateral or penalty.
- **A debt can go unpaid if the circle closes early.** If a recipient skips the closing round, or never calls `reclaim`, the winner they owe stays short. The recipient is not ahead, because they have paid in at least what they withdrew.
- **Other refused approvals still cost the bond.** If the circle refuses a fully approved request before the deadline, for example because the amount is too large, the proposal ends `Failed` and Sputnik keeps the 0.1 NEAR. The frontend should check these rules before anyone files a proposal.
- **One missed deadline ends the circle for everyone.** There is no grace period or extension, and nobody can remove the member who missed it and carry on.
- **A circle can wait forever for members to join.** The first deadline starts only when everyone has joined. No money is at risk, because payments start after that.
- **The factory owner can currently change the DAO's code.** New DAOs start with `auto_update: true`, which lets the owner of `sputnikv2.testnet` update them. A changed DAO could trigger withdrawals, though the circle would still only pay members, from the current pot. A `FactoryInfoUpdate` proposal setting `auto_update: false` should turn this off, but that has not been tested here.
- **The contract cannot check that the DAO's members match the circle's.** Deploy scripts must check this, as `npm run test:circle` does.
- **The contract cannot be fixed after deployment.** It has no keys, so a bug means deploying a new circle.
- **A vote after expiry costs the proposer their 0.1 NEAR bond.** It marks the proposal `Expired`, and `Finalize` then refuses it, so the bond stays in the DAO. Finalize expired proposals instead of voting on them.

- **The demo endpoint is public.** It only signs the fixed demo steps, but anyone can call it repeatedly, which could use up the demo circles or spend the demo accounts' testnet NEAR on proposal bonds. It has no rate limiting.

## Future work

- **Collateral:** members lock a deposit when they join, and a member who stops paying after their turn loses it to the members they owe. This is the fix for a winner who leaves without paying. It also raises the cost of joining, so it is left out for now.
