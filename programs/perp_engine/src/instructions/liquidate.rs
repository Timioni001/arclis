use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::PerpError;
use crate::state::{read_oracle_price, Market, PriceOracle, Position, BPS_SCALE, LIQUIDATOR_REWARD_BPS};

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub liquidator: Signer<'info>,

    #[account(mut)]
    pub liquidator_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(address = market.oracle @ PerpError::OracleMismatch)]
    pub oracle: Account<'info, PriceOracle>,

    #[account(
        mut,
        seeds = [Position::SEED, position.owner.as_ref(), market.key().as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        address = market.vault @ PerpError::VaultMismatch
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Liquidate>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mark_price = read_oracle_price(&ctx.accounts.oracle, now)?;

    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.position;
    require!(position.size != 0, PerpError::InsufficientPositionSize);

    let margin_ratio_bps = position.margin_ratio_bps(mark_price, market.cumulative_funding_index)?;
    require!(
        margin_ratio_bps < market.min_margin_ratio_bps as i128,
        PerpError::PositionHealthy
    );

    let funding_owed = position.funding_owed(market.cumulative_funding_index)?;
    let pnl = position.unrealized_pnl(mark_price)?;
    let net = pnl.checked_sub(funding_owed).ok_or(PerpError::MathOverflow)?;

    let equity: i128 = (position.collateral as i128)
        .checked_add(net)
        .ok_or(PerpError::MathOverflow)?;
    let equity_u64: u64 = if equity > 0 { equity as u64 } else { 0 };

    let reward = (equity_u64 as u128)
        .checked_mul(LIQUIDATOR_REWARD_BPS)
        .ok_or(PerpError::MathOverflow)?
        .checked_div(BPS_SCALE)
        .ok_or(PerpError::MathOverflow)? as u64;

    let remaining = equity_u64.checked_sub(reward).ok_or(PerpError::MathOverflow)?;

    let is_long = position.size > 0;
    let abs_size = position.size.unsigned_abs();
    if is_long {
        market.open_interest_long = market
            .open_interest_long
            .checked_sub(abs_size)
            .ok_or(PerpError::MathOverflow)?;
    } else {
        market.open_interest_short = market
            .open_interest_short
            .checked_sub(abs_size)
            .ok_or(PerpError::MathOverflow)?;
    }

    position.size = 0;
    position.entry_price = 0;
    position.entry_funding_index = market.cumulative_funding_index;
    position.collateral = remaining;
    position.last_update_ts = now;

    if reward > 0 {
        let oracle_key = ctx.accounts.oracle.key();
        let market_bump = market.bump;
        let seeds: &[&[u8]] = &[Market::SEED, oracle_key.as_ref(), &[market_bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.liquidator_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[seeds],
            ),
            reward,
        )?;
    }

    Ok(())
}
