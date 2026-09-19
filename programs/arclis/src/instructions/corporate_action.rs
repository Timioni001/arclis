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
use crate::events::CorporateActionApplied;
use crate::instructions::guards::require_oracle_authority;
use crate::math::corporate_actions::SplitRatio;
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
