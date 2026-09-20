# Arclis

**On-chain access to public markets.**

> **Two hundred thousand people on Solana hold tokenized equities. Most of
> them cannot tell you what they actually own, and the ones who can still
> cannot trade it like a stock.** Arclis fixes both halves.

Every DeFi primitive on Solana assumes four things: the asset trades
continuously, its price always exists, its supply is never restated, and someone
is on the other side. A stock violates all four: it trades 19% of the week,
halts on news, splits four-for-one overnight, pays a dividend that drops its own
price on the ex-date, and has no counterparty unless one is funded.

None of those failures show up in a demo. They show up at 4pm on a Friday, on an
ex-date, or the first time a market goes one-way.

See all three in thirty seconds, with nothing installed but Rust:

```bash
cargo run --example stock_hazards
```

The full argument is in **[`docs/PITCH.md`](docs/PITCH.md)**.

Arclis is that layer, and a registry that tells you what you are holding before
you act on it. The first thing built on top is an agent treasury: an AI
agent launches its token on a Meteora Dynamic Bonding Curve quoted in a
tokenized stock, contributors pay in AAPLx rather than SOL, and the treasury
that results (100% long one company's earnings, which nobody chose) is hedged
back into a stable operating budget that earns funding instead of paying it.

Six pieces:

- **`programs/arclis/`**: an oracle-priced perpetual futures engine.
  Cash-settled, permissionless to list and to liquidate, with no admin path to
  user funds. Equity-aware: market sessions, halts, splits and cash dividends.
- **Liquidity pool**: the counterparty. LPs take the other side of net open
  interest and are paid in fees, funding and trader losses for it. This is what
  makes a winning trade payable from something other than another trader's
  deposit.
- **Agent treasuries**: hold tokenized stock, maintain a delta hedge against
  it, publish an honest NAV per agent token. Rebalancing is permissionless, so
  the hedge survives the agent's own keeper going down.
- **`src/dbc/`**: launch and monitoring tooling for Meteora DBC pools whose
  quote token is a tokenized stock.
- **Accounts**: connect any Wallet Standard wallet, or create a passkey
  account: an Ed25519 key generated in the browser and encrypted with a secret
  only your Face ID, Touch ID or device PIN can reproduce. No seed phrase, no
  password, and nothing custodial. See `app/src/lib/auth/passkey.ts`.
- **Registry**: a public lookup for tokenized equities. Four issuers are
  shipping products on Solana that render as an identical price chart and are
  not the same instrument: a redeemable claim on a share, a note against
  custody you cannot reach, a tracker holding nothing. The registry puts the
  legal structure, custody, redemption rights, mint authorities, live NAV
  deviation and real exit depth for each one on a single page. No wallet, no
  sign-in, no execution, and nothing it reports is for sale.
- **`app/`**: the interface. React + TypeScript, built to
  [`DESIGN.md`](DESIGN.md), with the read-model maths ported from Rust and
  cross-checked against it.

Start with **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** if you are
building against this, every account, instruction and PDA seed, plus the read
model a frontend needs. **[`docs/HACKATHON.md`](docs/HACKATHON.md)** maps the
work to each bounty and says what still needs a mainnet transaction.

Nothing in the program is hardcoded to stocks: `create_market` takes an oracle
account, not a ticker.

## Status

| | |
|---|---|
| Compiles (`cargo check`) | **yes**, clean |
| Rust unit tests (`cargo test --lib`) | **127 passing**: PnL, funding, margin, liquidation, sessions, splits, dividends, treasury hedging, pool NAV and the loss waterfall |
| DBC tests (`npm run test:dbc`) | **37 passing**, against the real Meteora SDK, no network |
| App tests (`npm run app:test`) | **66 passing**: the TypeScript read model against the Rust, plus the registry's scoring |
| Interface audit | **clean** across 6 screens x 3 widths x 2 themes: no overflow, clipping, contrast failure or undersized touch target |
| IDL (`npm run idl`) | **generated**: 26 instructions, committed under `idl/` |
| `clippy -D warnings`, `cargo fmt`, `tsc`, prettier | **clean** |
| `anchor build` | **not run here**: no Solana toolchain in the authoring environment |
| `anchor test` | **not run here**: the suite in `tests/` is written but unverified |
| Mainnet deployment | **not done**: needs a funded wallet |

The lockfile has been resolved and audited against the exact rustc that
`anchor build` uses, so the dependency wall that was blocking the build is
fixed. But the SBF build itself and the TypeScript suite have not been executed;
expect the integration tests to need small corrections on first run.

**Read [`BUILD.md`](BUILD.md) first** if `anchor build` is failing, including
the note about rotating the program keypair, whose secret key is in this
repository's git history.

## Quick start

**New here, or not a developer?** Read
**[`QUICKSTART.md`](QUICKSTART.md)**. It installs the toolchain with one
script and checks everything with one more.

For everyone else:

```bash
bash scripts/setup-ubuntu.sh   # one-time toolchain install (Ubuntu/Debian)
bash scripts/verify.sh         # runs all four levels, prints a summary

cargo test --lib      # fast: the on-chain arithmetic, no validator needed
npm install
npm run test:dbc      # DBC launch planning + real SDK config build, no network

npm --prefix app install
npm run app:dev       # the interface, at http://localhost:5173
npm run app:test      # read-model maths, cross-checked against the Rust

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
programs/arclis/src/
  lib.rs              entrypoint; one thin forward per instruction
  constants.rs        fixed-point scales and every protocol bound
  errors.rs           error surface
  events.rs           emitted logs
  math/               pure arithmetic: no accounts, no Clock, no CPI
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
oracle price. This removes an enormous amount of scope, no slippage curve, no
liquidity depth, no matching, at two real costs. There is no independent mark
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
`MarketParams::validate` is strict, those bounds are the only thing between a
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
- `target/` was committed, including `arclis-keypair.json`: the **secret
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
  insolvency visible and bounded, it does not make the design solvent, which
  needs an LP counterparty.
- **Liquidation floored negative equity at zero**, silently handing the
  shortfall to other traders. Replaced with an explicit waterfall
  (`math/liquidation.rs`) that partitions every unit into trader / liquidator /
  insurance / recorded bad debt, with the partition asserted in tests.
- **Nobody would liquidate an underwater position**: the reward was a share of
  equity that no longer existed. A small insurance-funded bounty now covers
  exactly that case.
- **`GlobalConfig.paused` was never checked anywhere.** Now enforced through
  `guards.rs`. Liquidation deliberately ignores the *market* pause, so pausing
  cannot trap the vault with positions it may not close.
- **`fee_bps` was stored but never charged**, so the insurance fund had no
  funding source at all. Now charged on open and close, into insurance.
- **The leverage check used raw collateral**, ignoring unrealised PnL and
  unsettled funding, a position deep in the red could add to itself and land
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
  `scripts/audit_msrv.py`: `Anchor.toml`'s test script previously pointed at
  files that did not exist.

## Known gaps

Listed plainly, because a judge will find them anyway:

- **The pool can still be outrun.** The counterparty pool now exists, and
  `max_utilization_bps` bounds how much exposure it can be made to carry, but
  a large enough adverse move still exhausts insurance, then LP capital, then
  socialises the rest onto `market.bad_debt`. The waterfall makes that visible
  and ordered; it does not make it impossible.
- **A weekend gap will outrun the insurance fund.** Sessions stop anyone opening
  against a frozen price, but a Friday-to-Monday gap still puts leveraged longs
  underwater before any liquidator can act. Fees now capitalise insurance;
  there is still no instruction to pay into it directly.
- **The oracle is one trusted key.** Bounded by staleness, confidence, a
  per-update deviation cap, and now a session state, but not removed. Swap in
  Pyth before anything holds value.
- **Dividends, mergers and delistings are unhandled.** Only splits are.
- **DBC migration cannot be oracle-gated.** Graduation is permissionless with no
  oracle hook, so it can fire while the underlying is shut. The monitor warns;
  nothing can enforce.
- **`anchor build` and `anchor test` are unverified here**, and nothing is
  deployed.

## Next steps

1. `anchor build`, then `anchor test`; fix what the integration suite surfaces.
   **Do this before building more**: the program has never been compiled for
   SBF, and stacking a frontend on top of that means debugging two unknowns.
2. Rotate the program keypair (`BUILD.md`), its secret key is in git history.
3. Add an instruction to capitalise the insurance fund directly.
4. Swap the keeper oracle for Pyth.
5. Handle dividends alongside splits.
