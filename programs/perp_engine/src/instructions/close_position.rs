use anchor_lang::prelude::*;
use crate::errors::PerpError;
use crate::state::{read_oracle_price, Market, PriceOracle, Position};

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
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
}

pub fn handler(ctx: Context<ClosePosition>, reduce_size: u64) -> Result<()> {
    require!(reduce_size > 0, PerpError::ZeroSize);

    let now = Clock::get()?.unix_timestamp;
    let mark_price = read_oracle_price(&ctx.accounts.oracle, now)?;

    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.position;

    require!(position.size != 0, PerpError::InsufficientPositionSize);
    let abs_size = position.size.unsigned_abs();
    require!(reduce_size <= abs_size, PerpError::InsufficientPositionSize);

    let funding_owed = position.funding_owed(market.cumulative_funding_index)?;
    apply_funding(position, funding_owed)?;

    let total_pnl = position.unrealized_pnl(mark_price)?;
    let realized_pnl = total_pnl
        .checked_mul(reduce_size as i128)
        .ok_or(PerpError::MathOverflow)?
        .checked_div(abs_size as i128)
        .ok_or(PerpError::MathOverflow)?;
    apply_pnl(position, realized_pnl)?;

    let is_long = position.size > 0;
    let new_abs_size = abs_size.checked_sub(reduce_size).ok_or(PerpError::MathOverflow)?;
    position.size = if is_long {
        new_abs_size as i64
    } else {
        -(new_abs_size as i64)
    };
    if new_abs_size == 0 {
        position.entry_price = 0;
    }
    position.entry_funding_index = market.cumulative_funding_index;
    position.last_update_ts = now;

    if is_long {
        market.open_interest_long = market
            .open_interest_long
            .checked_sub(reduce_size)
            .ok_or(PerpError::MathOverflow)?;
    } else {
        market.open_interest_short = market
            .open_interest_short
            .checked_sub(reduce_size)
            .ok_or(PerpError::MathOverflow)?;
    }

    Ok(())
}

fn apply_funding(position: &mut Position, funding_owed: i128) -> Result<()> {
    if funding_owed == 0 {
        return Ok(());
    }
    if funding_owed > 0 {
        position.collateral = position.collateral.saturating_sub(funding_owed as u64);
    } else {
        position.collateral = position
            .collateral
            .checked_add((-funding_owed) as u64)
            .ok_or(PerpError::MathOverflow)?;
    }
    Ok(())
}

fn apply_pnl(position: &mut Position, pnl: i128) -> Result<()> {
    if pnl == 0 {
        return Ok(());
    }
    if pnl > 0 {
        position.collateral = position
            .collateral
            .checked_add(pnl as u64)
            .ok_or(PerpError::MathOverflow)?;
    } else {
        position.collateral = position.collateral.saturating_sub((-pnl) as u64);
    }
    Ok(())
}
