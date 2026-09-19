use anchor_lang::prelude::*;

use crate::constants::MIN_POSITION_NOTIONAL;
use crate::errors::PerpError;
use crate::events::PositionOpened;
use crate::instructions::guards::{require_tradable, sync_position};
use crate::math::session::PriceUse;
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
    // Opening or adding is the canonical increase-risk action, so this is
    // refused outright while the underlying venue is shut.
    let fill_price = ctx
        .accounts
        .oracle
        .validated_price(now, PriceUse::IncreaseRisk)?;
    let funding_index = ctx.accounts.market.cumulative_funding_index;
    let taker_fee_bps = ctx.accounts.market.taker_fee_bps;

    // 1. Normalise for any corporate action, then settle funding against the
    //    *old* size, before it changes. Order matters - see `sync_position`.
    let funding_settled = sync_position(
        &mut ctx.accounts.position,
        &ctx.accounts.oracle,
        funding_index,
    )?;

    // 2. Charge the taker fee on the notional being added, and route it to the
    //    market's insurance balance. The original engine stored `fee_bps` and
    //    never charged it, so the insurance fund had no funding source at all
    //    and could never cover the bad debt it was nominally there for.
    let added_notional = pnl::notional(size_delta, fill_price)?;
    let fee = fixed::to_u64(pnl::fee_on_notional(added_notional, taker_fee_bps)?)?;

    // 3. Re-price the entry and apply the size change. `Position::increase`
    //    also rejects a direction flip: netting two directions inside one
    //    instruction would mean the entry price has to reconcile both.
    let (size_after, entry_price_after) = {
        let position = &mut ctx.accounts.position;
        position.debit_collateral(fee)?;
        position.increase(size_delta, fill_price)?;
        position.last_update_ts = now;
        (position.size, position.entry_price)
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
