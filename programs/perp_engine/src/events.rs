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
    /// Non-zero here is the signal an operator must watch: insurance did not
    /// fully cover the shortfall and the remainder was socialised.
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
