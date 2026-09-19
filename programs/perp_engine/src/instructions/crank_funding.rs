use anchor_lang::prelude::*;

use crate::errors::PerpError;
use crate::events::FundingAccrued;
use crate::instructions::guards::require_protocol_live;
use crate::math::funding;
use crate::state::{GlobalConfig, Market, PriceOracle};

/// Accrue funding. Permissionless: anyone may call once an interval has
/// elapsed.
///
/// There is nothing here for a caller to bias. The rate is derived from open
/// interest they do not control, clamped to a constant they cannot configure,
/// and the number of intervals is capped, so calling early, late, or repeatedly
/// changes nothing except who pays the transaction fee.
///
/// # The oracle account is new and not optional
///
/// The original `CrankFunding` took only the market, because its funding index
/// was a bare rate with no price in it. That was the bug: funding is a charge on
/// *notional*, so the index has to be denominated in quote per base unit, which
/// means the mark price must be read here. Without it a $200 asset and a $1
/// asset were charged identically.
#[derive(Accounts)]
pub struct CrankFunding<'info> {
    pub cranker: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump,
        constraint = !market.paused @ PerpError::MarketPaused
    )]
    pub market: Account<'info, Market>,

    #[account(address = market.oracle @ PerpError::OracleMismatch)]
    pub oracle: Account<'info, PriceOracle>,
}

pub fn handler(ctx: Context<CrankFunding>) -> Result<()> {
    require_protocol_live(&ctx.accounts.config)?;

    let now = Clock::get()?.unix_timestamp;
    let mark_price = ctx.accounts.oracle.validated_price(now)?;
    let market = &mut ctx.accounts.market;

    let elapsed = now
        .checked_sub(market.last_funding_ts)
        .ok_or(PerpError::MathOverflow)?;
    require!(
        elapsed >= market.funding_interval_secs,
        PerpError::FundingNotDue
    );

    let intervals = funding::intervals_elapsed(elapsed, market.funding_interval_secs)?;
    let skew_bps = market.skew_bps()?;
    let rate_bps = funding::funding_rate_bps(skew_bps, market.funding_sensitivity_bps)?;
    let delta = funding::funding_index_delta(rate_bps, mark_price, intervals)?;

    market.cumulative_funding_index = market
        .cumulative_funding_index
        .checked_add(delta)
        .ok_or(PerpError::MathOverflow)?;

    // Advance by exactly the intervals settled, not to `now`. If the cap in
    // `intervals_elapsed` truncated a long gap, the unsettled remainder stays
    // owed and the next crank picks it up, instead of being silently forgiven.
    let consumed = i64::try_from(intervals)
        .map_err(|_| PerpError::MathOverflow)?
        .checked_mul(market.funding_interval_secs)
        .ok_or(PerpError::MathOverflow)?;
    market.last_funding_ts = market
        .last_funding_ts
        .checked_add(consumed)
        .ok_or(PerpError::MathOverflow)?;

    emit!(FundingAccrued {
        market: market.key(),
        cranker: ctx.accounts.cranker.key(),
        skew_bps,
        rate_bps,
        intervals,
        mark_price,
        index_after: market.cumulative_funding_index,
    });
    Ok(())
}
