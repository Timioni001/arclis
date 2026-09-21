# Arclis architecture

*On-chain access to public markets.*

Written for whoever builds the frontend. It covers every account, every
instruction, the PDA seeds, and the read model a UI needs, including the parts
where the UI has to explain something non-obvious to a user.

---

## The shape of it

Four subsystems in one program:

```
Oracle      a price, plus the things equities have that tokens do not:
            trading sessions, halts, and corporate actions
Market      risk parameters, open interest, funding, solvency accounting
Liquidity   the counterparty pool - LPs take the other side of net open interest
Treasury    an agent's balance sheet: holds tokenized stock, hedges it
```

Everything else is off-chain tooling: `src/dbc/` plans and monitors Meteora DBC
pools whose quote token is a tokenized stock.

## Accounts and PDA seeds

| Account | Seeds | One per |
|---|---|---|
| `GlobalConfig` | `["config"]` | protocol |
| `PriceOracle` | `["oracle", symbol[16]]` | symbol |
| `Market` | `["market", oracle]` | oracle |
| market vault | `["vault", market]` | market |
| `Position` | `["position", owner, market]` | trader × market |
| `LiquidityPool` | `["lp_pool", market]` | market |
| LP vault | `["lp_vault", pool]` | pool |
| `LpPosition` | `["lp_position", owner, pool]` | LP × pool |
| `AgentTreasury` | `["treasury", agent_mint]` | agent |
| treasury stock vault | `["treasury_stock", treasury]` | treasury |

Seeds are deliberately generic, the brand is not baked into any address, so a
rename never moves an account.

`Market` carries `cumulative_dividend_index: i128` beside the funding index, and
`Position` carries the matching `entry_dividend_index`. Both rescale on a split,
for the same reason the funding index does: the index is quote-per-base, so if a
base unit splits into four, the amount per unit must quarter or every position's
unsettled dividend quadruples the instant the split lands.

Note `Position` is seeded by *owner*, and an `AgentTreasury` owns its hedge
position. So a treasury's position PDA is `["position", treasury_pda, market]`.
The same margin, funding and liquidation machinery applies to it as to a wallet;
an over-hedged agent gets liquidated like anyone else.

## Numeric conventions

All in `constants.rs`, and getting them wrong is the most common source of bugs
in this kind of program:

| Quantity | Type | Scale | Meaning |
|---|---|---|---|
| base size | `i64` | 1e6 | signed; `+` long, `-` short |
| price | `u64` | 1e6 | quote per base unit |
| quote / USDC | `u64` | 1e6 | matches USDC decimals |
| funding index | `i128` | 1e9 | cumulative quote owed per base unit |
| ratios | `i128` | 1e4 | basis points |
| split factor | `u64` | 1e9 | cumulative shares per original share |

The identity everything depends on:

```
notional_quote = |size| * price / PRICE_SCALE
```

**For the UI:** users type shares and dollars. Convert at the boundary, never in
the middle. A position of `2_500_000` is 2.5 shares.

---

## Instructions

24 total. Grouped by who calls them.

### Protocol authority
- `initialize_global_config(default_fee_bps)`
- `set_protocol_paused(paused)`: global kill switch
- `set_market_paused(paused)`: one market
- `initialize_liquidity_pool(cooldown_secs)`: one per market

That is the complete list of authority powers. **No instruction anywhere moves
value from a vault to an address the authority chooses.** Worth stating in the
UI, because it is unusual and checkable.

### Oracle keeper
- `initialize_price_oracle(symbol, initial_price)`
- `update_price_oracle(price, confidence)`
- `set_market_session(session)`: `Open` / `Closed` / `PreOpen` / `Halted`
- `apply_corporate_action(numerator, denominator)`: splits and reverse splits
- `apply_dividend(per_share)`: cash dividends

### Anyone (permissionless)
- `create_market(params)`: any oracle, strict parameter bounds
- `crank_funding()`: once an interval has elapsed
- `liquidate()`: against an undercollateralised position, for a penalty share
- `rebalance_hedge()`: bring a treasury back to its target hedge
- `deposit_insurance(amount)`: pay into a market's backstop. Permissionless in,
  no way out, and there is deliberately no withdraw counterpart: an insurance
  fund a privileged key can drain is not an insurance fund. A deposit retires
  socialised bad debt before it credits the fund, because the first thing that
  fund owes is the hole.

### Traders
- `deposit_collateral(amount)` / `withdraw_collateral(amount)`
- `open_position(size_delta)`: signed; `+` long, `-` short
- `close_position(reduce_size)`: unsigned; pass full size to close out

### Liquidity providers
- `deposit_liquidity(amount)`
- `request_withdraw_liquidity(shares)`: starts the cooldown
- `cancel_withdraw_liquidity()`
- `withdraw_liquidity()`: settles at NAV *now*

### Agents
- `initialize_treasury(hedge_ratio_bps, rebalance_tolerance_bps)`
- `set_treasury_policy(...)`
- `deposit_stock(amount)` / `withdraw_stock(amount)`

---

## The four things a UI has to explain

These are where users will be confused, and where a good frontend earns its
keep.

### 1. The market is closed, and that means something specific

Not "trading is down". The rule, from `math::session`:

| Session | Open a position, add, or withdraw collateral | Close, reduce, or liquidate |
|---|---|---|
| `Open` | yes | yes |
| `Closed` | **no** | **yes** |
| `PreOpen` | no | no |
| `Halted` | no | no |

Increasing risk against a frozen price is a free option on the next open.
Reducing risk against the same price is just letting someone out. So over a
weekend, **close and reduce stay available and open does not.**

The error is `CannotIncreaseRiskWhileClosed`, distinct from `StaleOracle`, so
the UI can say *"AAPL opens Monday 09:30, you can still close"* rather than
surfacing a generic failure. Read `oracle.session` and render state before the
user picks an action, not after they fail.

Funding does not accrue while closed.

### 2. A split is not a crash

After `apply_corporate_action`, the oracle price drops by the split ratio and
every position rescales. Nobody's PnL moves. If the UI shows a raw price chart
across a split it will look like a 75% crash, read `oracle.split_factor` and
`corporate_action_seq` and normalise historical prices, or annotate the point.

Positions rescale **lazily**, on next touch. So a stale position account may
show a pre-split size until it is next used. Compare
`position.entry_split_factor` against `oracle.split_factor`; if they differ,
apply `size * oracle / position` and `entry_price * position / oracle` for
display.

### 3. A dividend is not a crash either

On the ex-date the share price drops by roughly the dividend, mechanically,
because the buyer no longer receives it. A holder of the actual share is made
whole by the cash. A long on a naive perp is not: they take the price drop and
get nothing back. Run that on a 3% yielder four times a year and being long
costs 3% a year for no reason, while being short earns it. That is a standing
arbitrage against every long in the market, and it is not a rounding error.

`apply_dividend(per_share)` moves one `i128` on the market
(`cumulative_dividend_index`), and every open position settles its own share the
next time it is touched. Longs are credited, shorts pay, and the direction comes
from the sign of each position's size rather than from the instruction. Same
cumulative-index trick as funding and splits, same reason: Solana cannot iterate
position accounts.

The UI should show the credit beside the price drop, because separately they
look like a loss and a windfall, and together they are a wash. The test that
pins this is `the_credit_exactly_offsets_the_ex_date_price_drop`.

Like a split, it is only applied while the venue is shut. Applying it mid-session
would let a position open after the index moved and before the price dropped,
collecting the credit without the drop.

### 4. LP is not a stablecoin vault

The pool takes the other side of net trader open interest. In an Arclis equity
market where agent treasuries are structurally short (they hedge spot holdings),
**the pool ends up structurally long the underlying.**

An LP position is "synthetic long equity, plus fees and funding, minus trader
alpha". That has to be in the deposit flow. Do not describe it as yield.

Two limits also need surfacing:

- **Cooldown.** `request_withdraw_liquidity` starts `pool.cooldown_secs`.
  Shares stay at risk while pending, that is deliberate, and it is what stops
  a run. Settlement is at NAV when it settles, not when it was requested.
- **Free liquidity.** Even a matured request is capped at what the open book
  does not need (`liquidity::max_withdrawable`). A fully utilised pool allows no
  withdrawal at all. Show free vs locked before the user requests, not after.

---

## Read model

What a frontend needs to fetch and derive. All of this is on-chain state plus
pure functions already in the repo.

### Market page
```
oracle.price, oracle.session, oracle.confidence, oracle.last_update_ts
market.open_interest_long / _short        -> skew
market.cumulative_funding_index           -> current funding rate
market.max_leverage, maintenance_margin_bps, initial_margin_bps
market.taker_fee_bps
```
Current funding rate is not stored, derive it with
`funding::funding_rate_bps(skew, sensitivity, utilization)`, or read the last
`FundingAccrued` event, which now carries `utilization_bps` because a rate
without it is misleading.

### Position panel
```
position.size, entry_price, collateral
+ oracle.price -> unrealized_pnl, notional, margin_ratio_bps
+ market.cumulative_funding_index -> funding_owed (unsettled)
liquidation price: solve margin_ratio_bps == maintenance_margin_bps
```
**Always subtract unsettled funding before showing equity.** A position that
looks healthy on collateral alone can be liquidatable once funding is applied.

### LP panel
```
nav            = lp_vault.amount - market.net_trader_pnl(mark)
nav_per_share  = nav / pool.total_shares
your_value     = lp_position.shares * nav_per_share
utilization    = |net_exposure| / nav
free_to_withdraw = liquidity::max_withdrawable(nav, exposure, max_utilization_bps)
pending        = lp_position.pending_shares, cooldown_ends_ts
```

### Treasury panel
```
treasury.stock_qty          -> stock_value at mark
treasury position           -> perp_equity
net_delta                   = stock_qty + perp_size
nav                         = stock_value + perp_equity
nav_per_token               = nav / tokens_outstanding
hedge health                = |net_delta| vs tolerance band
```
`treasury.last_nav_per_token` is a cache refreshed on rebalance. For a live
figure, recompute, the cache can be hours stale in a quiet market.

## Events

Every state change emits. An indexer can reconstruct full history from logs:
`MarketCreated`, `CollateralDeposited/Withdrawn`, `PositionOpened/Closed`,
`FundingAccrued`, `PositionLiquidated`, `SessionChanged`,
`CorporateActionApplied`, `LiquidityPoolInitialized`, `LiquidityDeposited`,
`LiquidityWithdrawRequested`, `LiquidityWithdrawn`, `PoolSettled`,
`TreasuryInitialized`, `TreasuryStockMoved`, `TreasuryHedgeRebalanced`,
`MarketPauseToggled`, `ProtocolPauseToggled`.

`PoolSettled` is the audit trail for where a winning trader's money came from.

## Solvency, end to end

```
trader profit  <- LP pool          (settle_with_pool, on close)
trader loss    -> LP pool
fees           -> market insurance
liquidation penalty -> split: liquidator / insurance

shortfall waterfall:
  1. insurance_balance
  2. LP pool NAV
  3. socialised -> market.bad_debt      (visible, never silent)
```

Two caps bound how much risk the pool can be made to carry:
`max_open_interest` (absolute) and `max_utilization_bps` (exposure over pool
NAV). The second is the real dial. Funding is amplified by utilisation, so a
loaded pool automatically pays more to whoever will unload it.

## Order of operations inside a handler

Every trading instruction follows the same sequence, and the order is not
interchangeable:

1. Guards, pause, authority, account matching
2. Validate the oracle price **for the intended use** (`IncreaseRisk` / `ReduceRisk`)
3. `sync_and_settle`: splits **then** dividends and funding, then move the money
4. Call into `math/`
5. Write state, reconcile market accounting, settle with the pool
6. Emit

Step 3's ordering matters: both dividend and funding settlement multiply size by
an index delta, and all three quantities are in pre-split units. Settling first
would charge against a size that no longer exists.

Step 3 also *moves tokens*, which it did not always. `sync_position` alone
rewrites the position; on its own it would credit a long its dividend and leave
the market vault short by exactly that much. Funding has the same shape: it is
only self-financing when long and short open interest are equal, and they never
are. So `guards::sync_and_settle` reconciles the market's liability total and
transfers the difference to or from the pool, in the same instruction. The
amount moved is read back from the position's collateral rather than taken from
the owed figures, because both settlements saturate at zero when a position
cannot cover the charge, and booking the owed amount would let
`total_collateral` drift above the sum of live positions.

This is why `open_position` and `withdraw_collateral` now carry the pool, the
pool vault and the token program in their account lists.

## Status

| | |
|---|---|
| Rust unit tests | **129 passing** |
| On-chain tests, `anchor test` against a local validator | **25 passing** |
| Interface tests | **130 passing**: read model against the Rust, plus registry scoring |
| Keeper and registry pipeline tests | **88 passing** |
| DBC TypeScript tests | **37 passing**, against the real SDK |
| Interface audit | clean: 6 screens x 3 widths x 2 themes, no overflow, clipping, contrast failure or undersized target |
| `cargo clippy -D warnings`, `cargo fmt`, `tsc --noEmit`, prettier | clean |
| Deployed to devnet | **yes**, `BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP` |
| Mainnet deployment | **not done**: needs a funded wallet |

Before the UI goes anywhere near real money, read [`../BUILD.md`](../BUILD.md) -
the program keypair has been rotated, and the old secret is still in git history.
