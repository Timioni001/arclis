# Stocklana perp engine

A general-purpose, oracle-priced perpetual futures engine for Solana. Built
for the Stocklana hackathon, but not hardcoded to stocks: `create_market` is
permissionless, so any oracle-backed asset can be listed.

## Status: written, not yet compiled or tested

This was authored in an environment with no network access, so `anchor build`
/ `anchor test` have not been run against it. Treat this as a correct-on-paper
skeleton, not a verified build. Before the demo, run locally:

```
anchor build
anchor test
```

and fix whatever the compiler flags (Anchor macro edge cases, borrow-checker
details around `ctx.accounts` after a mutable borrow, that kind of thing) —
expect a first pass to need a few small corrections, that's normal.

## Layout

```
programs/perp_engine/src/
  lib.rs                        program entrypoint, wires up all instructions
  state.rs                      accounts + shared math (PnL, margin, funding)
  errors.rs                     custom error enum
  instructions/
    initialize_global_config.rs admin, once
    price_oracle.rs             initialize_price_oracle, update_price_oracle
    create_market.rs            permissionless market listing
    deposit_collateral.rs       init_if_needed position, transfer in
    withdraw_collateral.rs      margin-checked transfer out
    open_position.rs            increase a long or short
    close_position.rs           partial or full close, realizes PnL
    crank_funding.rs            permissionless, skew-based funding accrual
    liquidate.rs                permissionless, reward-capped liquidation
```

## Design choices, and why

- **Cash-settled against an oracle, no AMM/order book.** Mark price = oracle
  price. This cuts a huge amount of scope (no slippage curve, no liquidity
  depth to model) at the cost of not having an independent mark price to
  derive funding from — funding here is skew-based (open interest imbalance)
  instead of mark-vs-oracle premium. Documented in `Market::skew_bps`.
- **Program-owned custody, not team-owned.** There is no admin withdrawal
  instruction anywhere in this program. Every path that moves funds out of a
  vault is either margin-checked (`withdraw_collateral`), settlement-checked
  (`close_position`), or liquidation-checked and permissionless
  (`liquidate`). That is the concrete claim behind "secure": nobody, including
  the deployer, has a button that moves user funds.
- **Permissionless market creation.** `create_market` just needs an existing
  `PriceOracle` account and a few risk parameters within sane bounds. That's
  what makes this a general engine instead of a fixed stock list.
- **Permissionless funding and liquidation cranks.** Anyone can call
  `crank_funding` once an interval elapses, and anyone can call `liquidate`
  against an undercollateralized position for a capped reward
  (`LIQUIDATOR_REWARD_BPS`, currently 5% of remaining equity). No dependency
  on one keeper staying online.

## Known gaps, honest list

- `PriceOracle` is a self-owned account a keeper authority writes to — it is
  Pyth-shaped (price, confidence, timestamp) on purpose so swapping in a real
  Pyth/Switchboard feed only touches `read_oracle_price` in `state.rs`, but
  right now it is a single trusted writer. That's a centralization point to
  flag to judges rather than hide.
- Bad debt on liquidation (equity < 0) is floored at zero and not yet routed
  to the insurance fund account — `GlobalConfig.insurance_fund` is stored but
  no instruction pays into it yet. Real next step, not launch-blocking for a
  demo.
- `GlobalConfig.paused` exists but nothing checks it yet — market-level
  `paused` is enforced, protocol-level isn't wired in.
- No fee collection yet (`fee_bps` is stored, not charged).
- IDs and IDL: `declare_id!` uses a placeholder pubkey. Run
  `anchor keys sync` after your first `anchor build` to generate a real
  program keypair and update `Anchor.toml` + `declare_id!` together.

## Suggested build order for the rest of the week

1. `anchor build` locally, fix compile errors.
2. Write a TypeScript test that: initializes config, initializes an oracle,
   creates a market, deposits, opens a long, moves the oracle price, closes,
   withdraws. That single happy path will surface most account/PDA mistakes.
3. Add a liquidation test: open a highly leveraged position, drop the oracle
   price, call `liquidate` from a second wallet, assert the reward transfer.
4. Frontend: wallet connect, one page per market listing open positions and
   a simple open/close form. Doesn't need to be pretty for a hackathon demo,
   needs to prove the on-chain logic works end to end.
5. If time allows: wire `GlobalConfig.paused` into every instruction, and a
   real insurance fund settlement path for bad debt.
