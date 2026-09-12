use anchor_lang::prelude::*;
use crate::errors::PerpError;
use crate::state::{Market, FUNDING_INDEX_SCALE, MAX_FUNDING_RATE_BPS_PER_INTERVAL};

/// Anyone can call this once a funding interval has elapsed. No admin
/// required - it only reads open interest and writes a funding index delta,
/// so there is nothing here for a malicious caller to steal or bias beyond
/// the interval-clamped, skew-derived rate below.
#[derive(Accounts)]
pub struct CrankFunding<'info> {
    #[account(
        mut,
        constraint = !market.paused @ PerpError::MarketPaused
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<CrankFunding>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;

    let elapsed = now
        .checked_sub(market.last_funding_ts)
        .ok_or(PerpError::MathOverflow)?;
    require!(elapsed >= market.funding_interval_secs, PerpError::FundingNotDue);

    // Longs pay shorts when open interest skews long, and vice versa.
    // Rate is clamped to MAX_FUNDING_RATE_BPS_PER_INTERVAL regardless of
    // how extreme the skew is, and scaled down if more than one interval
    // has elapsed since the last crank so a late crank doesn't overshoot.
    let skew_bps = market.skew_bps()?;
    let clamped_bps = skew_bps
        .max(-MAX_FUNDING_RATE_BPS_PER_INTERVAL)
        .min(MAX_FUNDING_RATE_BPS_PER_INTERVAL);

    let intervals_elapsed = (elapsed as i128)
        .checked_div(market.funding_interval_secs as i128)
        .ok_or(PerpError::MathOverflow)?
        .max(1);

    // Index delta expressed per unit base size, scaled by FUNDING_INDEX_SCALE.
    let delta = clamped_bps
        .checked_mul(intervals_elapsed)
        .ok_or(PerpError::MathOverflow)?
        .checked_mul(FUNDING_INDEX_SCALE)
        .ok_or(PerpError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(PerpError::MathOverflow)?;

    market.cumulative_funding_index = market
        .cumulative_funding_index
        .checked_add(delta)
        .ok_or(PerpError::MathOverflow)?;
    market.last_funding_ts = now;

    Ok(())
}
