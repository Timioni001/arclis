use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
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

// Oracle kinds a Market can be created with.
pub const ORACLE_KIND_MOCK: u8 = 0;
pub const ORACLE_KIND_PYTH: u8 = 1;

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

/// Local/devnet-testing oracle a keeper authority pushes updates to. This
/// exists so the engine can be exercised end to end without depending on a
/// live Pyth feed being reliably available on devnet during the hackathon.
/// It is NOT the production oracle path - see PriceUpdateV2 usage below and
/// ORACLE_KIND_PYTH. Its single-writer trust model should be called out to
/// judges as a testing convenience, not presented as production-grade.
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
    /// ORACLE_KIND_MOCK or ORACLE_KIND_PYTH.
    pub oracle_kind: u8,
    /// For ORACLE_KIND_MOCK: the PriceOracle PDA's own pubkey, as bytes.
    /// For ORACLE_KIND_PYTH: the Pyth price feed id (see
    /// https://docs.pyth.network/price-feeds/price-feeds for the full list,
    /// e.g. Equity.US.AAPL/USD). This is also what the Market PDA itself is
    /// seeded from, so every market is uniquely keyed by its oracle.
    pub oracle_ref: [u8; 32],
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
    pub const SIZE: usize = 8 + 1 + 32 + 32 + 1 + 1 + 2 + 8 + 8 + 16 + 8 + 8 + 1 + 1;

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

/// Converts a Pyth price (mantissa + exponent, e.g. 17160106530699 * 10^-8)
/// into our PRICE_SCALE (1e6) fixed-point u64.
pub fn pyth_price_to_fixed6(price: i64, exponent: i32) -> Result<u64> {
    require!(price > 0, PerpError::InvalidOraclePrice);
    let price = price as i128;
    let shift = 6i32.checked_add(exponent).ok_or(PerpError::MathOverflow)?;
    let scaled: i128 = if shift >= 0 {
        price
            .checked_mul(10i128.pow(shift as u32))
            .ok_or(PerpError::MathOverflow)?
    } else {
        price
            .checked_div(10i128.pow((-shift) as u32))
            .ok_or(PerpError::MathOverflow)?
    };
    require!(scaled > 0, PerpError::InvalidOraclePrice);
    require!(scaled <= u64::MAX as i128, PerpError::MathOverflow);
    Ok(scaled as u64)
}

/// Reads the mark price for a market from whichever oracle it was created
/// with. Exactly one of `mock_oracle` / `pyth_update` should be Some,
/// matching market.oracle_kind - the caller wires up the right one from an
/// Option<Account<...>> in their instruction's Accounts struct.
pub fn read_price(
    market: &Market,
    mock_oracle: Option<&Account<PriceOracle>>,
    pyth_update: Option<&Account<PriceUpdateV2>>,
    now: i64,
) -> Result<u64> {
    match market.oracle_kind {
        ORACLE_KIND_MOCK => {
            let oracle = mock_oracle.ok_or(PerpError::OracleMismatch)?;
            require!(
                oracle.key().to_bytes() == market.oracle_ref,
                PerpError::OracleMismatch
            );
            require!(oracle.price > 0, PerpError::InvalidOraclePrice);
            require!(
                now.checked_sub(oracle.last_update_ts)
                    .ok_or(PerpError::MathOverflow)?
                    <= MAX_ORACLE_STALENESS_SECS,
                PerpError::StaleOracle
            );
            Ok(oracle.price)
        }
        ORACLE_KIND_PYTH => {
            let update = pyth_update.ok_or(PerpError::OracleMismatch)?;
            let price = update
                .get_price_no_older_than(
                    &Clock::get()?,
                    MAX_ORACLE_STALENESS_SECS as u64,
                    &market.oracle_ref,
                )
                .map_err(|_| error!(PerpError::StaleOracle))?;
            pyth_price_to_fixed6(price.price, price.exponent)
        }
        _ => Err(error!(PerpError::OracleMismatch)),
    }
}
