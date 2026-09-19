# Is this idea feasible?

An honest assessment of oracle-priced perpetual futures on tokenized equities,
separate from whether the code compiles.

Short version: **the engine is feasible, the specific product is not, and the
gap between them is not a coding problem.** Three obstacles are structural. One
is fatal to the equities framing specifically. The engine itself is worth
keeping — it is the choice of underlying asset that needs to change.

Ranked by how likely each is to kill the project, not by how hard each is to
fix.

---

## 1. The counterparty problem — structural, and the code cannot solve it

This is the deepest issue and it is easy to miss, because nothing about it looks
like a bug.

The engine is cash-settled against an oracle. There is no order book and no AMM.
When a long closes at a profit, `close_position` credits that profit to their
collateral and `withdraw_collateral` pays it out of the market vault.

**Where did that money come from?**

It came from the vault, which holds other traders' deposits. For the vault to
stay solvent, winners' profits must be exactly funded by losers' losses — which
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
roughly one new account type and two instructions — a week of work, not a
rewrite, and it converts the protocol from structurally insolvent to merely
risky.

Until then, treat this as a demo that must not hold real money.

## 2. Equities do not trade 24/7 — fatal to the stocks framing as designed

Perpetual futures never expire. Equities close at 4pm ET, and stay closed all
weekend and on holidays. **The underlying has a price roughly 32% of the hours
the perp is live.**

The engine rejects any price older than 60 seconds
(`MAX_ORACLE_STALENESS_SECS`), so on the current design the market is simply
shut for about two-thirds of every week. That is not a bug — refusing to trade
on a stale price is correct — but it means the product as specified does not
work, and no amount of parameter tuning fixes it. Loosening staleness to cover a
weekend would mean liquidating people on Sunday against Friday's close, which is
worse.

Three specific failure modes underneath it:

- **Weekend gaps.** Friday close $100, Monday open $80. Every leveraged long is
  underwater *before* the first liquidation transaction can land. Liquidators
  cannot prevent a gap, only clean up after it — so the gap becomes bad debt,
  not a liquidation. This is exactly the scenario the insurance fund exists for,
  and it will be undercapitalised for it.

- **Corporate actions.** A 4-for-1 split drops the quoted price 75% overnight.
  With no split handling, the engine liquidates every long in the market for a
  price move that economically did not happen. Dividends, mergers, and
  delistings each need explicit treatment. There is currently none, and
  `MAX_ORACLE_DEVIATION_BPS` would reject the split price as an attack — which
  is safer than the alternative, but still leaves the market permanently stuck.

- **Halts.** A halted stock has no price. Pyth's equity feeds carry a trading
  status flag precisely for this; this oracle has no equivalent.

If the equities framing is kept, the engine needs a market-hours state machine:
scheduled sessions, a defined settlement price at the close, funding that
accrues (or explicitly does not) overnight, and a corporate-actions instruction.
That is a substantial subsystem, comparable in size to everything currently in
`instructions/`.

## 3. Regulation — the reason similar products keep getting shut down

Not legal advice; get counsel before anything touches real money. But the track
record is unusually clear and worth knowing before building further.

A cash-settled contract whose value derives from a single equity is, in the US,
a **security-based swap**. Offering one to anyone who is not an "eligible
contract participant" — which is essentially all retail — outside a registered
national exchange is prohibited under Dodd-Frank. It is not a licensing hurdle
that a startup grows into; it is closer to a prohibition.

The precedents point the same way:

- **Mirror Protocol** (Terra) minted synthetic equities. The SEC charged
  Terraform Labs, treating the mAssets as security-based swaps. The protocol is
  gone.
- **Synthetix** delisted its synthetic equities (sTSLA, sAAPL) in 2021 under
  regulatory pressure, while keeping crypto and FX synths.
- **Binance stock tokens** launched in April 2021 and were withdrawn by July,
  after action from German, Italian, Hong Kong, and UK regulators.

Two things have shifted more recently and are worth tracking rather than relying
on: tokenized equities themselves have had a genuine resurgence through
regulated issuers, and US derivatives regulators have grown more receptive to
perpetual-style products onshore. Neither of those has made *retail equity
perps* permissible for US persons, and the distinction between holding a
tokenized share and trading a leveraged derivative on it is exactly the line
regulators have drawn.

Workable paths, roughly in order of how much they change the project:

1. **Change the underlying.** Crypto, FX, or commodity perps carry nothing like
   this exposure. The engine is already asset-agnostic — `create_market` takes
   an oracle, not a ticker.
2. **Geofence and incorporate offshore.** Real, but expensive, and it caps the
   market you can serve.
3. **Partner with a licensed venue.** Slow; unlikely to be reachable from a
   hackathon build.

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
each `Accounts` struct — the shape is deliberately Pyth's. Do that before any
deployment that holds value.

## 5. Liquidity, and what permissionless listing actually gets you

Permissionless market creation is presented as the feature that makes this a
general engine. It is — but with no LP pool and no order book, creating a market
creates an empty room. There is nothing to trade against but other traders who
happen to want the opposite side at the same moment.

This is the same problem as §1 seen from the demand side, and the same fix
resolves both: an LP vault gives every market a counterparty from the moment it
is listed.

---

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
  solvable — point the same code at a different underlying — is already true of
  the architecture. Only the name says "stock".

## Recommendation

Keep the engine. Change two things, in this order:

1. **Add a counterparty LP vault.** Without it nothing else matters, because the
   protocol cannot pay its winners. Biggest single improvement available.
2. **Point it at crypto perps first.** 24/7 oracles, no market-hours subsystem,
   no security-based-swap exposure. It makes the thing demonstrable end-to-end
   in a way the equities version cannot be.

Then, if tokenized equities are still the goal, add the market-hours and
corporate-actions subsystem and take legal advice on jurisdiction — as a
deliberate second phase, with the engine already proven on an asset class that
does not fight it.

That sequencing also helps the pitch: "a general oracle-priced perp engine,
demonstrated on crypto, designed to extend to tokenized RWAs" is a stronger and
more credible story than a stock perp that halts every Friday at 4pm.
