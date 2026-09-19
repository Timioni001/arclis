# perp_engine

**Treasury infrastructure for agents that raise in tokenized stock.**

An AI agent launches its token on a Meteora Dynamic Bonding Curve quoted in a
tokenized stock — contributors pay in AAPLx, not SOL. That leaves the agent
holding a treasury that is 100% long one company's earnings, which it never
asked for. This repository is what happens next: the treasury holds the stock it
raised and shorts the matching perp, turning a levered bet on one company back
into a stable operating budget that earns funding rather than paying it.

Underneath sits the part nobody builds — an oracle that knows equities close at
4pm, halt on news, and split four-for-one overnight.

Three pieces:

- **`programs/perp_engine/`** — an oracle-priced perpetual futures engine.
  Cash-settled, permissionless to list and to liquidate, with no admin path to
  user funds. Now equity-aware: market sessions, halts, and corporate actions.
- **Agent treasuries** — hold tokenized stock, maintain a delta hedge against
  it, publish an honest NAV per agent token. Rebalancing is permissionless, so
  the hedge survives the agent's own keeper going down.
- **`src/dbc/`** — launch and monitoring tooling for Meteora DBC pools whose
  quote token is a tokenized stock.

See **[`docs/HACKATHON.md`](docs/HACKATHON.md)** for how this maps to each
bounty, and what still needs a mainnet transaction.

Nothing in the program is hardcoded to stocks: `create_market` takes an oracle
account, not a ticker.

## Status

| | |
|---|---|
| Compiles (`cargo check`) | **yes**, clean |
| Rust unit tests (`cargo test --lib`) | **87 passing** — PnL, funding, margin, liquidation, sessions, splits, treasury hedging |
| DBC tests (`npm run test:dbc`) | **37 passing** — against the real Meteora SDK, no network |
| `clippy -D warnings`, `cargo fmt`, `tsc`, prettier | **clean** |
| `anchor build` | **not run here** — no Solana toolchain in the authoring environment |
| `anchor test` | **not run here** — the suite in `tests/` is written but unverified |
| Mainnet deployment | **not done** — needs a funded wallet |

The lockfile has been resolved and audited against the exact rustc that
`anchor build` uses, so the dependency wall that was blocking the build is
fixed. But the SBF build itself and the TypeScript suite have not been executed;
expect the integration tests to need small corrections on first run.

**Read [`BUILD.md`](BUILD.md) first** if `anchor build` is failing — including
the note about rotating the program keypair, whose secret key is in this
repository's git history.

## Quick start

```bash
cargo test --lib      # fast: the on-chain arithmetic, no validator needed
npm install
npm run test:dbc      # DBC launch planning + real SDK config build, no network

anchor build          # the on-chain program (see BUILD.md for toolchain)
anchor test           # integration, against a local validator
```

Plan a stock-quoted launch (read-only, signs nothing):

```bash
npx ts-node scripts/dbc-plan.ts --symbol AAPL --price 250 --vol 0.28 \
    --initial-fdv 5000 --migration-fdv 50000 --session closed
```

## Layout

```
programs/perp_engine/src/
  lib.rs              entrypoint; one thin forward per instruction
  constants.rs        fixed-point scales and every protocol bound
  errors.rs           error surface
  events.rs           emitted logs
  math/               pure arithmetic — no accounts, no Clock, no CPI
    fixed.rs            checked mul_div, floor division, narrowing casts
    pnl.rs              notional, PnL, funding owed, equity, margin, fees
    funding.rs          skew, funding rate, index delta
    liquidation.rs      the liquidation waterfall
    session.rs          trading hours and halts: what a frozen price may be used for
    corporate_actions.rs  splits, via lazy per-position normalisation
    treasury.rs         delta, target hedge, rebalance sizing, NAV per token
  state/              account layouts, one file each
    global_config.rs    authority + kill switch
    oracle.rs           keeper-fed price: staleness, confidence, deviation, session, splits
    market.rs           risk config, funding, open interest, solvency accounting
    position.rs         per-trader, per-market
    treasury.rs         an agent's balance sheet
  instructions/       guards, then math, then writes, then an event
    guards.rs           pause/authority checks and `sync_position`, in one place
    admin.rs            the complete list of what an authority can do
    corporate_action.rs splits, applied atomically across oracle and market
    treasury.rs         open, fund, hedge, draw
    ...

src/dbc/              Meteora DBC tooling for stock-quoted pools
  plan.ts             USD↔share conversion, drift band, fee schedule, activation advice
  curve.ts            turns a reviewed plan into Meteora ConfigParameters
  monitor.ts          live pool health against the underlying

docs/
  HACKATHON.md        what maps to which bounty, and what still needs mainnet
  FEASIBILITY.md      is this idea viable? (the honest answer)
  NAMING.md           on changing the project name
scripts/
  dbc-plan.ts         print and validate a launch plan
  dbc-monitor.ts      watch a live pool
  audit_msrv.py       guards the lockfile fix; runs in CI
```

The arithmetic is deliberately isolated in `math/`. Nothing there touches an
account or a sysvar, which is why the interesting half of a perp engine can be
tested in under a second with plain `cargo test`.

## Design choices, and what they cost

**Cash-settled against an oracle. No AMM, no order book.** Mark price *is* the
oracle price. This removes an enormous amount of scope — no slippage curve, no
liquidity depth, no matching — at two real costs. There is no independent mark
price, so funding cannot come from a mark-vs-index premium; it comes from
open-interest skew instead (see `math/funding.rs`). And there is no
counterparty, which is the structural problem described in
[`docs/FEASIBILITY.md`](docs/FEASIBILITY.md) §1 and the most important thing to
fix next.

**Program-owned custody.** No instruction anywhere moves value from a market
vault to an address the authority chooses. Every outbound transfer is
margin-checked (`withdraw_collateral`) or liquidation-checked and permissionless
(`liquidate`). `instructions/admin.rs` is the complete list of authority
powers: two pause flags. That is the concrete claim behind "secure", and it is
short enough to verify by reading.

**Permissionless listing, funding, and liquidation.** Anyone can create a market
over an existing oracle, crank funding once an interval elapses, or liquidate an
undercollateralised position for a penalty share. No part of the protocol
depends on one keeper staying online. Because listing is permissionless,
`MarketParams::validate` is strict — those bounds are the only thing between a
trader and a market configured to be unsurvivable.

**Isolated margin.** Position PDAs are seeded by market, so a blow-up in one
market cannot reach a trader's collateral in another. Less capital-efficient
than cross-margin; the right default while the solvency model is unproven.

## What changed from the first draft

The original was described by its own README as "correct on paper, never
compiled". It did not compile, and several things were wrong beyond that.

**Build**
- `Cargo.lock` pulled `toml_edit 0.25` (edition 2024, needs rustc 1.85) through
  `anchor-lang → borsh → proc-macro-crate`, which the rustc 1.75 bundled in
  Solana 1.18 platform-tools cannot parse. Lock re-resolved against 1.75 and all
  251 crates audited. See [`BUILD.md`](BUILD.md).
- Lockfile was v4; Cargo 1.75 only reads v3. Now v3.
- Four compile errors from `.ok_or(PerpError::X)` in tail position, where Anchor
  needs `Error` rather than `PerpError`.
- `declare_id!` held Anchor's default placeholder and disagreed with
  `Anchor.toml`. Reconciled.
- `target/` was committed, including `perp_engine-keypair.json` — the **secret
  key** for the declared program ID. Removed and gitignored; rotation
  instructions in `BUILD.md`.

**Correctness**
- **Funding ignored the price.** The index was a bare rate, so
  `funding_owed = size × rate` charged a $200 asset exactly what it charged a
  $1 asset. The index is now denominated in quote-per-base, which is why
  `crank_funding` takes an oracle account it previously did not have.
- **The vault had no solvency model.** Profit was credited to collateral from
  nothing and paid out of other traders' deposits with no balance check.
  `Market` now tracks `total_collateral`, `insurance_balance`, and `bad_debt`,
  and payouts are checked against the vault's real balance. This makes
  insolvency visible and bounded — it does not make the design solvent, which
  needs an LP counterparty.
- **Liquidation floored negative equity at zero**, silently handing the
  shortfall to other traders. Replaced with an explicit waterfall
  (`math/liquidation.rs`) that partitions every unit into trader / liquidator /
  insurance / recorded bad debt, with the partition asserted in tests.
- **Nobody would liquidate an underwater position** — the reward was a share of
  equity that no longer existed. A small insurance-funded bounty now covers
  exactly that case.
- **`GlobalConfig.paused` was never checked anywhere.** Now enforced through
  `guards.rs`. Liquidation deliberately ignores the *market* pause, so pausing
  cannot trap the vault with positions it may not close.
- **`fee_bps` was stored but never charged**, so the insurance fund had no
  funding source at all. Now charged on open and close, into insurance.
- **The leverage check used raw collateral**, ignoring unrealised PnL and
  unsettled funding — a position deep in the red could add to itself and land
  below maintenance margin in the same instruction. Now an equity-based initial
  margin check, run on final state.
- Oracle `confidence` was stored and ignored; added a confidence bound and a
  per-update deviation cap.
- Added open-interest and skew caps, a minimum position size (positions too
  small to be worth liquidating become permanent bad debt), and events on every
  state change.

**Structure**
- `state.rs` held four account layouts *and* all the arithmetic. Split into
  `state/` (one file per account) and `math/` (pure, unit-tested).
- Account sizes were hand-summed constants; now derived via `InitSpace`.
- `create_market` took three loose arguments and now configures nine risk knobs
  through a named `MarketParams` struct.
- Added `tests/`, `package.json`, `tsconfig.json`, `.gitignore`, CI, and
  `scripts/audit_msrv.py` — `Anchor.toml`'s test script previously pointed at
  files that did not exist.

## Known gaps

Listed plainly, because a judge will find them anyway:

- **No counterparty pool.** Still the single most important thing to build next.
  A cash-settled perp with no AMM or order book needs winners' profits to be
  funded by losers' losses, and nothing enforces that. Insolvency is now
  *visible and bounded* (`Market::total_collateral`, `bad_debt`, vault balance
  checks) rather than silent — that is not the same as solved.
  `docs/FEASIBILITY.md` §1.
- **A weekend gap will outrun the insurance fund.** Sessions stop anyone opening
  against a frozen price, but a Friday-to-Monday gap still puts leveraged longs
  underwater before any liquidator can act. Fees now capitalise insurance;
  there is still no instruction to pay into it directly.
- **The oracle is one trusted key.** Bounded by staleness, confidence, a
  per-update deviation cap, and now a session state — but not removed. Swap in
  Pyth before anything holds value.
- **Dividends, mergers and delistings are unhandled.** Only splits are.
- **DBC migration cannot be oracle-gated.** Graduation is permissionless with no
  oracle hook, so it can fire while the underlying is shut. The monitor warns;
  nothing can enforce.
- **`anchor build` and `anchor test` are unverified here**, and nothing is
  deployed.

## Next steps

1. `anchor build`, then `anchor test`; fix what the integration suite surfaces.
2. Rotate the program keypair (`BUILD.md`) — its secret key is in git history.
3. Add the LP counterparty vault.
4. Add an instruction to capitalise the insurance fund directly.
5. Swap the keeper oracle for Pyth.
6. Handle dividends alongside splits.
