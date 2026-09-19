use anchor_lang::prelude::*;

use crate::constants::MIN_POSITION_NOTIONAL;
use crate::errors::PerpError;
use crate::events::PositionOpened;
use crate::instructions::guards::require_tradable;
use crate::math::{fixed, pnl};
use crate::state::{GlobalConfig, Market, Position, PriceOracle};

#[derive(Accounts)]
pub struct OpenPosition<'info> {
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

/// Increase a position. `size_delta` is signed base size at `BASE_SCALE`:
/// positive opens or adds to a long, negative to a short.
///
/// Flipping direction in one call is rejected rather than netted, so entry-price
/// accounting never has to reconcile two directions inside one instruction.
/// Close first, then open the other way.
pub fn handler(ctx: Context<OpenPosition>, size_delta: i64) -> Result<()> {
    require_tradable(&ctx.accounts.config, &ctx.accounts.market)?;
    require!(size_delta != 0, PerpError::ZeroSize);

    let now = Clock::get()?.unix_timestamp;
    let fill_price = ctx.accounts.oracle.validated_price(now)?;
    let funding_index = ctx.accounts.market.cumulative_funding_index;
    let taker_fee_bps = ctx.accounts.market.taker_fee_bps;

    {
        let position = &ctx.accounts.position;
        if !position.is_flat() {
            require!(
                position.is_long() == (size_delta > 0),
                PerpError::DirectionFlip
            );
        }
    }

    // 1. Settle funding against the *old* size, before it changes.
    let funding_settled = ctx.accounts.position.settle_funding(funding_index)?;

    // 2. Charge the taker fee on the notional being added, and route it to the
    //    market's insurance balance. The original engine stored `fee_bps` and
    //    never charged it, so the insurance fund had no funding source at all
    //    and could never cover the bad debt it was nominally there for.
    let added_notional = pnl::notional(size_delta, fill_price)?;
    let fee = fixed::to_u64(pnl::fee_on_notional(added_notional, taker_fee_bps)?)?;

    // 3. Re-price the entry and apply the size change.
    let (size_after, entry_price_after) = {
        let position = &mut ctx.accounts.position;
        position.debit_collateral(fee)?;

        let new_entry =
            pnl::weighted_entry_price(position.size, position.entry_price, size_delta, fill_price)?;
        let new_size = fixed::to_i64(
            i128::from(position.size)
                .checked_add(i128::from(size_delta))
                .ok_or(PerpError::MathOverflow)?,
        )?;

        position.size = new_size;
        position.entry_price = new_entry;
        position.last_update_ts = now;
        (new_size, new_entry)
    };

    // 4. Move the fee from trader collateral into insurance. Both sides of the
    //    market's liability accounting move together.
    {
        let market = &mut ctx.accounts.market;
        market.debit_collateral(fee)?;
        market.credit_insurance(fee)?;
        market.apply_open_interest(size_delta, true)?;
    }

    // 5. Dust guard: a position too small to be worth a liquidation
    //    transaction becomes permanent bad debt if it goes underwater, because
    //    no rational liquidator will ever close it.
    let total_notional = pnl::notional(size_after, fill_price)?;
    require!(
        total_notional >= i128::from(MIN_POSITION_NOTIONAL),
        PerpError::PositionTooSmall
    );

    // 6. Health check last, on the final state. This is the check the original
    //    engine got wrong: it compared notional against raw collateral times
    //    leverage, ignoring unrealised PnL and unsettled funding, so a position
    //    deep in the red could add to itself and land below maintenance margin
    //    in the same instruction.
    ctx.accounts
        .position
        .require_initial_margin(fill_price, &ctx.accounts.market)?;

    emit!(PositionOpened {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        size_delta,
        size_after,
        fill_price,
        entry_price_after,
        fee,
        funding_settled,
    });
    Ok(())
}
