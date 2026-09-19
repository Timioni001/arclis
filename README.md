# perp_engine

A general-purpose, oracle-priced perpetual futures engine for Solana.
Cash-settled, permissionless to list, permissionless to liquidate, with no admin
path to user funds.

Built for the Stocklana hackathon, but not hardcoded to stocks: `create_market`
takes an oracle account, not a ticker. Nothing in the program is
equity-specific.

## Status

| | |
|---|---|
| Compiles (`cargo check`) | **yes**, clean |
| Unit tests (`cargo test --lib`) | **48 passing** — PnL, funding, margin, liquidation |
| `clippy -D warnings`, `cargo fmt` | **clean** |
| `anchor build` | **not run here** — no Solana toolchain in the authoring environment |
| `anchor test` | **not run here** — the suite in `tests/` is written but unverified |

The lockfile has been resolved and audited against the exact rustc that
`anchor build` uses, so the dependency wall that was blocking the build is
fixed. But the SBF build itself and the TypeScript suite have not been executed;
expect the integration tests to need small corrections on first run.

**Read [`BUILD.md`](BUILD.md) first** if `anchor build` is failing — including
the note about rotating the program keypair, whose secret key is in this
repository's git history.

## Quick start

```bash
cargo test --lib     # fast: the arithmetic, no validator needed
anchor build         # the on-chain program (see BUILD.md for toolchain)
anchor test          # integration, against a local validator
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
  state/              account layouts, one file each
    global_config.rs    authority + kill switch
    oracle.rs           keeper-fed price, with staleness/confidence/deviation
    market.rs           risk config, funding, open interest, solvency accounting
    position.rs         per-trader, per-market
  instructions/       guards, then math, then writes, then an event
    guards.rs           the pause and authority checks, in one place
    admin.rs            the complete list of what an authority can do
    ...
docs/
  FEASIBILITY.md      is this idea viable? (the honest answer)
  NAMING.md           on changing the project name
scripts/
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

Still true, and listed plainly:

- **No counterparty pool.** The single most important thing to build next. See
  `docs/FEASIBILITY.md` §1.
- **The oracle is one trusted key.** Bounded by staleness, confidence, and a
  deviation cap, but not removed. Swap in Pyth before anything holds value.
- **No market-hours handling.** Equities trade ~32% of the hours a perp is live;
  weekends, halts, and corporate actions are unhandled. `docs/FEASIBILITY.md` §2.
- **Bad debt is recorded but not recapitalised.** There is no instruction to pay
  into the insurance balance.
- **`anchor build` and `anchor test` are unverified here.**

## Next steps

1. `anchor build`, then `anchor test`; fix what the integration suite surfaces.
2. Rotate the program keypair (`BUILD.md`).
3. Read [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md) before building further —
   it argues for pointing this at crypto perps first, which is a positioning
   decision better made early than late.
4. Add the LP counterparty vault.
5. Swap the keeper oracle for Pyth.
