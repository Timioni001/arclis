use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::PerpError;
use crate::events::CollateralWithdrawn;
use crate::instructions::guards::require_tradable;
use crate::state::{GlobalConfig, Market, Position, PriceOracle};

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    pub owner: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(address = market.oracle @ PerpError::OracleMismatch)]
    pub oracle: Account<'info, PriceOracle>,

    #[account(
        mut,
        has_one = owner @ PerpError::Unauthorized,
        seeds = [Position::SEED, owner.key().as_ref(), market.key().as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        constraint = owner_token_account.mint == vault.mint @ PerpError::VaultMismatch,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    #[account(mut, address = market.vault @ PerpError::VaultMismatch)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
    require_tradable(&ctx.accounts.config, &ctx.accounts.market)?;
    require!(amount > 0, PerpError::InsufficientCollateral);

    let now = Clock::get()?.unix_timestamp;
    let mark_price = ctx.accounts.oracle.validated_price(now)?;
    let funding_index = ctx.accounts.market.cumulative_funding_index;

    // Settle funding before valuing anything, so the margin check below runs
    // against the position's actual current state rather than a stale snapshot.
    ctx.accounts.position.settle_funding(funding_index)?;
    ctx.accounts.position.debit_collateral(amount)?;

    // With collateral already debited, the ratio computed here is the
    // post-withdrawal ratio. Requiring *initial* margin rather than maintenance
    // means a trader cannot withdraw straight down to the liquidation boundary
    // and leave the vault holding a position that is one tick from bad debt.
    let margin_ratio_bps_after = {
        let position = &ctx.accounts.position;
        if position.is_flat() {
            i128::MAX
        } else {
            let ratio = position.margin_ratio_bps(mark_price, funding_index)?;
            require!(
                ratio >= i128::from(ctx.accounts.market.initial_margin_bps),
                PerpError::WithdrawalBreaksMargin
            );
            ratio
        }
    };

    // Check against the vault's real balance, not our own bookkeeping, so a
    // divergence between the two fails loudly here instead of at the token
    // program with an opaque error.
    ctx.accounts
        .market
        .require_payable(ctx.accounts.vault.amount, amount)?;

    let oracle_key = ctx.accounts.oracle.key();
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
