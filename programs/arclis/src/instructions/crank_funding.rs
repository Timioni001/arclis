use anchor_lang::prelude::*;

use crate::errors::ArclisError;
use crate::events::FundingAccrued;
use crate::instructions::guards::require_protocol_live;
use crate::math::funding;
use crate::math::liquidity;
use crate::math::session::{funding_accrues, PriceUse};
use crate::state::{GlobalConfig, LiquidityPool, Market, PriceOracle};

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
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump,
        constraint = !market.paused @ ArclisError::MarketPaused
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.oracle @ ArclisError::OracleMismatch)]
    pub oracle: Box<Account<'info, PriceOracle>>,

    /// The market's pool, and its vault. Needed because funding is now scaled
    /// by how hard the pool is working - see `math::funding::funding_rate_bps`.
    #[account(
        address = market.liquidity_pool @ ArclisError::PoolMismatch,
        seeds = [LiquidityPool::SEED, market.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, LiquidityPool>>,

    #[account(address = pool.vault @ ArclisError::VaultMismatch)]
    pub pool_vault: Box<Account<'info, anchor_spl::token::TokenAccount>>,
}

pub fn handler(ctx: Context<CrankFunding>) -> Result<()> {
    require_protocol_live(&ctx.accounts.config)?;

    let now = Clock::get()?.unix_timestamp;
    // Funding requires a live venue: `IncreaseRisk` is the strict budget, and
    // the explicit `funding_accrues` check below states the intent rather than
    // relying on that side effect.
    let mark_price = ctx
        .accounts
        .oracle
        .validated_price(now, PriceUse::IncreaseRisk)?;
    require!(
        funding_accrues(ctx.accounts.oracle.session),
        ArclisError::SessionNotOpen
    );
    let market = &mut ctx.accounts.market;

    let elapsed = now
        .checked_sub(market.last_funding_ts)
        .ok_or(ArclisError::MathOverflow)?;
    require!(
        elapsed >= market.funding_interval_secs,
        ArclisError::FundingNotDue
    );

    let intervals = funding::intervals_elapsed(elapsed, market.funding_interval_secs)?;
    let skew_bps = market.skew_bps()?;

    // Funding is amplified by pool utilisation: an imbalance matters in
    // proportion to how much of the pool's capital it is consuming.
    let net_pnl = market.net_trader_pnl(mark_price)?;
    let nav = ctx
        .accounts
        .pool
        .nav(ctx.accounts.pool_vault.amount, net_pnl)?;
    let exposure = market.net_exposure_notional(mark_price)?;
    let utilization = liquidity::utilization_bps(exposure, nav)?;

    let rate_bps =
        funding::funding_rate_bps(skew_bps, market.funding_sensitivity_bps, utilization)?;
    let delta = funding::funding_index_delta(rate_bps, mark_price, intervals)?;

    market.cumulative_funding_index = market
        .cumulative_funding_index
        .checked_add(delta)
        .ok_or(ArclisError::MathOverflow)?;

    // Advance by exactly the intervals settled, not to `now`. If the cap in
    // `intervals_elapsed` truncated a long gap, the unsettled remainder stays
    // owed and the next crank picks it up, instead of being silently forgiven.
    let consumed = i64::try_from(intervals)
        .map_err(|_| ArclisError::MathOverflow)?
        .checked_mul(market.funding_interval_secs)
        .ok_or(ArclisError::MathOverflow)?;
    market.last_funding_ts = market
        .last_funding_ts
        .checked_add(consumed)
        .ok_or(ArclisError::MathOverflow)?;

    emit!(FundingAccrued {
        market: market.key(),
        cranker: ctx.accounts.cranker.key(),
        skew_bps,
        rate_bps,
        intervals,
        mark_price,
        index_after: market.cumulative_funding_index,
        utilization_bps: utilization,
    });
    Ok(())
}
