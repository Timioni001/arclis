//! A general-purpose, oracle-priced perpetual futures engine for Solana.
//!
//! # Shape of the design
//!
//! - **Cash-settled against an oracle.** Mark price *is* the oracle price.
//!   There is no order book and no AMM curve, which removes an enormous amount
//!   of scope (no slippage model, no liquidity depth, no keeper-run matching)
//!   at a real cost: there is no independent mark price, so funding cannot be
//!   derived from a mark-minus-index premium. It is derived from open-interest
//!   skew instead - see [`math::funding`] for why that is the right call here
//!   and where it stops being right.
//!
//! - **Program-owned custody.** No instruction in this program moves value from
//!   a market vault to an address the authority chooses. Every outbound
//!   transfer is margin-checked ([`instructions::withdraw_collateral`]) or
//!   liquidation-checked and permissionless ([`instructions::liquidate`]). The
//!   complete list of what an authority can do is in
//!   [`instructions::admin`]: two pause flags, no value movement.
//!
//! - **Permissionless listing, cranking, and liquidation.** Anyone can create a
//!   market over an existing oracle, accrue funding once an interval elapses, or
//!   liquidate an undercollateralised position for a penalty share. No part of
//!   the protocol depends on one keeper staying online.
//!
//! # Layering
//!
//! ```text
//! lib.rs            entrypoint, one thin forward per instruction
//! constants.rs      fixed-point scales and every protocol bound, in one place
//! errors.rs         the error surface
//! events.rs         emitted logs
//! math/             pure arithmetic - no accounts, no Clock, no CPI
//!   session.rs        trading hours and halts: what a frozen price may be used for
//!   corporate_actions.rs  splits, via lazy per-position normalisation
//! state/            account layouts, one file each, thin forwards into math/
//! instructions/     guards, then math, then writes, then an event
//! ```
//!
//! The split exists so the interesting part - the arithmetic - is testable with
//! `cargo test` on the host in about a second, instead of only through a
//! validator. See `BUILD.md`.
//!
//! # Trust assumptions, stated rather than buried
//!
//! [`state::PriceOracle`] is a keeper-written account, not a live Pyth feed. It
//! is Pyth-shaped so the swap touches one method, and it bounds the writer with
//! staleness, confidence, and per-update deviation limits - but a single key
//! still sets the price every position in its markets is valued against. That is
//! the load-bearing trust assumption in this design. `docs/FEASIBILITY.md` is
//! the honest account of it and of the counterparty problem underneath.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;
use math::session::MarketSession;

// This is the program keypair committed in this repo's git history, which means
// its secret key is public. It is fine for local validator work and devnet
// throwaways. Before any deployment that matters, run:
//
//     solana-keygen new -o target/deploy/arclis-keypair.json --force
//     anchor keys sync
//
// which rotates the pair and rewrites this line and Anchor.toml together.
declare_id!("BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP");

#[program]
pub mod arclis {
    use super::*;

    // --- setup --------------------------------------------------------------

    pub fn initialize_global_config(
        ctx: Context<InitializeGlobalConfig>,
        default_fee_bps: u16,
    ) -> Result<()> {
        instructions::initialize_global_config::handler(ctx, default_fee_bps)
    }

    pub fn initialize_price_oracle(
        ctx: Context<InitializePriceOracle>,
        symbol: [u8; 16],
        initial_price: u64,
    ) -> Result<()> {
        instructions::price_oracle::initialize_price_oracle(ctx, symbol, initial_price)
    }

    pub fn update_price_oracle(
        ctx: Context<UpdatePriceOracle>,
        price: u64,
        confidence: u64,
    ) -> Result<()> {
        instructions::price_oracle::update_price_oracle(ctx, price, confidence)
    }

    pub fn create_market(ctx: Context<CreateMarket>, params: MarketParams) -> Result<()> {
        instructions::create_market::handler(ctx, params)
    }

    // --- equity calendar ----------------------------------------------------
    //
    // These two are what let a perpetual track an asset that does not trade
    // perpetually. Everything else in the program is asset-agnostic; this is
    // where the stock market's opening hours and corporate actions enter.

    /// Publish the trading state of the underlying venue: open, closed,
    /// pre-open, or halted. See `math::session`.
    pub fn set_market_session(
        ctx: Context<SetMarketSession>,
        session: MarketSession,
    ) -> Result<()> {
        instructions::price_oracle::set_market_session(ctx, session)
    }

    /// Apply a split or reverse split, atomically across the oracle price and
    /// the market's aggregates. See `math::corporate_actions`.
    pub fn apply_corporate_action(
        ctx: Context<ApplyCorporateAction>,
        numerator: u32,
        denominator: u32,
    ) -> Result<()> {
        instructions::corporate_action::apply_split(ctx, numerator, denominator)
    }

    /// Record a cash dividend against every open position at once, so longs
    /// are credited the ex-date price drop instead of eating it. See
    /// `instructions::corporate_action::apply_dividend`.
    pub fn apply_dividend(ctx: Context<ApplyDividend>, per_share: u64) -> Result<()> {
        instructions::corporate_action::apply_dividend(ctx, per_share)
    }

    // --- collateral ---------------------------------------------------------

    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        instructions::deposit_collateral::handler(ctx, amount)
    }

    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        instructions::withdraw_collateral::handler(ctx, amount)
    }

    // --- trading ------------------------------------------------------------

    pub fn open_position(ctx: Context<OpenPosition>, size_delta: i64) -> Result<()> {
        instructions::open_position::handler(ctx, size_delta)
    }

    pub fn close_position(ctx: Context<ClosePosition>, reduce_size: u64) -> Result<()> {
        instructions::close_position::handler(ctx, reduce_size)
    }

    // --- permissionless cranks ----------------------------------------------

    pub fn crank_funding(ctx: Context<CrankFunding>) -> Result<()> {
        instructions::crank_funding::handler(ctx)
    }

    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        instructions::liquidate::handler(ctx)
    }

    // --- insurance ----------------------------------------------------------

    /// Seed or top up a market's insurance fund. Permissionless in, no way
    /// out; pays down socialised bad debt first.
    pub fn deposit_insurance(ctx: Context<DepositInsurance>, amount: u64) -> Result<()> {
        instructions::insurance::handler(ctx, amount)
    }

    // --- liquidity ----------------------------------------------------------
    //
    // The counterparty pool. Without it, a winning trader is paid out of other
    // traders' deposits; with it, LPs take the other side of net open interest
    // and are paid in fees, funding and trader losses for doing so.

    pub fn initialize_liquidity_pool(
        ctx: Context<InitializeLiquidityPool>,
        cooldown_secs: i64,
    ) -> Result<()> {
        instructions::liquidity::initialize_liquidity_pool(ctx, cooldown_secs)
    }

    pub fn deposit_liquidity(ctx: Context<LiquidityAction>, amount: u64) -> Result<()> {
        instructions::liquidity::deposit_liquidity(ctx, amount)
    }

    /// Start the redemption cooldown. Shares stay at risk while pending, which
    /// is what removes the incentive to be first out of a losing pool.
    pub fn request_withdraw_liquidity(ctx: Context<LiquidityAction>, shares: u64) -> Result<()> {
        instructions::liquidity::request_withdraw_liquidity(ctx, shares)
    }

    pub fn cancel_withdraw_liquidity(ctx: Context<LiquidityAction>) -> Result<()> {
        instructions::liquidity::cancel_withdraw_liquidity(ctx)
    }

    /// Settle a matured redemption at the NAV now, capped at what the open book
    /// leaves free.
    pub fn withdraw_liquidity(ctx: Context<LiquidityAction>) -> Result<()> {
        instructions::liquidity::withdraw_liquidity(ctx)
    }

    // --- agent treasuries ---------------------------------------------------
    //
    // An agent that raised on a stock-quoted bonding curve holds a treasury
    // levered to one company's earnings. These turn that into an operating
    // budget: hold the stock, short the matching perp, publish an honest NAV.

    pub fn initialize_treasury(
        ctx: Context<InitializeTreasury>,
        hedge_ratio_bps: u16,
        rebalance_tolerance_bps: u16,
    ) -> Result<()> {
        instructions::treasury::initialize_treasury(ctx, hedge_ratio_bps, rebalance_tolerance_bps)
    }

    pub fn set_treasury_policy(
        ctx: Context<SetTreasuryPolicy>,
        hedge_ratio_bps: u16,
        rebalance_tolerance_bps: u16,
        hedging_enabled: bool,
        tokens_outstanding: u64,
    ) -> Result<()> {
        instructions::treasury::set_treasury_policy(
            ctx,
            hedge_ratio_bps,
            rebalance_tolerance_bps,
            hedging_enabled,
            tokens_outstanding,
        )
    }

    pub fn deposit_stock(ctx: Context<MoveTreasuryStock>, amount: u64) -> Result<()> {
        instructions::treasury::deposit_stock(ctx, amount)
    }

    pub fn withdraw_stock(ctx: Context<MoveTreasuryStock>, amount: u64) -> Result<()> {
        instructions::treasury::withdraw_stock(ctx, amount)
    }

    /// Post margin for a treasury's hedge, opening its position on first call.
    ///
    /// `rebalance_hedge` below takes that position as an account that already
    /// exists, and nothing else in this program could create it: every other
    /// path seeds a position by a `Signer`'s key, and a treasury's position is
    /// owned by the treasury PDA. Without this instruction the hedge could
    /// never be opened at all.
    pub fn fund_treasury_hedge(
        ctx: Context<MoveTreasuryHedgeMargin>,
        amount: u64,
    ) -> Result<()> {
        instructions::treasury::fund_treasury_hedge(ctx, amount)
    }

    /// Return hedge margin to the agent, subject to the same initial-margin
    /// floor a trader's withdrawal is held to.
    pub fn defund_treasury_hedge(
        ctx: Context<MoveTreasuryHedgeMargin>,
        amount: u64,
    ) -> Result<()> {
        instructions::treasury::defund_treasury_hedge(ctx, amount)
    }

    /// Permissionless: anyone may bring a treasury back to its target hedge.
    /// The tolerance band, not an authority check, is what keeps this from
    /// being farmed for taker fees.
    pub fn rebalance_hedge(ctx: Context<RebalanceHedge>) -> Result<()> {
        instructions::treasury::rebalance_hedge(ctx)
    }

    // --- authority (pause only; no value movement lives here) ---------------

    pub fn set_protocol_paused(ctx: Context<SetProtocolPaused>, paused: bool) -> Result<()> {
        instructions::admin::set_protocol_paused(ctx, paused)
    }

    pub fn set_market_paused(ctx: Context<SetMarketPaused>, paused: bool) -> Result<()> {
        instructions::admin::set_market_paused(ctx, paused)
    }
}
