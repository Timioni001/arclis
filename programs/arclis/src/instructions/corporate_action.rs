//! Publishing corporate actions.
//!
//! The scenario this exists for: AAPL runs a 4-for-1 split. The oracle price
//! drops 75% overnight. Without this instruction the engine sees a 75% crash,
//! and every long in the market becomes liquidatable for a price move that
//! economically did not happen.
//!
//! The fix has to be atomic. Oracle price, market open interest, the funding
//! index, and the cumulative split factor all move in this one transaction. If
//! any of them lagged, there would be a window in which the book was mispriced
//! by a factor of four — and on Solana that window is long enough to be
//! sandwiched deliberately.
//!
//! Positions are the exception, because there can be thousands of them and
//! there is no way to iterate accounts on-chain. They carry the factor they
//! were opened at and rescale themselves the next time they are touched. See
//! [`crate::math::corporate_actions`] for why that is equivalent.

use anchor_lang::prelude::*;

use crate::errors::ArclisError;
use crate::events::{CorporateActionApplied, DividendApplied};
use crate::instructions::guards::require_oracle_authority;
use crate::math::corporate_actions::{Dividend, SplitRatio};
use crate::math::session::MarketSession;
use crate::state::{Market, PriceOracle};

#[derive(Accounts)]
pub struct ApplyCorporateAction<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [PriceOracle::SEED, oracle.symbol.as_ref()],
        bump = oracle.bump
    )]
    pub oracle: Account<'info, PriceOracle>,

    #[account(
        mut,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

/// Apply a split or reverse split.
///
/// `4:1` is `numerator = 4, denominator = 1`. `1:10` reverse is
/// `numerator = 1, denominator = 10`.
pub fn apply_split(
    ctx: Context<ApplyCorporateAction>,
    numerator: u32,
    denominator: u32,
) -> Result<()> {
    require_oracle_authority(&ctx.accounts.oracle, &ctx.accounts.authority.key())?;

    // Corporate actions land between sessions, which is also the only time it
    // is safe to apply one: with the venue open, a position could be opened
    // against the pre-split price and normalised against the post-split factor
    // inside the same slot.
    require!(
        ctx.accounts.oracle.session != MarketSession::Open,
        ArclisError::SessionMustBeClosedForCorporateAction
    );

    let ratio = SplitRatio {
        numerator,
        denominator,
    };
    let now = Clock::get()?.unix_timestamp;

    let from_factor = ctx.accounts.oracle.split_factor;
    let price_before = ctx.accounts.oracle.price;

    let to_factor = ctx.accounts.oracle.apply_split(ratio, now)?;
    ctx.accounts.market.apply_split(from_factor, to_factor)?;

    emit!(CorporateActionApplied {
        oracle: ctx.accounts.oracle.key(),
        market: ctx.accounts.market.key(),
        authority: ctx.accounts.authority.key(),
        numerator,
        denominator,
        split_factor_before: from_factor,
        split_factor_after: to_factor,
        price_before,
        price_after: ctx.accounts.oracle.price,
        sequence: ctx.accounts.oracle.corporate_action_seq,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Cash dividends
// ---------------------------------------------------------------------------

/// A dividend needs the oracle only to prove authority and to price the
/// sanity check, so unlike a split it never writes to it.
#[derive(Accounts)]
pub struct ApplyDividend<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [PriceOracle::SEED, oracle.symbol.as_ref()],
        bump = oracle.bump
    )]
    pub oracle: Account<'info, PriceOracle>,

    #[account(
        mut,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

/// Record a cash dividend against every open position at once.
///
/// # Why a perp needs this at all
///
/// A perp on a stock that pays dividends has a hole in it that a perp on a
/// token does not. On the ex-date the share price drops by roughly the
/// dividend, mechanically, because the buyer no longer receives it. A holder
/// of the actual share is made whole by the cash. A long on a naive perp is
/// not: they take the price drop and get nothing back. Run that on a 3%
/// yielder four times a year and being long costs 3% a year for no reason,
/// while being short earns it - a standing arbitrage against every long in the
/// market.
///
/// So the credit is not a nicety. It is what makes the contract track the
/// thing it claims to track.
///
/// # Mechanics
///
/// The same cumulative-index trick as funding and splits: move one `i128` on
/// the market and every open position settles its own share the next time it
/// is touched. There is no iteration over positions, because on Solana there
/// cannot be.
///
/// `per_share` is quote per base unit at `PRICE_SCALE`. It is always positive:
/// the direction comes from the sign of each position's size, so a long is
/// credited and a short pays.
pub fn apply_dividend(ctx: Context<ApplyDividend>, per_share: u64) -> Result<()> {
    require_oracle_authority(&ctx.accounts.oracle, &ctx.accounts.authority.key())?;

    // Same reasoning as a split: the index and the ex-date price move in
    // different transactions no matter what, so the credit is recorded while
    // the venue is shut and the two land together at the open. Applying it
    // mid-session would let a position open after the index moved and before
    // the price dropped, collecting the credit without the drop.
    require!(
        ctx.accounts.oracle.session != MarketSession::Open,
        ArclisError::SessionMustBeClosedForCorporateAction
    );

    // Bounds the blast radius of a compromised oracle authority. A dividend
    // worth a large fraction of the share price is not a dividend, it is a
    // transfer from every short in the market, and it should not be reachable
    // in one transaction.
    let price = ctx.accounts.oracle.price;
    Dividend { per_share }.validate(price)?;

    let index_before = ctx.accounts.market.cumulative_dividend_index;
    ctx.accounts.market.apply_dividend(per_share)?;

    let now = Clock::get()?.unix_timestamp;
    let sequence = ctx.accounts.oracle.record_corporate_action(now)?;

    emit!(DividendApplied {
        oracle: ctx.accounts.oracle.key(),
        market: ctx.accounts.market.key(),
        authority: ctx.accounts.authority.key(),
        per_share,
        price_at_record: price,
        dividend_index_before: index_before,
        dividend_index_after: ctx.accounts.market.cumulative_dividend_index,
        sequence,
    });
    Ok(())
}
