use anchor_lang::prelude::*;
use crate::errors::PerpError;

// Fixed-point scales. Prices and USDC amounts use 6 decimals to match USDC.
// The funding index uses a wider scale for precision over long accrual periods.
pub const PRICE_SCALE: u128 = 1_000_000; // 1e6
pub const FUNDING_INDEX_SCALE: i128 = 1_000_000_000; // 1e9
pub const BPS_SCALE: u128 = 10_000;

pub const MAX_ORACLE_STALENESS_SECS: i64 = 60;
pub const MAX_LEVERAGE_CAP: u8 = 20;
pub const MIN_LEVERAGE_CAP: u8 = 1;
pub const MIN_MARGIN_RATIO_BPS_FLOOR: u16 = 100; // 1%
pub const MIN_MARGIN_RATIO_BPS_CEIL: u16 = 5_000; // 50%
pub const MAX_FUNDING_RATE_BPS_PER_INTERVAL: i128 = 50; // 0.5% cap per funding interval
pub const LIQUIDATOR_REWARD_BPS: u128 = 500; // 5% of remaining collateral to the liquidator

#[account]
pub struct GlobalConfig {
    pub authority: Pubkey,
    pub insurance_fund: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

impl GlobalConfig {
    pub const SEED: &'static [u8] = b"config";
    pub const SIZE: usize = 8 + 32 + 32 + 2 + 1 + 1;
}

/// Self-contained price account a keeper pushes updates to.
/// Swap the read path in `read_oracle_price` for a real Pyth/Switchboard
/// deserializer once you wire up a production feed; the account shape
/// (price, confidence, timestamp) is deliberately Pyth-compatible.
#[account]
pub struct PriceOracle {
    pub authority: Pubkey,
    pub symbol: [u8; 16],
    pub price: u64,      // PRICE_SCALE fixed point
    pub confidence: u64, // PRICE_SCALE fixed point
    pub last_update_ts: i64,
    pub bump: u8,
}

impl PriceOracle {
    pub const SEED: &'static [u8] = b"oracle";
    pub const SIZE: usize = 8 + 32 + 16 + 8 + 8 + 8 + 1;
}

#[account]
pub struct Market {
    pub oracle: Pubkey,
    pub vault: Pubkey,
    pub vault_bump: u8,
    pub max_leverage: u8,
    pub min_margin_ratio_bps: u16,
    pub funding_interval_secs: i64,
    pub last_funding_ts: i64,
    /// Cumulative funding paid by longs (positive) or shorts (negative),
    /// expressed per unit of base size, scaled by FUNDING_INDEX_SCALE.
    pub cumulative_funding_index: i128,
    pub open_interest_long: u64,
    pub open_interest_short: u64,
    pub paused: bool,
    pub bump: u8,
}

impl Market {
    pub const SEED: &'static [u8] = b"market";
    pub const VAULT_SEED: &'static [u8] = b"vault";
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 1 + 2 + 8 + 8 + 16 + 8 + 8 + 1 + 1;

    /// Net open interest skew in bps, positive when longs dominate.
    pub fn skew_bps(&self) -> Result<i128> {
        let long = self.open_interest_long as i128;
        let short = self.open_interest_short as i128;
        let total = long
            .checked_add(short)
            .ok_or(PerpError::MathOverflow)?;
        if total == 0 {
            return Ok(0);
        }
        let diff = long.checked_sub(short).ok_or(PerpError::MathOverflow)?;
        diff
            .checked_mul(BPS_SCALE as i128)
            .ok_or(PerpError::MathOverflow)?
            .checked_div(total)
            .ok_or(PerpError::MathOverflow)
    }
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    /// Signed base size. Positive = long, negative = short. Scaled by PRICE_SCALE.
    pub size: i64,
    pub entry_price: u64, // PRICE_SCALE fixed point
    pub collateral: u64,  // USDC, 6 decimals
    pub entry_funding_index: i128,
    pub last_update_ts: i64,
    pub bump: u8,
}

impl Position {
    pub const SEED: &'static [u8] = b"position";
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 16 + 8 + 1;

    pub fn is_long(&self) -> bool {
        self.size > 0
    }

    /// Unrealized PnL in USDC (6 decimals), positive = profit.
    pub fn unrealized_pnl(&self, mark_price: u64) -> Result<i128> {
        let size = self.size as i128;
        let entry = self.entry_price as i128;
        let mark = mark_price as i128;
        let price_delta = mark.checked_sub(entry).ok_or(PerpError::MathOverflow)?;
        size
            .checked_mul(price_delta)
            .ok_or(PerpError::MathOverflow)?
            .checked_div(PRICE_SCALE as i128)
            .ok_or(PerpError::MathOverflow)
    }

    /// Funding owed by this position since it was opened or last settled.
    /// Positive means the position owes funding (reduces collateral on settle).
    pub fn funding_owed(&self, market_cumulative_index: i128) -> Result<i128> {
        let size = self.size as i128;
        let index_delta = market_cumulative_index
            .checked_sub(self.entry_funding_index)
            .ok_or(PerpError::MathOverflow)?;
        size
            .checked_mul(index_delta)
            .ok_or(PerpError::MathOverflow)?
            .checked_div(FUNDING_INDEX_SCALE)
            .ok_or(PerpError::MathOverflow)
    }

    /// Margin ratio in bps: (collateral + pnl - funding_owed) / notional.
    /// Notional uses the current mark price on the absolute size.
    pub fn margin_ratio_bps(&self, mark_price: u64, market_cumulative_index: i128) -> Result<i128> {
        let notional = (self.size.unsigned_abs() as u128)
            .checked_mul(mark_price as u128)
            .ok_or(PerpError::MathOverflow)?
            .checked_div(PRICE_SCALE)
            .ok_or(PerpError::MathOverflow)? as i128;

        if notional == 0 {
            return Ok(i128::MAX);
        }

        let pnl = self.unrealized_pnl(mark_price)?;
        let funding = self.funding_owed(market_cumulative_index)?;
        let equity = (self.collateral as i128)
            .checked_add(pnl)
            .ok_or(PerpError::MathOverflow)?
            .checked_sub(funding)
            .ok_or(PerpError::MathOverflow)?;

        equity
            .checked_mul(BPS_SCALE as i128)
            .ok_or(PerpError::MathOverflow)?
            .checked_div(notional)
            .ok_or(PerpError::MathOverflow)
    }
}

/// Reads and validates a PriceOracle account, enforcing staleness.
/// Isolated here so swapping in a real Pyth feed only touches this one function.
pub fn read_oracle_price(oracle: &Account<PriceOracle>, now: i64) -> Result<u64> {
    require!(oracle.price > 0, PerpError::InvalidOraclePrice);
    require!(
        now.checked_sub(oracle.last_update_ts)
            .ok_or(PerpError::MathOverflow)?
            <= MAX_ORACLE_STALENESS_SECS,
        PerpError::StaleOracle
    );
    Ok(oracle.price)
}
