use anchor_lang::prelude::*;
use std::cmp::Ordering;

use crate::constants::MIN_POSITION_NOTIONAL;
use crate::errors::PerpError;
use crate::events::PositionClosed;
use crate::instructions::guards::require_tradable;
use crate::math::{fixed, pnl};
use crate::state::{GlobalConfig, Market, Position, PriceOracle};

#[derive(Accounts)]
pub struct ClosePosition<'info> {
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
}

/// Reduce a position by `reduce_size` base units, realising the proportional
/// share of its PnL. Pass the full absolute size to close out entirely.
///
/// Realised PnL lands in the trader's collateral; it does not leave the vault
/// until `withdraw_collateral`, which is where the solvency check lives.
pub fn handler(ctx: Context<ClosePosition>, reduce_size: u64) -> Result<()> {
    require_tradable(&ctx.accounts.config, &ctx.accounts.market)?;
    require!(reduce_size > 0, PerpError::ZeroSize);

    let now = Clock::get()?.unix_timestamp;
    let fill_price = ctx.accounts.oracle.validated_price(now)?;
    let funding_index = ctx.accounts.market.cumulative_funding_index;
    let taker_fee_bps = ctx.accounts.market.taker_fee_bps;

    require!(
        !ctx.accounts.position.is_flat(),
        PerpError::InsufficientPositionSize
    );
    let abs_size = ctx.accounts.position.size.unsigned_abs();
    require!(reduce_size <= abs_size, PerpError::InsufficientPositionSize);

    // Settle funding on the full size before any of it goes away.
    let funding_settled = ctx.accounts.position.settle_funding(funding_index)?;

    let is_long = ctx.accounts.position.is_long();
    let closed_notional = pnl::notional(fixed::to_i64(i128::from(reduce_size))?, fill_price)?;
    let fee = fixed::to_u64(pnl::fee_on_notional(closed_notional, taker_fee_bps)?)?;

    let (realized_pnl, size_after, fee_charged) = {
        let position = &mut ctx.accounts.position;

        // Realise the closed fraction of PnL. Entry price is left untouched, so
        // the surviving remainder keeps its original cost basis.
        let total_pnl = position.unrealized_pnl(fill_price)?;
        let realized = fixed::mul_div(total_pnl, i128::from(reduce_size), i128::from(abs_size))?;
        position.apply_realized_pnl(realized)?;

        // The fee is charged after PnL, and saturates rather than failing: a
        // position closing at a total loss should still be closable, otherwise
        // the trader is trapped and the market keeps carrying the exposure.
        // Book the amount actually taken, not the amount owed - crediting
        // insurance with a fee the position could not pay would invent value.
        let fee_charged = fee.min(position.collateral);
        position.collateral -= fee_charged;

        let new_abs = abs_size
            .checked_sub(reduce_size)
            .ok_or(PerpError::MathOverflow)?;
        let new_size = if is_long {
            fixed::to_i64(i128::from(new_abs))?
        } else {
            -fixed::to_i64(i128::from(new_abs))?
        };
        position.size = new_size;
        if new_abs == 0 {
            position.entry_price = 0;
        }
        position.last_update_ts = now;
        (realized, new_size, fee_charged)
    };

    {
        let market = &mut ctx.accounts.market;
        // Reduce open interest on the side the position was actually on.
        let oi_delta = if is_long {
            fixed::to_i64(i128::from(reduce_size))?
        } else {
            -fixed::to_i64(i128::from(reduce_size))?
        };
        market.apply_open_interest(oi_delta, false)?;

        // Reconcile liabilities with what actually happened to collateral.
        // Realised profit increases what the vault owes; a loss decreases it.
        match realized_pnl.cmp(&0) {
            Ordering::Greater => market.credit_collateral(fixed::to_u64(realized_pnl)?)?,
            Ordering::Less => {
                let loss =
                    fixed::to_u64(realized_pnl.checked_neg().ok_or(PerpError::MathOverflow)?)?;
                // A loss larger than the position's collateral is bad debt, not
                // a liability reduction we can book - clamp to what was
                // actually there and record the difference.
                let bookable = loss.min(market.total_collateral);
                market.debit_collateral(bookable)?;
                market.credit_insurance(bookable)?;
                if loss > bookable {
                    market.record_bad_debt(loss - bookable)?;
                }
            }
            Ordering::Equal => {}
        }
        let bookable_fee = fee_charged.min(market.total_collateral);
        market.debit_collateral(bookable_fee)?;
        market.credit_insurance(bookable_fee)?;
    }

    // A partial close must not leave behind a position too small to be worth
    // liquidating. Closing out entirely is always allowed.
    if size_after != 0 {
        let remaining_notional = pnl::notional(size_after, fill_price)?;
        require!(
            remaining_notional >= i128::from(MIN_POSITION_NOTIONAL),
            PerpError::PositionTooSmall
        );
    }

    emit!(PositionClosed {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        reduce_size,
        size_after,
        fill_price,
        realized_pnl,
        fee: fee_charged,
        funding_settled,
    });
    Ok(())
}
