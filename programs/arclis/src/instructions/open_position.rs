use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::constants::MIN_POSITION_NOTIONAL;
use crate::errors::ArclisError;
use crate::events::PositionOpened;
use crate::instructions::guards::{require_tradable, sync_and_settle};
use crate::math::liquidity;
use crate::math::session::PriceUse;
use crate::math::{fixed, pnl};
use crate::state::{GlobalConfig, LiquidityPool, Market, Position, PriceOracle};

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    pub owner: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.oracle @ ArclisError::OracleMismatch)]
    pub oracle: Box<Account<'info, PriceOracle>>,

    #[account(
        mut,
        has_one = owner @ ArclisError::Unauthorized,
        seeds = [Position::SEED, owner.key().as_ref(), market.key().as_ref()],
        bump = position.bump
    )]
    pub position: Box<Account<'info, Position>>,

    /// The counterparty. Opening commits the pool's *capacity*, which is what
    /// the utilisation cap below checks - but it is `mut` because the sync that
    /// runs first settles any funding and dividends accrued since this position
    /// was last touched, and those do move money between the two vaults.
    #[account(
        mut,
        address = market.liquidity_pool @ ArclisError::PoolMismatch,
        seeds = [LiquidityPool::SEED, market.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, LiquidityPool>>,

    #[account(mut, address = pool.vault @ ArclisError::VaultMismatch)]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.vault @ ArclisError::VaultMismatch)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Increase a position. `size_delta` is signed base size at `BASE_SCALE`:
/// positive opens or adds to a long, negative to a short.
///
/// Flipping direction in one call is rejected rather than netted, so entry-price
/// accounting never has to reconcile two directions inside one instruction.
/// Close first, then open the other way.
pub fn handler(ctx: Context<OpenPosition>, size_delta: i64) -> Result<()> {
    require_tradable(&ctx.accounts.config, &ctx.accounts.market)?;
    require!(size_delta != 0, ArclisError::ZeroSize);

    let now = Clock::get()?.unix_timestamp;
    // Opening or adding is the canonical increase-risk action, so this is
    // refused outright while the underlying venue is shut.
    let fill_price = ctx
        .accounts
        .oracle
        .validated_price(now, PriceUse::IncreaseRisk)?;
    let taker_fee_bps = ctx.accounts.market.taker_fee_bps;

    // 1. Normalise for any corporate action, then settle dividends and funding
    //    against the *old* size, before it changes. Order matters - see
    //    `sync_position`. `sync_and_settle` also moves whatever that settlement
    //    owes between the market vault and the pool, so the position's new
    //    collateral is backed by tokens that are actually there.
    let oracle_key = ctx.accounts.oracle.key();
    let sync = sync_and_settle(
        &mut ctx.accounts.position,
        &ctx.accounts.oracle,
        &mut ctx.accounts.market,
        &ctx.accounts.market_vault,
        &mut ctx.accounts.pool,
        &ctx.accounts.pool_vault,
        &ctx.accounts.token_program,
        &oracle_key,
    )?;
    let funding_settled = sync.funding;
    let dividends_settled = sync.dividends;

    // 2. Charge the taker fee on the notional being added, and route it to the
    //    market's insurance balance. The original engine stored `fee_bps` and
    //    never charged it, so the insurance fund had no funding source at all
    //    and could never cover the bad debt it was nominally there for.
    let added_notional = pnl::notional(size_delta, fill_price)?;
    let fee = fixed::to_u64(pnl::fee_on_notional(added_notional, taker_fee_bps)?)?;

    // 3. Re-price the entry and apply the size change. `Position::increase`
    //    also rejects a direction flip: netting two directions inside one
    //    instruction would mean the entry price has to reconcile both.
    let (size_after, entry_price_after) = {
        let position = &mut ctx.accounts.position;
        position.debit_collateral(fee)?;
        position.increase(size_delta, fill_price)?;
        position.last_update_ts = now;
        (position.size, position.entry_price)
    };

    // 4. Move the fee from trader collateral into insurance, and record the
    //    open interest plus the entry notional the pool now has to value.
    {
        let market = &mut ctx.accounts.market;
        market.debit_collateral(fee)?;
        market.credit_insurance(fee)?;
        market.apply_open_interest(size_delta, true)?;
        market.add_entry_notional(size_delta, fill_price)?;
    }

    // 5. The pool has to be able to carry the resulting imbalance. This is the
    //    check that makes the counterparty real rather than nominal: without
    //    it, traders could pile onto one side until the pool was backing
    //    exposure many times its own capital, which is precisely the
    //    insolvency the pool was introduced to prevent.
    {
        let net_pnl = ctx.accounts.market.net_trader_pnl(fill_price)?;
        let nav = ctx
            .accounts
            .pool
            .nav(ctx.accounts.pool_vault.amount, net_pnl)?;
        let exposure = ctx.accounts.market.net_exposure_notional(fill_price)?;
        let utilization = liquidity::utilization_bps(exposure, nav)?;
        require!(
            utilization <= i128::from(ctx.accounts.market.max_utilization_bps),
            ArclisError::UtilizationCapExceeded
        );
    }

    // 6. Dust guard: a position too small to be worth a liquidation
    //    transaction becomes permanent bad debt if it goes underwater, because
    //    no rational liquidator will ever close it.
    let total_notional = pnl::notional(size_after, fill_price)?;
    require!(
        total_notional >= i128::from(MIN_POSITION_NOTIONAL),
        ArclisError::PositionTooSmall
    );

    // 7. Health check last, on the final state. This is the check the original
    //    engine got wrong: it compared notional against raw collateral times
    //    leverage, ignoring unrealised PnL and unsettled funding, so a position
    //    deep in the red could add to itself and land below maintenance margin
    //    in the same instruction.
    ctx.accounts
        .position
        .require_initial_margin(fill_price, &ctx.accounts.market)?;

    emit!(PositionOpened {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        size_delta,
        size_after,
        fill_price,
        entry_price_after,
        fee,
        funding_settled,
        dividends_settled,
    });
    Ok(())
}
