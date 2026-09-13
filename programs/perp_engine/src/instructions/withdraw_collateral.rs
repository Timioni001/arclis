use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use crate::errors::PerpError;
use crate::state::{read_price, Market, PriceOracle, Position, BPS_SCALE, PRICE_SCALE};

#[derive(Accounts)]
#[instruction(oracle_ref: [u8; 32])]
pub struct WithdrawCollateral<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [Market::SEED, oracle_ref.as_ref()],
        bump = market.bump,
        constraint = !market.paused @ PerpError::MarketPaused
    )]
    pub market: Account<'info, Market>,

    pub mock_oracle: Option<Account<'info, PriceOracle>>,
    pub pyth_price_update: Option<Account<'info, PriceUpdateV2>>,

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

pub fn handler(ctx: Context<WithdrawCollateral>, oracle_ref: [u8; 32], amount: u64) -> Result<()> {
    require!(amount > 0, PerpError::InsufficientCollateral);
    let _ = oracle_ref;

    let position = &mut ctx.accounts.position;
    require!(position.collateral >= amount, PerpError::InsufficientCollateral);

    let now = Clock::get()?.unix_timestamp;
    let market = &ctx.accounts.market;
    let mark_price = read_price(
        market,
        ctx.accounts.mock_oracle.as_ref(),
        ctx.accounts.pyth_price_update.as_ref(),
        now,
    )?;

    // Simulate the withdrawal against margin requirements before moving funds.
    let post_withdraw_collateral = position
        .collateral
        .checked_sub(amount)
        .ok_or(PerpError::MathOverflow)?;

    if position.size != 0 {
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

    // The vault's token authority is the Market PDA itself (see create_market),
    // so we sign the CPI with the market's own seeds, not the vault's.
    let market_bump = market.bump;
    let seeds: &[&[u8]] = &[Market::SEED, oracle_ref.as_ref(), &[market_bump]];

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
