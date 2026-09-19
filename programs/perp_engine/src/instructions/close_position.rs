use anchor_lang::prelude::*;

use crate::constants::MIN_POSITION_NOTIONAL;
use crate::errors::PerpError;
use crate::events::PositionClosed;
use crate::instructions::guards::{require_tradable, sync_position};
use crate::math::session::PriceUse;
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
    // Reducing risk stays available against a settled closing price, so a
    // trader is not trapped in a position all weekend.
    let fill_price = ctx
        .accounts
        .oracle
        .validated_price(now, PriceUse::ReduceRisk)?;
    let funding_index = ctx.accounts.market.cumulative_funding_index;
    let taker_fee_bps = ctx.accounts.market.taker_fee_bps;

    // Normalise for corporate actions and settle funding *before* reading size.
    // `reduce_size` is quoted in post-split base units, so checking it against
    // an un-normalised size would reject a valid full close after a 4-for-1.
    let funding_settled = sync_position(
        &mut ctx.accounts.position,
        &ctx.accounts.oracle,
        funding_index,
    )?;

    require!(
        !ctx.accounts.position.is_flat(),
        PerpError::InsufficientPositionSize
    );
    let abs_size = ctx.accounts.position.size.unsigned_abs();
    require!(reduce_size <= abs_size, PerpError::InsufficientPositionSize);

    let is_long = ctx.accounts.position.is_long();
    let closed_notional = pnl::notional(fixed::to_i64(i128::from(reduce_size))?, fill_price)?;
    let fee = fixed::to_u64(pnl::fee_on_notional(closed_notional, taker_fee_bps)?)?;

    let (realized_pnl, size_after, fee_charged) = {
        let position = &mut ctx.accounts.position;
        let realized = position.reduce(reduce_size, fill_price)?;

        // The fee is charged after PnL and saturates rather than failing: a
        // position closing at a total loss must still be closable, or the
        // trader is trapped and the market keeps carrying the exposure. Book
        // what was actually taken, not what was owed - crediting insurance with
        // a fee the position could not pay would invent value.
        let fee_charged = fee.min(position.collateral);
        position.collateral -= fee_charged;
        position.last_update_ts = now;
        (realized, position.size, fee_charged)
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
        market.settle_realized_pnl(realized_pnl)?;

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
