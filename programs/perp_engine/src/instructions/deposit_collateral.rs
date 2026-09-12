use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::PerpError;
use crate::state::{Market, Position};

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(constraint = !market.paused @ PerpError::MarketPaused)]
    pub market: Account<'info, Market>,

    #[account(
        init_if_needed,
        payer = owner,
        space = Position::SIZE,
        seeds = [Position::SEED, owner.key().as_ref(), market.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        address = market.vault @ PerpError::VaultMismatch
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, PerpError::InsufficientCollateral);

    let position = &mut ctx.accounts.position;
    let is_new = position.owner == Pubkey::default();
    if is_new {
        position.owner = ctx.accounts.owner.key();
        position.market = ctx.accounts.market.key();
        position.size = 0;
        position.entry_price = 0;
        position.entry_funding_index = 0;
        position.bump = ctx.bumps.position;
    }

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

    position.collateral = position
        .collateral
        .checked_add(amount)
        .ok_or(PerpError::MathOverflow)?;
    position.last_update_ts = Clock::get()?.unix_timestamp;

    Ok(())
}
