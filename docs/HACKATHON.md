# Hackathon submission

Three bounties, one product. This document maps what is in the repository to
what each one asks for, and is explicit about what runs, what is tested, and
what still needs a mainnet transaction.

---

> **Start with [`PITCH.md`](PITCH.md)** for the thesis and the one-command demo.
>
> Project renamed to **Arclis**: *On-chain access to public markets.* The
> program crate is `arclis`; PDA seeds and the program ID are unchanged. See
> [`NAMING.md`](NAMING.md).

## The product in one paragraph

An AI agent launches its token on a Meteora Dynamic Bonding Curve whose **quote
token is a tokenized stock**: contributors pay in AAPLx, not SOL. That is the
stock-paired launch Clawpump asks for, and it leaves the agent with a problem
every launchpad stops short of: a treasury that is 100% long one company's
earnings. An agent that raised the equivalent of $100k to pay for inference now
has a runway that swings with Apple's next quarter, and no view on it.

This repository is the infrastructure for what happens next. The agent's
treasury holds the stock it raised and shorts the matching perp on an
oracle-priced engine in the same program, turning a levered bet on one company
back into a stable operating budget, and, while the perp book is skewed long,
one that *earns* funding rather than paying it. Underneath both sits the part
nobody builds: a price oracle that knows equities stop trading at 4pm, halt on
news, and split four-for-one overnight.

## Why it belongs on Solana

The hedge has to rebalance whenever the stock moves, which is continuously, in
small increments, against a treasury that may hold a few thousand dollars. On
any chain with meaningful fees the rebalance costs more than the drift it
corrects. `rebalance_hedge` is also permissionless, so the hedge survives the
agent's own keeper falling over, that only works if cranking is cheap enough
that a stranger will do it for a share of the spread.

DBC and the tokenized stocks themselves are already here, which is the other
half of the answer: the quote token exists, the launch primitive exists, and
what is missing is the layer between them.

---

## Bounty 1, Stocknized Agent on Clawpump

> *Empower your agents with access to traditional markets and let agents earn
> on RWAs.*
> **Requirement: launch your token with a stock-paired liquidity pool using
> Clawpump and Meteora.**

**What is built.** The full treasury lifecycle, on-chain:

| Instruction | What it does |
|---|---|
| `initialize_treasury` | Opens an agent treasury against an agent mint, a stock mint, and a perp market |
| `deposit_stock` | Sweeps the DBC graduation proceeds in. Permissionless, the raise should never be strandable |
| `rebalance_hedge` | **Permissionless.** Computes the delta gap and moves the perp short to close it |
| `withdraw_stock` | Authority-only draw for operating budget |
| `set_treasury_policy` | Hedge ratio, tolerance band, supply outstanding |

`hedge_ratio_bps` spans fully neutral (10 000) to unhedged (0), so an agent that
*does* want the exposure can keep it. The rebalance tolerance band is what makes
the permissionless crank safe: without it, anyone could correct one lamport of
drift every slot and bleed the treasury through taker fees.

**How agents earn on RWAs.** Three ways, all already implemented: funding
received while the book is skewed long (`math::funding`), DBC trading fees
collected in the quote token so they arrive already denominated in the hedged
asset (`CollectFeeMode.QuoteToken`), and a NAV per agent token that makes the
treasury legible to a buyer, audited quote value of what is actually held,
not a market cap read off a bonding curve.

**Status.** Program compiles clean; the hedging maths carry 16 unit tests
including the central property, a hedged treasury's NAV survives a 20%
drawdown in the underlying while an unhedged one loses 20%.

**What still needs you.** The actual mainnet launch. The requirement is a token
launch with a stock-paired pool, and that needs a funded wallet, a real xStocks
quote mint, and signed transactions. `yarn dbc:plan` produces and validates the
config; creating it is one `client.partner.createConfig()` call away and is
deliberately not automated here.

---

## Bounty 2, Best Use of Meteora DBC

> *Build something on DBC that outlasts the current meme-stock meta … launch
> mechanics tuned for equity-like assets, novel curve or fee configurations,
> creative graduation rules, or tooling that helps issuers configure and
> monitor DBC pools.*

The insight the tooling is built on:

> **DBC stores every threshold in quote tokens. When the quote token is a share,
> the issuer's dollar target is not a target, it is a floating quantity that
> drifts with the stock.**

Launch quoted in USDC and a 50 000-token migration threshold means $50 000,
today and forever. Launch quoted in AAPLx and a 200-token threshold means
$50 000 only while Apple trades at $250. Nothing in DBC or any launchpad UI
surfaces this, because for a USDC-quoted pool there is nothing to surface.

**Three equity-specific configurations** (`src/dbc/`):

1. **A fee ramp pinned to the opening bell.** DBC's fee scheduler decays
   monotonically from activation; it was designed as an anti-sniper ramp and is
   normally set to minutes. Point it at the equity calendar instead. A pool
   activating while the venue is shut starts at 4× the base fee and decays to
   the floor *exactly as the market opens*, so the premium covers precisely the
   window where the quote price is frozen and anyone trading holds a free option
   on the gap. A pool activating mid-session has no gap to price and gets a
   ten-minute ramp instead. `planFeeSchedule`.

2. **A dynamic fee sized off the actual name.** DBC's default trigger is
   1 500 bps, a 15% move. For a memecoin that is a quiet afternoon; for a large
   cap it is a once-in-a-decade day, so the dynamic fee never fires. Size it
   from the stock's own two-sigma daily move instead: a 25%-vol name gets
   ~315 bps, a 60%-vol name ~755 bps. `recommendedMaxPriceChangeBps`.

3. **Oracle-anchored market caps.** The issuer types "$50 000"; DBC needs
   "200 AAPLx". `planStockLaunch` does the conversion and then reports the
   *drift band*, what that fixed share threshold is worth across a one-sigma
   move over the expected fill window, lognormal so the band is correctly
   asymmetric.

**Issuer tooling.**

```bash
yarn dbc:plan    --symbol AAPL --price 250 --vol 0.28 \
                 --initial-fdv 5000 --migration-fdv 50000 --session closed
yarn dbc:monitor --pool <address> --symbol AAPL --price 250 --original-target 50000
```

`dbc:plan` is read-only, it signs nothing, and ends by running Meteora's own
`validateConfigParameters`, so a bad config fails on a laptop rather than inside
a partly-signed mainnet transaction. `dbc:monitor` reports progress in shares,
progress in dollars, and how far the dollar target has drifted since launch. A
monitor that reports only the first will tell an issuer they are 80% of the way
to a $50 000 raise on the day that raise quietly became $41 000.

**Status.** 37 TypeScript tests passing against the real SDK (v1.5.12), no
network required. The generated config passes Meteora's validator. Verified
output is in the transcript of `yarn dbc:plan` above.

**What is honestly *not* enforced.** DBC migration is permissionless and has no
oracle hook, so nothing on-chain can stop a graduation firing while the
underlying is shut and setting the initial DAMM v2 price off a stale quote. The
monitor warns when a pool is above 90% with the venue closed; that is the
strongest thing available and it is advisory, not a guarantee. Claiming
otherwise would be the kind of thing that does not survive a judge reading the
code.

---

## Bounty 3, What to build (tokenized stocks on Solana)

> *Pick one wedge and make it excellent.* Wedge chosen:
> **Infrastructure, price feeds and corporate actions.**

Everything above depends on an oracle that understands equities, and that layer
did not exist here. It does now.

**Market sessions** (`math::session`). A perpetual never expires; equities trade
about 19% of the hours in a week. A single staleness constant cannot express
that, 60 seconds shuts the market every evening, five days lets someone be
liquidated on Sunday against Friday's close. The resolution is to stop asking
"how old is this price?" and start asking **what the caller wants to do with
it**:

| Session | Increase risk | Reduce risk / liquidate |
|---|---|---|
| Open | yes, 60s staleness | yes, 60s |
| Closed | **no** | yes, up to 5 days |
| PreOpen | no | no |
| Halted | no | no |

Increasing risk against a frozen price is a free option on the next open.
Reducing risk against the same price is just letting someone out. The first is
refused while the venue is shut; the second stays available, or traders are
trapped all weekend and the vault carries exposure nobody can close. Funding
accrues only while the venue is open, because charging for an imbalance nobody
can trade out of is a penalty with no lever attached.

**Corporate actions** (`math::corporate_actions`). A 4-for-1 split quarters the
quoted price. An engine that only sees the oracle sees a 75% crash and
liquidates every long in the market for a move that economically did not happen.

The fix cannot iterate positions, there is no account iteration on Solana, so
the oracle carries a **cumulative split factor** and each position records the
factor it was opened at, rescaling itself the next time it is touched. Oracle
price, open interest and the funding index all move in the same transaction, so
there is no window where the book is mispriced by a factor of four.

The tests assert the properties that make this safe: notional invariant, PnL
invariant for longs and shorts, unsettled funding invariant, and lazy
normalisation matching step-by-step rescaling, in fact beating it, since it
rounds once rather than once per split.

**Cash dividends** (`math::corporate_actions`, `apply_dividend`). The same
problem with a different shape, and the one most perp designs simply do not
have, because tokens do not pay dividends. On the ex-date the share price drops
by roughly the dividend, mechanically. A shareholder is made whole by the cash.
A long on a naive perp takes the drop and gets nothing, which on a 3% yielder
paid quarterly is a 3% annual tax on being long and a 3% annual subsidy for
being short. That is a standing arbitrage against every long in the market.

Same cumulative-index mechanism: one `i128` on the market, every position
settles its own share lazily, longs credited and shorts debited from the sign of
their own size. `the_credit_exactly_offsets_the_ex_date_price_drop` pins the
property: five shares long, a $2 dividend, the price drops $2, the $10 mark loss
and the $10 credit net to zero.

**The registry** (`docs/REGISTRY.md`). Infrastructure for the holder rather than
the engine, and the piece that reaches the two hundred thousand people already
holding these tokens rather than the few who will trade a perp on one.

Four issuer families are live on Solana and their products are structurally
different in ways that never surface: a redeemable claim on a custodied share, a
note against an SPV you cannot personally draw on, an exchange IOU where issuer
and custodian are one balance sheet, and a tracker holding nothing. All four
render as an identical price chart. No issuer publishes the comparison, and the
venues have no reason to, since ambiguity keeps volume flowing.

The registry publishes it: claim strength with a component breakdown, live NAV
deviation judged against the reference venue's session, exit liquidity ranked by
**price impact rather than TVL**, exit coverage as pooled liquidity over
circulating value, and what the mint's own authorities let somebody do to your
balance. No wallet, no sign-in, no execution, and no combined score, because
collapsing backing and liquidity into one number is how a transparency product
becomes a league table and a league table is a thing issuers pay to move.

It reuses the session matrix above, which is the point: a 90 bps gap at 2am
Sunday is the reference being frozen, not a mispricing, and flagging it as one
would train people to ignore the flag.

**Accounts without custody** (`app/src/lib/auth/passkey.ts`). Most of those
holders do not have a Solana wallet, and the standard answer is a seed phrase
or a custodial account. Arclis generates an Ed25519 key in the browser and
encrypts it with WebAuthn PRF output, so the wrapping secret is reproducible
only by the user's own Face ID, Touch ID or device PIN. No phrase, no password,
nothing custodial, and no server ever sees the key. Where PRF is unavailable the
flow refuses rather than falling back to an unencrypted key behind a biometric
prompt that protects nothing, and offers wallet connect instead.

---

## What it runs on

Three names appear in the interface footer and each says which part depends on
it, because a "powered by" row that lists logos without saying what they do is a
sponsor wall rather than a dependency list:

- **Solana**: `programs/arclis` is an Anchor program. Markets, positions, the
  liquidity pool, the oracle and the agent treasuries are on-chain accounts.
- **Meteora**: `src/dbc/` builds and monitors Dynamic Bonding Curve configs for
  stock-quoted pools, and Meteora DLMM pools are among the venues the registry
  measures exit depth against.
- **Clawpump**: the launch surface a new stock-quoted market opens through.

## Running it

```bash
cargo test --lib                  # 87 tests: PnL, funding, margin, liquidation,
                                  # sessions, splits, treasury hedging. ~1s, no validator.
npm run test:dbc                  # 37 tests: DBC planning + real SDK config build.
npm run typecheck && npm run lint
anchor build && anchor test       # see BUILD.md first
```

## Honest status

| | |
|---|---|
| `cargo check` / `clippy -D warnings` / `fmt` | clean |
| Rust unit tests | **129 passing** |
| On-chain tests, `anchor test` against a local validator | **25 passing** |
| Interface tests | **130 passing**: read model against the Rust, plus registry scoring |
| Keeper and registry pipeline tests | **88 passing** |
| DBC TypeScript tests | **37 passing**, against the real SDK |
| Interface audit | clean: 6 screens x 3 widths x 2 themes, no overflow, clipping, contrast failure or undersized target |
| `cargo clippy -D warnings`, `cargo fmt`, `tsc --noEmit`, prettier | clean |
| Deployed to devnet | **yes**, `BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP` |
| Mainnet deployment | **not done**: needs a funded wallet |

"Working code on mainnet beats slides" is the right bar and this has not cleared
it. What it has: 409 tests across both languages covering every piece of
arithmetic that decides who gets paid, 25 of which run the real instructions
against a validator rather than a model of one; a program deployed to devnet
with an interface reading it; and tooling whose output has been run and
verified end to end. The gap to mainnet is a funded wallet and an audit, not
unfinished work.

Before deploying anything that holds value, read **[`BUILD.md`](../BUILD.md)** -
including the part about the program keypair rotation, whose old secret is in
this repository's git history.
