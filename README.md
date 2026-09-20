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
- **`keeper/`**: the daemons a live market needs. An oracle keeper that
  publishes prices and sessions off a real NYSE calendar, a funding crank, a
  liquidator, and a corporate-action watcher. Without them a deployment is a
  set of accounts nobody can mark or liquidate against.
- **`pipeline/`**: turns the registry's modelled dataset into a live one. Mint
  authorities and extensions from `getAccountInfo`, exit depth from a ladder of
  real Jupiter quotes, and prerendered HTML so the pages are indexable.
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
| Program ID | `A2WJAgqLpcZSkyqHu1cJA62gANDjiYx7M5Qyz9kZdoH3` (rotated; the original key's secret was in git history) |
| Rust unit tests (`cargo test --lib`) | **129 passing**: PnL, funding, margin, liquidation, sessions, splits, dividends, treasury hedging, pool NAV and the loss waterfall |
| DBC tests (`npm run test:dbc`) | **37 passing**, against the real Meteora SDK, no network |
| Keeper and pipeline tests (`npm run keeper:test`) | **88 passing**: the NYSE calendar to the minute across holidays and both DST transitions, liquidation health, mint parsing, the depth ladder, and the live-snapshot fallbacks |
| App tests (`npm run app:test`) | **104 passing**: the read model against the Rust, the registry's scoring, every instruction's account list against the IDL, and the glass and grid rules that two measured layout bugs came in through |
| Integration tests (`anchor test`) | **25 written, 24 executed and passing** on a contributor machine, covering the pool, splits, dividends, insurance, session gating, a real liquidation and the bad-debt waterfall. The 25th was added after that run. Not runnable in the authoring environment, which has no Solana toolchain |
| Interface audit | **clean** across 6 screens x 3 widths x 2 themes: no overflow, clipping, contrast failure or undersized touch target |
| IDL (`npm run idl`) | **generated**: 26 instructions, committed under `idl/` |
| `clippy -D warnings`, `cargo fmt`, `tsc`, prettier | **clean** |
| `anchor build` | **succeeds** on a contributor machine; not runnable in the authoring environment |
| Local deployment | **done**: `anchor deploy` to a local validator, seeded by `npm run seed` |
| Devnet / mainnet deployment | **not done**: needs a funded wallet |

The lockfile has been resolved and audited against the exact rustc that
`anchor build` uses, so the dependency wall that was blocking the build is
fixed. The SBF build and the integration suite have since been run on a
machine with the toolchain, and they earned their keep immediately: the suite
found a silent SBF stack-frame overflow that was corrupting instruction
arguments, and a liquidation path that never settled the trader's PnL against
the liquidity pool. Both are fixed and covered. See `docs/FEASIBILITY.md` for
what the suite has *not* resolved.

**Read [`BUILD.md`](BUILD.md) first** if `anchor build` is failing. It also
records the program keypair rotation: the original key's secret was committed
to git history, so it was replaced and the old ID is burned.

## Running a live market

A deployment needs four daemons. They are all permissionless except the oracle:

```bash
KEEPER_KEYPAIR=./keeper.json RPC_URL=https://api.devnet.solana.com \
POLYGON_API_KEY=... QUOTE_MINT=<mint> npm run keeper
```

That publishes prices and sessions off a real NYSE calendar, cranks funding,
liquidates underwater positions, and applies splits and dividends on their
ex-date. With no price provider and a local RPC it runs a simulated feed and
says so; with a non-local RPC it refuses to start rather than publishing
invented prices to a real market. See [`keeper/README.md`](keeper/README.md).

The registry's live data comes from a separate pipeline, run on a schedule:

```bash
npm run registry:build        # app/public/registry.json
npm run registry:prerender    # indexable HTML per token, plus a sitemap
```

See [`pipeline/README.md`](pipeline/README.md).

## Reading a chain

The interface ships reading an in-memory source, which needs no chain and is
what `npm run app:dev` starts. Point it at a deployment by copying
`app/.env.example` to `app/.env` and setting:

```bash
VITE_DATA_SOURCE=rpc
VITE_CLUSTER=devnet
VITE_RPC_URL=https://your-provider.example/rpc   # the public endpoints are rate limited
```

Nothing else changes: `DataSource` is one interface with two implementations,
and no screen knows which one it is reading. The chain-backed one is imported
lazily, so a visitor who only reads the registry never downloads a signing
library.

Transactions are built in `app/src/lib/protocol/tx/`. Every instruction's
account list is checked against the generated IDL by a unit test, because those
lists are written positionally by hand against Rust structs and a reordered
field would otherwise address the wrong accounts silently.

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

Run the interface against a real chain rather than the mock data:

```bash
solana-test-validator --reset     # terminal one
anchor deploy                     # terminal two
npm run seed -- --write-env       # config, five markets, pools, open positions
npm run app:dev
```

`npm run seed` is idempotent: every step checks whether its account already
exists, so a re-run after a partial failure resumes instead of starting over,
and the quote mint is derived from a fixed seed so a second run reuses the
first run's token. The wallet you connect in the browser is not the wallet
that ran the script, so fund it too:

```bash
npm run seed -- --airdrop <your browser wallet pubkey>
```

Talk to the assistant (needs an Anthropic key, which stays server side):

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # never VITE_-prefixed: that ships it
npm run assistant                      # prints the VITE_ASSISTANT_URL to set
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
- `target/` was committed, including the program keypair: the **secret key**
  for the declared program ID. Removed, gitignored, and the key has since been
  rotated. The old ID `8KwHVevdqvNrwTCgsTvwQzvWXNsdonHKCi9mrH6gN23x` is burned; see `BUILD.md`.

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
  underwater before any liquidator can act. Fees capitalise insurance and
  `deposit_insurance` lets anyone pay into it directly, which together make
  the fund fundable; neither makes it large enough by itself.
- **The oracle is one trusted key.** Bounded by staleness, confidence, a
  per-update deviation cap, and now a session state, but not removed. Swap in
  Pyth before anything holds value.
- **Mergers and delistings are unhandled.** Splits and cash dividends are,
  both through the same cumulative-index mechanism.
- **The bad-debt liquidation bounty is empty when it is needed.** It is paid
  out of the insurance fund *after* the shortfall has drawn that fund down, so
  it is funded for the small losses that do not need it and zero for the large
  ones that do. Written up as `docs/FEASIBILITY.md` section 6; left as-is
  because changing it changes who gets paid in a liquidation.
- **DBC migration cannot be oracle-gated.** Graduation is permissionless with no
  oracle hook, so it can fire while the underlying is shut. The monitor warns;
  nothing can enforce.
- **Nothing is deployed beyond a local validator.** The build, the suite and
  the seeded interface all run there; devnet and mainnet do not.

## Next steps

1. **Purge the leaked keypair from git history before publishing this
   repository.** The program ID it belonged to is burned and rotated, so
   nothing is at risk today, but the secret is still recoverable from one blob
   in the history and publishing would ship a private key:
   `git filter-repo --path target/deploy/perp_engine-keypair.json --invert-paths`.
2. Deploy to devnet and point the interface at it.
3. Swap the keeper oracle for Pyth, and run a session keeper on a real market
   calendar.
4. Run the funding crank and a liquidator, without which the loss waterfall is
   theoretical.
