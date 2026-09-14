use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::PerpError;
use crate::state::{read_oracle_price, Market, PriceOracle, Position, BPS_SCALE, PRICE_SCALE};

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump,
        constraint = !market.paused @ PerpError::MarketPaused
    )]
    pub market: Account<'info, Market>,

    #[account(address = market.oracle @ PerpError::OracleMismatch)]
    pub oracle: Account<'info, PriceOracle>,

    #[account(
        mut,
        has_one = owner,
        seeds = [Position::SEED, owner.key().as_ref(), market.key().as_ref()],
        bump = position.bump
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
}

pub fn handler(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, PerpError::InsufficientCollateral);
    let position = &mut ctx.accounts.position;
    require!(position.collateral >= amount, PerpError::InsufficientCollateral);

    let now = Clock::get()?.unix_timestamp;
    let mark_price = read_oracle_price(&ctx.accounts.oracle, now)?;

    let post_withdraw_collateral = position
        .collateral
        .checked_sub(amount)
        .ok_or(PerpError::MathOverflow)?;

    if position.size != 0 {
        let market = &ctx.accounts.market;
        let notional = (position.size.unsigned_abs() as u128)
            .checked_mul(mark_price as u128)
            .ok_or(PerpError::MathOverflow)?
            .checked_div(PRICE_SCALE)
            .ok_or(PerpError::MathOverflow)? as i128;

        let pnl = position.unrealized_pnl(mark_price)?;
        let funding = position.funding_owed(market.cumulative_funding_index)?;
        let equity = (post_withdraw_collateral as i128)
            .checked_add(pnl)
            .ok_or(PerpError::MathOverflow)?
            .checked_sub(funding)
            .ok_or(PerpError::MathOverflow)?;

        let margin_ratio_bps = equity
            .checked_mul(BPS_SCALE as i128)
            .ok_or(PerpError::MathOverflow)?
            .checked_div(notional)
            .ok_or(PerpError::MathOverflow)?;

        require!(
            margin_ratio_bps >= market.min_margin_ratio_bps as i128,
            PerpError::WithdrawalBreaksMargin
        );
    }

    let oracle_key = ctx.accounts.oracle.key();
    let market_bump = ctx.accounts.market.bump;
    let seeds: &[&[u8]] = &[Market::SEED, oracle_key.as_ref(), &[market_bump]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    position.collateral = post_withdraw_collateral;
    position.last_update_ts = now;
    Ok(())
}
