# Arclis

**On-chain access to public markets.**

---

## The one-liner

> Tokenized stocks already trade on Solana. They just don't *behave* like
> stocks once they get there. Arclis is the layer that makes them behave.

---

## The thesis

Stocklana is about stocks powered by Solana. The interesting word is **stocks** —
because a stock is not a token, and everything on Solana is built for tokens.

Four assumptions are baked into every Solana primitive ever written:

| Every DeFi primitive assumes… | A stock actually… |
|---|---|
| the asset trades continuously | trades **19% of the week** — 32.5 hours out of 168 |
| a price always exists | **halts** on news, with no mark at all |
| supply and price are never restated | **splits 4-for-1** overnight; goes ex-dividend |
| someone is always on the other side | has no counterparty unless one is funded |

Drop a tokenized AAPL into an AMM, a lending market or a perp engine built for
tokens and it works — right up until 4pm on a Friday, or an ex-date, or the
first time the book goes one-way.

**That is the gap.** Not "can you swap a tokenized stock" — you can, today, in a
weekend. It's whether the thing you built survives contact with how securities
actually behave.

Arclis is the compatibility layer: the oracle, the calendar, the corporate
actions, and the capital that make a security work inside infrastructure
designed for tokens.

---

## See it yourself

```bash
cargo run --example stock_hazards
```

Thirty seconds, no wallet, no validator, no network — just Rust. Every number is
produced by the same functions that run on-chain. Abridged:

### 1. The weekend free option

Friday 16:00, AAPL closes at $250. The perp trades all weekend; the stock does
not. By Sunday, everyone knows where Monday opens.

A naive protocol has one staleness setting, so it either accepts the stale price
(free option: buy Sunday, sell Monday) or rejects it (market shut 81% of the
week, nobody can exit). Arclis asks what you want to *do* with the price:

```
open a long, Sunday      refused  (CannotIncreaseRiskWhileClosed)
close it, Sunday         allowed
close during a halt      refused  (MarketHalted)
```

You cannot take on new risk against a frozen price. You can always get out of
what you hold. **The weekend is not a shutdown.**

### 2. The split that liquidates everyone

A trader is long 10 shares from $200 with $500 of margin. The company splits
4-for-1 and the quoted price becomes $50.

```
                   naive protocol        Arclis
unrealised PnL     -$1,500.00            $0.00
equity             -$1,000.00            $500.00
margin ratio       -20000 bps            2500 bps
                   LIQUIDATED            unchanged
```

Nobody lost a cent in that corporate action. A protocol that only sees a price
sees a 75% crash and liquidates the entire long side of the book.

Solana cannot iterate accounts, so there is no way to walk every position and
rewrite it. Arclis stores a **cumulative split factor** and each position
rescales itself the next time it is touched — provably identical to rewriting
them all, and it rounds once instead of once per split.

### 3. The counterparty nobody funds

100 shares long from $250, no shorts. The stock rises to $275. Traders are up
$2,500. A cash-settled venue with no counterparty pays that out of the vault —
which holds other traders' deposits. **That is not a profit, it's someone else's
collateral.**

Arclis funds an explicit liquidity pool, caps how hard it can be worked, and
amplifies funding by utilisation so the heavy side pays progressively more to
whoever will take the other. When a position does blow through its margin, the
waterfall is insurance → LP capital → socialised, with every unit accounted for
and the socialised part recorded on-chain rather than quietly eaten by whoever
withdraws last.

---

## What's genuinely hard to copy

Four things, each with the evidence attached:

**1. A market calendar as a first-class on-chain primitive.**
`MarketSession` is Open / Closed / PreOpen / Halted, and the rule is not "how
old is this price" but "what are you doing with it". Increasing risk against a
frozen price is a free option; reducing risk against the same price is just
letting someone out. Funding does not accrue while the venue is shut, because
charging for an imbalance nobody can trade out of is a penalty with no lever.
→ `math/session.rs`, 11 tests

**2. Corporate actions without account iteration.**
Cumulative split factor on the oracle, lazy per-position normalisation. Notional,
PnL and unsettled funding are all provably invariant across a split — and lazy
normalisation is *more* precise than eager, because it rounds once rather than
once per split.
→ `math/corporate_actions.rs`, 14 tests

**3. A DBC launch where the quote token is a share.**
Meteora stores thresholds in quote tokens. When the quote token is a share, a
"$50,000 graduation target" is really 200 AAPL — so the dollar goal floats with
the stock. Arclis converts at the oracle, reports the lognormal drift band, and
pins the fee ramp to the **opening bell**: a pool activating while the venue is
shut starts at 4× base and decays to the floor exactly as the market reopens,
pricing the window where the quote is frozen. Dynamic fee sized off the name's
own 2σ daily move, not DBC's 1500bps memecoin default a large cap would never
trigger.
→ `src/dbc/`, 37 tests against Meteora's real SDK

**4. Agent treasuries that hedge their own raise.**
An agent that raises in AAPLx holds a treasury levered to one company's
earnings it never chose. Arclis holds the stock and shorts the matching perp,
turning it into a stable operating budget that *earns* funding while the book is
skewed long. Rebalancing is permissionless, so the hedge survives the agent's
own keeper going down.
→ `math/treasury.rs`, 16 tests

---

## Why Solana specifically

Not decoration — the design needs it:

- **Hedge rebalancing is continuous and small.** A treasury drifts every time
  the stock moves. On a chain with meaningful fees, the rebalance costs more
  than the drift it corrects.
- **Rebalancing and liquidation are permissionless.** That only works if
  cranking is cheap enough that a stranger does it for a share of the spread.
- **The quote asset is already here.** Tokenized equities and Meteora's DBC both
  exist on Solana today. What was missing is the layer between them.

---

## Honest status

| | |
|---|---|
| Rust unit tests | **114 passing** |
| DBC tests, against Meteora's real SDK | **37 passing** |
| `clippy -D warnings`, `fmt`, `tsc`, prettier | clean |
| `anchor build` / `anchor test` | **not run** — no Solana toolchain in the authoring environment |
| Deployed to mainnet | **no** |

"Working code on mainnet beats slides" is the right bar, and this has not
cleared it. What it has: a program that compiles, 151 tests covering every piece
of arithmetic that decides who gets paid, and tooling whose output has been run
end to end.

Known gaps are listed plainly in [`FEASIBILITY.md`](FEASIBILITY.md) — the
biggest is that a weekend gap will outrun the insurance fund, and the pool can
still be exhausted by a large enough adverse move. The waterfall makes that
visible and ordered; it does not make it impossible.

---

## The thirty-second version

Anyone can ship a tokenized-stock swap this weekend. The hard part isn't the
swap — it's that the underlying closes at 4pm, halts on news, splits four-for-one
overnight, and has nobody on the other side.

Arclis handles all four, and you can watch it do so in one command.
