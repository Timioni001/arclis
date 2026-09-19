//! Emitted events.
//!
//! The original program emitted nothing, which meant the only way to know what
//! a market had done was to diff account state between slots. Every
//! state-changing instruction now emits, so a frontend or an indexer can
//! reconstruct position history, funding accrual, and the liquidation record
//! from logs alone.
//!
//! Amounts follow the scales in [`crate::constants`].

use anchor_lang::prelude::*;

use crate::math::session::MarketSession;

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub oracle: Pubkey,
    pub vault: Pubkey,
    pub creator: Pubkey,
    pub max_leverage: u8,
    pub maintenance_margin_bps: u16,
    pub funding_interval_secs: i64,
}

#[event]
pub struct CollateralDeposited {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub collateral_after: u64,
}

#[event]
pub struct CollateralWithdrawn {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub collateral_after: u64,
    pub margin_ratio_bps_after: i128,
}

#[event]
pub struct PositionOpened {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub size_delta: i64,
    pub size_after: i64,
    pub fill_price: u64,
    pub entry_price_after: u64,
    pub fee: u64,
    pub funding_settled: i128,
}

#[event]
pub struct PositionClosed {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub reduce_size: u64,
    pub size_after: i64,
    pub fill_price: u64,
    pub realized_pnl: i128,
    pub fee: u64,
    pub funding_settled: i128,
}

#[event]
pub struct FundingAccrued {
    pub market: Pubkey,
    pub cranker: Pubkey,
    pub skew_bps: i128,
    pub rate_bps: i128,
    pub intervals: i128,
    pub mark_price: u64,
    pub index_after: i128,
    /// How hard the pool was working when this accrued. Reading a funding rate
    /// without it is misleading, since utilisation is half the formula.
    pub utilization_bps: i128,
}

#[event]
pub struct PositionLiquidated {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub liquidator: Pubkey,
    pub size_closed: i64,
    pub mark_price: u64,
    pub equity: i128,
    pub liquidator_reward: u64,
    pub insurance_cut: u64,
    pub trader_remainder: u64,
    /// Shortfall taken out of LP capital, after insurance was exhausted.
    pub bad_debt_absorbed_by_pool: u64,
    /// Non-zero here is the signal an operator must watch: neither insurance
    /// nor the pool covered the shortfall and the remainder was socialised
    /// across everyone still open.
    pub bad_debt_socialized: u64,
}

#[event]
pub struct MarketPauseToggled {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub paused: bool,
}

#[event]
pub struct ProtocolPauseToggled {
    pub authority: Pubkey,
    pub paused: bool,
}

/// Emitted whenever the underlying venue changes trading state. An indexer can
/// reconstruct the full session calendar from these alone, which is what a
/// frontend needs to render "opens Monday 09:30" instead of a bare error.
#[event]
pub struct SessionChanged {
    pub oracle: Pubkey,
    pub authority: Pubkey,
    pub previous: MarketSession,
    pub current: MarketSession,
    pub price: u64,
    pub ts: i64,
}

#[event]
pub struct CorporateActionApplied {
    pub oracle: Pubkey,
    pub market: Pubkey,
    pub authority: Pubkey,
    pub numerator: u32,
    pub denominator: u32,
    pub split_factor_before: u64,
    pub split_factor_after: u64,
    pub price_before: u64,
    pub price_after: u64,
    pub sequence: u32,
}

// ---------------------------------------------------------------------------
// Agent treasuries
// ---------------------------------------------------------------------------

#[event]
pub struct TreasuryInitialized {
    pub treasury: Pubkey,
    pub authority: Pubkey,
    pub agent_mint: Pubkey,
    pub stock_mint: Pubkey,
    pub market: Pubkey,
    pub hedge_ratio_bps: u16,
    pub rebalance_tolerance_bps: u16,
}

#[event]
pub struct TreasuryStockMoved {
    pub treasury: Pubkey,
    pub actor: Pubkey,
    pub amount: u64,
    pub deposited: bool,
    pub stock_qty_after: u64,
}

/// The event an agent's dashboard is built from: what the hedge did, and what
/// the treasury is worth per token afterwards.
#[event]
pub struct TreasuryHedgeRebalanced {
    pub treasury: Pubkey,
    pub cranker: Pubkey,
    pub mark_price: u64,
    pub size_delta: i64,
    pub delta_before: i64,
    pub delta_after: i64,
    pub stock_value: i128,
    pub perp_equity: i128,
    pub nav: i128,
    pub nav_per_token: u64,
}

// ---------------------------------------------------------------------------
// Liquidity pool
// ---------------------------------------------------------------------------

#[event]
pub struct LiquidityPoolInitialized {
    pub pool: Pubkey,
    pub market: Pubkey,
    pub vault: Pubkey,
    pub quote_mint: Pubkey,
    pub cooldown_secs: i64,
}

#[event]
pub struct LiquidityDeposited {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub shares_minted: u64,
    /// NAV the shares were priced against, so a depositor can verify the rate.
    pub nav_before: i128,
    pub total_shares_after: u64,
}

#[event]
pub struct LiquidityWithdrawRequested {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub cooldown_ends_ts: i64,
}

#[event]
pub struct LiquidityWithdrawn {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub shares_burned: u64,
    pub amount: u64,
    /// NAV at settlement - deliberately not the NAV at request time.
    pub nav_at_settlement: i128,
    pub total_shares_after: u64,
}

/// Emitted whenever realised trader PnL moves between the market vault and the
/// pool. This is the audit trail for where a winning trader's money came from.
#[event]
pub struct PoolSettled {
    pub pool: Pubkey,
    pub market: Pubkey,
    /// Positive when the pool paid traders, negative when it collected.
    pub amount: i128,
    pub reason: SettlementReason,
    pub pool_realized_pnl_after: i128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SettlementReason {
    PositionClosed,
    Liquidation,
    BadDebt,
}
