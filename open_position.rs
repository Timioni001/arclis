use anchor_lang::prelude::*;
use crate::errors::PerpError;
use crate::state::{read_oracle_price, Market, PriceOracle, Position, PRICE_SCALE};

#[derive(Accounts)]
pub struct OpenPosition<'info> {
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

/// size_delta is signed base size (PRICE_SCALE-denominated): positive to go
/// long / add to a long, negative to go short / add to a short. Flipping
/// direction in one call is disallowed on purpose - close first, then open
/// the other way - so entry price accounting never has to net two directions
/// in the same transaction.
pub fn handler(ctx: Context<OpenPosition>, size_delta: i64) -> Result<()> {
    require!(size_delta != 0, PerpError::ZeroSize);

    let now = Clock::get()?.unix_timestamp;
    let mark_price = read_oracle_price(&ctx.accounts.oracle, now)?;

    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.position;

    if position.size != 0 {
        let same_direction = (position.size > 0) == (size_delta > 0);
        require!(same_direction, PerpError::InsufficientPositionSize);
    }

    // Settle funding accrued so far into collateral before changing size,
    // so the new entry_funding_index always starts from a clean slate.
    let funding_owed = position.funding_owed(market.cumulative_funding_index)?;
    settle_funding(position, funding_owed)?;

    let old_size = position.size as i128;
    let new_size = old_size
        .checked_add(size_delta as i128)
        .ok_or(PerpError::MathOverflow)?;

    // Weighted-average entry price across the old and new size.
    let old_notional = old_size
        .checked_abs()
        .ok_or(PerpError::MathOverflow)?
        .checked_mul(position.entry_price as i128)
        .ok_or(PerpError::MathOverflow)?;
    let added_notional = (size_delta as i128)
        .checked_abs()
        .ok_or(PerpError::MathOverflow)?
        .checked_mul(mark_price as i128)
        .ok_or(PerpError::MathOverflow)?;
    let new_abs_size = new_size.checked_abs().ok_or(PerpError::MathOverflow)?;
    let new_entry_price = if new_abs_size == 0 {
        0
    } else {
        old_notional
            .checked_add(added_notional)
            .ok_or(PerpError::MathOverflow)?
            .checked_div(new_abs_size)
            .ok_or(PerpError::MathOverflow)?
    };

    position.size = new_size as i64;
    position.entry_price = new_entry_price as u64;
    position.entry_funding_index = market.cumulative_funding_index;
    position.last_update_ts = now;

    // Update market open interest on the side that grew.
    let added_abs = (size_delta.unsigned_abs()) as u64;
    if size_delta > 0 {
        market.open_interest_long = market
            .open_interest_long
            .checked_add(added_abs)
            .ok_or(PerpError::MathOverflow)?;
    } else {
        market.open_interest_short = market
            .open_interest_short
            .checked_add(added_abs)
            .ok_or(PerpError::MathOverflow)?;
    }

    // Leverage check: notional / equity must stay within the market's cap.
    let notional = (new_abs_size as u128)
        .checked_mul(mark_price as u128)
        .ok_or(PerpError::MathOverflow)?
        .checked_div(PRICE_SCALE)
        .ok_or(PerpError::MathOverflow)?;
    let max_notional = (position.collateral as u128)
        .checked_mul(market.max_leverage as u128)
        .ok_or(PerpError::MathOverflow)?;
    require!(notional <= max_notional, PerpError::ExceedsMaxLeverage);

    Ok(())
}

fn settle_funding(position: &mut Position, funding_owed: i128) -> Result<()> {
    if funding_owed == 0 {
        return Ok(());
    }
    if funding_owed > 0 {
        // Position owes funding: reduce collateral, floor at zero (a large
        // unpaid funding bill should already have been caught by liquidation).
        let owed = funding_owed as u64;
        position.collateral = position.collateral.saturating_sub(owed);
    } else {
        let received = (-funding_owed) as u64;
        position.collateral = position
            .collateral
            .checked_add(received)
            .ok_or(PerpError::MathOverflow)?;
    }
    Ok(())
}
