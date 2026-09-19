//! Liquidity pool: provide capital, request it back, take it out.
//!
//! The pool is the counterparty to net trader open interest. Everything here is
//! about getting capital in and out safely; the settlement that actually moves
//! money between traders and the pool lives in `close_position`, `liquidate`
//! and `crank_funding`.
//!
//! Redemption is a two-step: [`request_withdraw_liquidity`] starts a cooldown,
//! [`withdraw_liquidity`] settles it at the NAV *at settlement time*. See
//! [`crate::state::LpPosition`] for why that ordering is the difference between
//! a pool and a bank run.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::ArclisError;
use crate::events::{
    LiquidityDeposited, LiquidityPoolInitialized, LiquidityWithdrawRequested, LiquidityWithdrawn,
};
use crate::instructions::guards::{require_authority, require_protocol_live};
use crate::math::liquidity;
use crate::math::session::PriceUse;
use crate::state::{GlobalConfig, LiquidityPool, LpPosition, Market, PriceOracle};

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeLiquidityPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [Market::SEED, market.oracle.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    pub quote_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = LiquidityPool::SIZE,
        seeds = [LiquidityPool::SEED, market.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, LiquidityPool>,

    #[account(
        init,
        payer = authority,
        seeds = [LiquidityPool::VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// One pool per market, created by the protocol authority.
///
/// Not permissionless, unlike market creation. A market's pool is the thing
/// standing behind every position in it, so letting anyone create one would let
/// anyone front-run the real pool with an empty account and permanently wedge
/// the market's `liquidity_pool` pointer.
pub fn initialize_liquidity_pool(
    ctx: Context<InitializeLiquidityPool>,
    cooldown_secs: i64,
) -> Result<()> {
    require_protocol_live(&ctx.accounts.config)?;
    require_authority(&ctx.accounts.config, &ctx.accounts.authority.key())?;
    LiquidityPool::validate_cooldown(cooldown_secs)?;

    let pool = &mut ctx.accounts.pool;
    pool.market = ctx.accounts.market.key();
    pool.vault = ctx.accounts.vault.key();
    pool.quote_mint = ctx.accounts.quote_mint.key();
    pool.authority = ctx.accounts.authority.key();
    pool.total_shares = 0;
    pool.principal = 0;
    pool.realized_pnl = 0;
    pool.absorbed_bad_debt = 0;
    pool.cooldown_secs = cooldown_secs;
    pool.pending_shares = 0;
    pool.deposits_paused = false;
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.vault;
    pool._reserved = [0u8; 64];

    ctx.accounts.market.liquidity_pool = pool.key();

    emit!(LiquidityPoolInitialized {
        pool: pool.key(),
        market: pool.market,
        vault: pool.vault,
        quote_mint: pool.quote_mint,
        cooldown_secs,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// shared account set for LP actions
// ---------------------------------------------------------------------------

/// Deposits and redemptions both need the oracle, because both price shares
/// against NAV and NAV depends on what traders are currently owed.
#[derive(Accounts)]
pub struct LiquidityAction<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(address = market.oracle @ ArclisError::OracleMismatch)]
    pub oracle: Account<'info, PriceOracle>,

    #[account(
        mut,
        address = market.liquidity_pool @ ArclisError::PoolMismatch,
        seeds = [LiquidityPool::SEED, market.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, LiquidityPool>,

    #[account(
        init_if_needed,
        payer = owner,
        space = LpPosition::SIZE,
        seeds = [LpPosition::SEED, owner.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub lp_position: Account<'info, LpPosition>,

    #[account(
        mut,
        address = pool.vault @ ArclisError::VaultMismatch
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = owner_token_account.mint == vault.mint @ ArclisError::VaultMismatch,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> LiquidityAction<'info> {
    /// Current NAV, priced off a live mark.
    ///
    /// Uses the `ReduceRisk` budget so redemptions stay possible against a
    /// settled weekend close - an LP should not be locked in until Monday
    /// because the venue is shut. Deposits apply the stricter check separately.
    fn nav(&self, now: i64) -> Result<(i128, u64)> {
        let mark = self.oracle.validated_price(now, PriceUse::ReduceRisk)?;
        let net_pnl = self.market.net_trader_pnl(mark)?;
        Ok((self.pool.nav(self.vault.amount, net_pnl)?, mark))
    }

    fn init_lp_position_if_new(&mut self, bump: u8) -> Result<()> {
        if self.lp_position.owner == Pubkey::default() {
            self.lp_position.owner = self.owner.key();
            self.lp_position.pool = self.pool.key();
            self.lp_position.shares = 0;
            self.lp_position.pending_shares = 0;
            self.lp_position.cooldown_ends_ts = 0;
            self.lp_position.bump = bump;
            self.lp_position._reserved = [0u8; 32];
        } else {
            require_keys_eq!(
                self.lp_position.owner,
                self.owner.key(),
                ArclisError::Unauthorized
            );
            require_keys_eq!(
                self.lp_position.pool,
                self.pool.key(),
                ArclisError::PoolMismatch
            );
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// deposit
// ---------------------------------------------------------------------------

pub fn deposit_liquidity(ctx: Context<LiquidityAction>, amount: u64) -> Result<()> {
    require_protocol_live(&ctx.accounts.config)?;
    require!(amount > 0, ArclisError::InsufficientCollateral);
    require!(
        !ctx.accounts.pool.deposits_paused,
        ArclisError::MarketPaused
    );

    let now = Clock::get()?.unix_timestamp;
    // Depositing adds capital that immediately backs open risk, so it takes the
    // strict budget: no buying into the pool against a frozen weekend price,
    // where the Monday gap is already known to everyone but the pool.
    let mark = ctx
        .accounts
        .oracle
        .validated_price(now, PriceUse::IncreaseRisk)?;
    let net_pnl = ctx.accounts.market.net_trader_pnl(mark)?;
    let nav = ctx.accounts.pool.nav(ctx.accounts.vault.amount, net_pnl)?;

    let shares = ctx.accounts.pool.shares_for_deposit(amount, nav)?;
    require!(shares > 0, ArclisError::InsufficientShares);

    let bump = ctx.bumps.lp_position;
    ctx.accounts.init_lp_position_if_new(bump)?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    ctx.accounts.pool.mint_shares(shares, amount)?;
    let lp = &mut ctx.accounts.lp_position;
    lp.shares = lp
        .shares
        .checked_add(shares)
        .ok_or(ArclisError::MathOverflow)?;
    lp.last_deposit_ts = now;

    emit!(LiquidityDeposited {
        pool: ctx.accounts.pool.key(),
        owner: ctx.accounts.owner.key(),
        amount,
        shares_minted: shares,
        nav_before: nav,
        total_shares_after: ctx.accounts.pool.total_shares,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// request withdraw
// ---------------------------------------------------------------------------

pub fn request_withdraw_liquidity(ctx: Context<LiquidityAction>, shares: u64) -> Result<()> {
    require!(shares > 0, ArclisError::InsufficientShares);

    let bump = ctx.bumps.lp_position;
    ctx.accounts.init_lp_position_if_new(bump)?;

    let lp = &ctx.accounts.lp_position;
    require!(!lp.has_pending(), ArclisError::WithdrawalAlreadyPending);
    require!(
        shares <= lp.available_shares(),
        ArclisError::InsufficientShares
    );

    let now = Clock::get()?.unix_timestamp;
    let cooldown_ends = now
        .checked_add(ctx.accounts.pool.cooldown_secs)
        .ok_or(ArclisError::MathOverflow)?;

    let lp = &mut ctx.accounts.lp_position;
    lp.pending_shares = shares;
    lp.cooldown_ends_ts = cooldown_ends;

    ctx.accounts.pool.pending_shares = ctx
        .accounts
        .pool
        .pending_shares
        .checked_add(shares)
        .ok_or(ArclisError::MathOverflow)?;

    emit!(LiquidityWithdrawRequested {
        pool: ctx.accounts.pool.key(),
        owner: ctx.accounts.owner.key(),
        shares,
        cooldown_ends_ts: cooldown_ends,
    });
    Ok(())
}

/// Cancel a pending redemption and put the shares back to work.
///
/// Free and instant, because nothing about cancelling is a risk to the pool -
/// the shares never left it.
pub fn cancel_withdraw_liquidity(ctx: Context<LiquidityAction>) -> Result<()> {
    let lp = &ctx.accounts.lp_position;
    require!(lp.has_pending(), ArclisError::NoPendingWithdrawal);
    let shares = lp.pending_shares;

    let lp = &mut ctx.accounts.lp_position;
    lp.pending_shares = 0;
    lp.cooldown_ends_ts = 0;
    ctx.accounts.pool.pending_shares = ctx.accounts.pool.pending_shares.saturating_sub(shares);
    Ok(())
}

// ---------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------

/// Settle a matured redemption at the NAV **now**, not at request time.
///
/// Two limits apply, and they are different things:
///
/// - The cooldown, which removes the incentive to run.
/// - [`liquidity::max_withdrawable`], which caps the payout at the capital the
///   open book does not need. An LP can be fully matured and still unable to
///   take everything out, because positions are live against it. That is the
///   pool keeping its promise to traders rather than to LPs, and it is the
///   correct priority.
pub fn withdraw_liquidity(ctx: Context<LiquidityAction>) -> Result<()> {
    require_protocol_live(&ctx.accounts.config)?;

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.lp_position.require_cooldown_elapsed(now)?;

    let (nav, mark) = ctx.accounts.nav(now)?;
    let shares = ctx.accounts.lp_position.pending_shares;
    let gross = ctx.accounts.pool.amount_for_shares(shares, nav)?;

    let exposure = ctx.accounts.market.net_exposure_notional(mark)?;
    let free = liquidity::max_withdrawable(nav, exposure, ctx.accounts.market.max_utilization_bps)?;
    require!(gross <= free, ArclisError::ExceedsWithdrawableLiquidity);
    require!(
        ctx.accounts.vault.amount >= gross,
        ArclisError::VaultInsolvent
    );

    let market_key = ctx.accounts.market.key();
    let bump = [ctx.accounts.pool.bump];
    let seeds = LiquidityPool::signer_seeds(&market_key, &bump);

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[&seeds],
        ),
        gross,
    )?;

    ctx.accounts.pool.burn_shares(shares, gross)?;
    ctx.accounts.pool.pending_shares = ctx.accounts.pool.pending_shares.saturating_sub(shares);

    let lp = &mut ctx.accounts.lp_position;
    lp.shares = lp
        .shares
        .checked_sub(shares)
        .ok_or(ArclisError::InsufficientShares)?;
    lp.pending_shares = 0;
    lp.cooldown_ends_ts = 0;

    emit!(LiquidityWithdrawn {
        pool: ctx.accounts.pool.key(),
        owner: ctx.accounts.owner.key(),
        shares_burned: shares,
        amount: gross,
        nav_at_settlement: nav,
        total_shares_after: ctx.accounts.pool.total_shares,
    });
    Ok(())
}
