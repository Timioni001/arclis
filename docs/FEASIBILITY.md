# Is this idea feasible?

An honest assessment, separate from whether the code compiles.

> **Revised after the hackathon scope was set.** An earlier version of this
> document recommended abandoning tokenized equities and pointing the engine at
> crypto perps. That recommendation assumed the choice of underlying was open.
> It is not: the bounties are specifically about tokenized stocks. More
> importantly, one of the arguments behind it was wrong in a way worth stating
> plainly, the product now has a **spot** leg (a DBC pool quoted in a tokenized
> stock) as well as a derivative one, and those two carry very different
> regulatory weight. §3 is rewritten accordingly. Sections 1 and 2 were the
> serious objections and both have since been partly addressed in code; they are
> updated to say what is actually fixed and what is not.

Ranked by how likely each is to kill the project, not by how hard each is to
fix.

---

## 1. The counterparty problem, structural, and the code cannot solve it

This is the deepest issue and it is easy to miss, because nothing about it looks
like a bug.

The engine is cash-settled against an oracle. There is no order book and no AMM.
When a long closes at a profit, `close_position` credits that profit to their
collateral and `withdraw_collateral` pays it out of the market vault.

**Where did that money come from?**

It came from the vault, which holds other traders' deposits. For the vault to
stay solvent, winners' profits must be exactly funded by losers' losses, which
requires long and short open interest to be balanced, continuously, at every
price. Nothing makes that true. If a market is 80% long and the price rises, the
longs are collectively owed more than the shorts collectively lost, and the vault
pays the difference out of deposits that belong to somebody else. The last trader
to withdraw finds the transfer failing.

The original code could not even detect this. It has now been made *visible*:
`Market::total_collateral` tracks liabilities, `require_payable` checks the
vault's real balance before every payout, and `Market::bad_debt` records
shortfalls instead of silently consuming deposits. `max_skew_bps` bounds how
one-sided a market can get. **None of that fixes it.** Visible insolvency is
still insolvency; the caps only bound the rate of bleeding.

Every production perp solves this with an explicit counterparty:

| Design | Who takes the other side | Examples |
|---|---|---|
| LP vault | Passive LPs, paid in fees and trader losses | GMX, Jupiter Perps |
| vAMM | Synthetic curve, protocol absorbs imbalance | Perpetual Protocol v1, early Drift |
| Order book | Other traders, matched | Drift v2, Mango, Hyperliquid |

**This is the one change that matters most.** A counterparty LP vault is the
natural fit: LPs deposit quote, the pool is the counterparty to net open
interest, LPs earn the taker fees and funding this engine already collects, and
the insurance accounting already added is the right place to hang it. That is
roughly one new account type and two instructions, a week of work, not a
rewrite, and it converts the protocol from structurally insolvent to merely
risky.

Until then, treat this as a demo that must not hold real money.

## 2. Equities do not trade 24/7, was fatal, now handled

Perpetual futures never expire. Equities close at 4pm ET, and stay closed all
weekend and on holidays. **The underlying has a price roughly 32% of the hours
the perp is live.**

The original engine rejected any price older than 60 seconds, which shut the
market for two-thirds of every week. Refusing to trade on a stale price is
correct; doing it with one global constant is not, and loosening that constant
to cover a weekend would mean liquidating people on Sunday against Friday's
close, which is worse.

**This is now built** (`math::session`, `math::corporate_actions`). The
resolution was to stop asking how old a price is and start asking what the
caller wants to do with it, a frozen close is a fine price for letting someone
*out* of a position and a free option for letting someone *in*. See
`docs/HACKATHON.md` §3 for the full table.

What that closes, and what it does not:

- **Weekend gaps, bounded, not eliminated.** Nobody can open a position against
  a frozen price any more, so the free option is gone. But Friday $100 to Monday
  $80 still puts every leveraged long underwater before a liquidator can act.
  Liquidators clean up after a gap; they cannot prevent one. The gap still
  becomes bad debt rather than a liquidation, the difference is that bad debt
  is now recorded (`Market::bad_debt`) instead of silently consuming someone
  else's deposit. **The insurance fund will be undercapitalised for a real gap.**
  This is the residual risk of the whole design and it is not solved.

- **Splits, handled.** A cumulative split factor on the oracle, with positions
  rescaling themselves lazily. Notional, PnL and unsettled funding are all
  invariant across a split, asserted in tests.

- **Halts, handled.** `MarketSession::Halted` blocks everything, including
  liquidation. That is deliberate: a halted stock has no mark, and liquidating
  against the pre-halt print hands the liquidator a position whose real value
  nobody knows.

- **Dividends, mergers, delistings, still unhandled.** Only splits are
  implemented. A cash dividend mechanically drops the price on the ex-date by
  roughly the dividend, which the engine would read as a real move. For a
  low-yield large cap that is small; for a high-yield name it is not.

## 3. Regulation, and the spot/derivative distinction that matters here

Not legal advice; get counsel before anything touches real money. But the
distinction below is load-bearing for how this project should be shaped, and an
earlier version of this document blurred it.

**The two legs carry different weight.**

A **DBC pool quoted in a tokenized stock** is a spot swap: someone exchanges a
tokenized share they already own for an agent token. The tokenized share itself
is a security and its *issuance* is the regulated act, which is why it is
issued by a licensed issuer and not by this project. Trading one for something
else is an ordinary secondary-market transaction. That is a meaningfully
different posture from creating leveraged exposure out of nothing.

A **cash-settled perpetual on a single equity** is not. In the US it is a
security-based swap, and offering one to anyone who is not an eligible contract
participant, essentially all retail, outside a registered national exchange is
prohibited under Dodd-Frank. It is not a licensing hurdle a startup grows into.

The track record is consistent on the derivative side:

- **Mirror Protocol** (Terra) minted synthetic equities. The SEC charged
  Terraform Labs, treating the mAssets as security-based swaps. Gone.
- **Synthetix** delisted sTSLA and sAAPL in 2021 under regulatory pressure,
  while keeping its crypto and FX synths.
- **Binance stock tokens** launched April 2021 and were withdrawn by July after
  action from German, Italian, Hong Kong and UK regulators.

Two things have shifted since, and both are worth tracking rather than relying
on: tokenized equities have had a genuine resurgence through regulated issuers,
and US derivatives regulators have grown more receptive to perpetual-style
products onshore. Neither has made retail equity perps permissible for US
persons.

**What this means for the shape of the product.** The spot leg, the DBC launch,
the treasury holding tokenized stock, the fee income, is the part that can be
offered broadly. The perp leg is the part that needs care, and the specific use
here is narrower than a retail perp DEX: it is **one entity hedging its own
balance sheet**, not a venue offering leverage to the public. That is a better
position to be in than a general equity perp exchange, and it is still a
derivative on a single name.

Concretely, in descending order of how much it changes the project:

1. **Keep the perp leg restricted to treasury hedging.** Do not market it as a
   retail venue. The hedging use is the defensible one.
2. **Geofence and take counsel on jurisdiction** before opening the perp markets
   to third parties.
3. **The engine is asset-agnostic**: `create_market` takes an oracle, not a
   ticker, so the same code serves commodity, FX or crypto underlyings if the
   equity perp leg proves unworkable. That optionality is architectural and
   already present; it costs nothing to keep.

## 4. The oracle is a single trusted key

`PriceOracle` is written by one authority. Whoever holds that key sets the price
every position in its markets is valued against, which means they can mint
profit for an account they control and liquidate everyone else.

This has been *bounded* rather than removed:

- staleness, so a dead feed cannot be traded against
- a confidence-interval check, so a feed that admits it is uncertain is refused
- `MAX_ORACLE_DEVIATION_BPS`, capping any single update to a 10% move

That last one is the meaningful change: it removes the one-transaction drain. An
attacker with the key must now walk the price across many updates, which is slow
and observable. It is a real reduction in blast radius and it is not a fix.

Swapping in Pyth touches `PriceOracle::validated_price` and the account type in
each `Accounts` struct, the shape is deliberately Pyth's. Do that before any
deployment that holds value.

## 5. Liquidity, and what permissionless listing actually gets you

Permissionless market creation is presented as the feature that makes this a
general engine. It is, but with no LP pool and no order book, creating a market
creates an empty room. There is nothing to trade against but other traders who
happen to want the opposite side at the same moment.

This is the same problem as §1 seen from the demand side, and the same fix
resolves both: an LP vault gives every market a counterparty from the moment it
is listed.

---

## 6. The liquidation bounty is empty when it is needed

Found by finally driving a position into bad debt on chain, in
`tests/arclis.ts`.

When a position closes below zero there is no equity to pay a liquidator
from, so `liquidate` pays a flat bounty out of the insurance fund instead.
The reasoning in the code is sound: without it nobody liquidates an
underwater position, the rational liquidator walks away, and the bad debt
grows. The problem is the order of operations. The shortfall draws the
insurance fund down first, and the bounty is then capped at whatever is
left:

```rust
market.debit_insurance(split.from_insurance)?;      // shortfall, first
// ...
let bounty = market.insurance_balance.min(BAD_DEBT_LIQUIDATION_BOUNTY);
```

So the bounty is funded precisely when it is not needed - a small shortfall
insurance can absorb - and is zero exactly when it is: a loss large enough
to exhaust the fund, which is the case where someone has to be paid to act
fast. The bounty is also `$1`, which does not cover the transaction's own
cost at any congestion, let alone compensate for the risk of racing other
liquidators for it.

This is not a bug in the sense of the code doing something other than what
it says. It is a mechanism that does not hold under the conditions it was
written for. Fixing it properly means funding the bounty from somewhere
that a shortfall does not drain - taking it off the top of the pool's
absorbed amount, or a protocol fee reserve the waterfall never touches -
and sizing it against gas rather than at a round dollar.

Left as-is and documented rather than changed quietly: it alters who gets
paid in a liquidation, and that is an economic decision, not a code
cleanup.

## What is actually good here

Worth being clear, because the list above is long:

- **Cash settlement against an oracle is a legitimate design.** It is how
  several production protocols work. The simplification is real and the cost is
  understood.
- **The custody story is genuinely strong.** There is no instruction anywhere
  that moves value from a vault to an authority-chosen address. `admin.rs` is
  the complete list of what an authority can do: two boolean flags. That claim
  is unusual and it holds up to inspection.
- **Permissionless liquidation and funding** with no privileged keeper is the
  right structure.
- **The engine is asset-agnostic.** The thing that makes the regulatory problem
  solvable, point the same code at a different underlying, is already true of
  the architecture. Only the name says "stock".

## Recommendation

Unchanged in substance from the first version, reordered for the scope that
actually applies:

1. **Add a counterparty LP vault.** Still the single most important thing.
   Without it the protocol cannot pay its winners, and no amount of accounting
   makes that untrue. Everything else is polish by comparison.
2. **Keep the perp leg scoped to treasury hedging** rather than a public venue,
   per §3. This is a positioning decision, and it is cheap now and expensive
   later.
3. **Capitalise the insurance fund before any real weekend.** Fees now flow into
   it, which they did not before, but a single gap will outrun fee accrual on a
   young market. There is still no instruction to pay into it directly, that is
   the most obvious missing piece after the LP vault.
4. **Swap the keeper oracle for Pyth.** The shape is already Pyth's; the swap
   touches `PriceOracle::validated_price` and the account type in each
   `Accounts` struct.
5. **Handle dividends** alongside the splits already implemented.

The honest summary for a judge: the equity-specific infrastructure, sessions,
halts, splits, oracle bounds, is real, tested, and the part most teams skip.
The counterparty gap is real, unsolved, and the reason this must not hold
material size until an LP vault exists.
