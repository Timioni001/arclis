use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ArclisError;
use crate::events::CollateralWithdrawn;
use crate::instructions::guards::{require_tradable, sync_and_settle};
use crate::math::session::PriceUse;
use crate::state::{GlobalConfig, LiquidityPool, Market, Position, PriceOracle};

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
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

    #[account(
        mut,
        constraint = owner_token_account.mint == vault.mint @ ArclisError::VaultMismatch,
    )]
    pub owner_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.vault @ ArclisError::VaultMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// The counterparty. Withdrawing does not itself touch the pool, but the
    /// sync that runs first settles accrued funding and dividends, and those
    /// are the pool's to pay or collect.
    #[account(
        mut,
        address = market.liquidity_pool @ ArclisError::PoolMismatch,
        seeds = [LiquidityPool::SEED, market.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, LiquidityPool>>,

    #[account(mut, address = pool.vault @ ArclisError::VaultMismatch)]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
    require_tradable(&ctx.accounts.config, &ctx.accounts.market)?;
    require!(amount > 0, ArclisError::InsufficientCollateral);

    let now = Clock::get()?.unix_timestamp;
    // Withdrawing collateral raises leverage on whatever is still open, so it
    // counts as increasing risk and is refused while the venue is shut.
    let mark_price = ctx
        .accounts
        .oracle
        .validated_price(now, PriceUse::IncreaseRisk)?;
    let funding_index = ctx.accounts.market.cumulative_funding_index;

    // Normalise and settle before valuing anything, so the margin check below
    // runs against the position's actual current state rather than a stale
    // snapshot.
    let oracle_key = ctx.accounts.oracle.key();
    sync_and_settle(
        &mut ctx.accounts.position,
        &ctx.accounts.oracle,
        &mut ctx.accounts.market,
        &ctx.accounts.vault,
        &mut ctx.accounts.pool,
        &ctx.accounts.pool_vault,
        &ctx.accounts.token_program,
        &oracle_key,
    )?;
    let margin_ratio_bps_after = debit_collateral(
        &mut ctx.accounts.position,
        &ctx.accounts.market,
        mark_price,
        funding_index,
        ctx.accounts.vault.amount,
        amount,
    )?;

    let bump = [ctx.accounts.market.bump];
    let seeds = Market::signer_seeds(&oracle_key, &bump);

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            &[&seeds],
        ),
        amount,
    )?;

    ctx.accounts.market.debit_collateral(amount)?;
    ctx.accounts.position.last_update_ts = now;

    emit!(CollateralWithdrawn {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        amount,
        collateral_after: ctx.accounts.position.collateral,
        margin_ratio_bps_after,
    });
    Ok(())
}

/// Take collateral off a position, refusing to leave it under-margined.
///
/// Shared with the agent treasury's hedge, for the reason set out on
/// `credit_collateral`: the treasury's position is owned by a PDA, so the
/// signer differs while the solvency rules must not. Returns the post-
/// withdrawal margin ratio for the event.
///
/// The caller does the transfer and `market.debit_collateral`, which are the
/// parts that depend on where the tokens are going.
pub(crate) fn debit_collateral(
    position: &mut Position,
    market: &Market,
    mark_price: u64,
    funding_index: i128,
    vault_amount: u64,
    amount: u64,
) -> Result<i128> {
    position.debit_collateral(amount)?;

    // With collateral already debited, the ratio computed here is the
    // post-withdrawal ratio. Requiring *initial* margin rather than maintenance
    // means a trader cannot withdraw straight down to the liquidation boundary
    // and leave the vault holding a position that is one tick from bad debt.
    let margin_ratio_bps_after = if position.is_flat() {
        i128::MAX
    } else {
        let ratio = position.margin_ratio_bps(mark_price, funding_index)?;
        require!(
            ratio >= i128::from(market.initial_margin_bps),
            ArclisError::WithdrawalBreaksMargin
        );
        ratio
    };

    // Check against the vault's real balance, not our own bookkeeping, so a
    // divergence between the two fails loudly here instead of at the token
    // program with an opaque error.
    market.require_payable(vault_amount, amount)?;

    Ok(margin_ratio_bps_after)
}
