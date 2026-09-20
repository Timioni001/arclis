use anchor_lang::prelude::*;

use crate::constants::{MAX_ORACLE_STALENESS_SECS, SPLIT_FACTOR_SCALE};
use crate::errors::ArclisError;
use crate::events::SessionChanged;
use crate::math::session::MarketSession;
use crate::state::PriceOracle;

#[derive(Accounts)]
#[instruction(symbol: [u8; 16])]
pub struct InitializePriceOracle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = PriceOracle::SIZE,
        seeds = [PriceOracle::SEED, symbol.as_ref()],
        bump
    )]
    pub oracle: Box<Account<'info, PriceOracle>>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_price_oracle(
    ctx: Context<InitializePriceOracle>,
    symbol: [u8; 16],
    initial_price: u64,
) -> Result<()> {
    require!(initial_price > 0, ArclisError::InvalidOraclePrice);

    let oracle = &mut ctx.accounts.oracle;
    oracle.authority = ctx.accounts.authority.key();
    oracle.symbol = symbol;
    oracle.price = initial_price;
    oracle.confidence = 0;
    let clock = Clock::get()?;
    oracle.last_update_ts = clock.unix_timestamp;
    oracle.update_slot = clock.slot;
    // A new feed starts shut. The authority opens it explicitly once it is
    // actually publishing live prices, so a market cannot be traded against a
    // feed that has only ever had its seed price written.
    oracle.session = MarketSession::Closed;
    oracle.session_updated_ts = clock.unix_timestamp;
    oracle.split_factor = SPLIT_FACTOR_SCALE;
    oracle.corporate_action_seq = 0;
    oracle.bump = ctx.bumps.oracle;
    oracle._reserved = [0u8; 32];
    Ok(())
}

#[derive(Accounts)]
pub struct UpdatePriceOracle<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ArclisError::Unauthorized,
        seeds = [PriceOracle::SEED, oracle.symbol.as_ref()],
        bump = oracle.bump
    )]
    pub oracle: Box<Account<'info, PriceOracle>>,
}

/// Push a new price.
///
/// The deviation cap is the meaningful addition over the original engine: a
/// compromised keeper key can still walk the price wherever it wants, but it
/// can no longer do it in one transaction, which is the difference between an
/// atomic drain and an attack that liquidations and monitoring can react to.
pub fn update_price_oracle(
    ctx: Context<UpdatePriceOracle>,
    price: u64,
    confidence: u64,
) -> Result<()> {
    require!(price > 0, ArclisError::InvalidOraclePrice);

    let clock = Clock::get()?;
    let oracle = &mut ctx.accounts.oracle;
    oracle.check_deviation(price)?;

    oracle.price = price;
    oracle.confidence = confidence;
    oracle.last_update_ts = clock.unix_timestamp;
    oracle.update_slot = clock.slot;
    Ok(())
}

#[derive(Accounts)]
pub struct SetMarketSession<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ArclisError::NotOracleAuthority,
        seeds = [PriceOracle::SEED, oracle.symbol.as_ref()],
        bump = oracle.bump
    )]
    pub oracle: Box<Account<'info, PriceOracle>>,
}

/// Publish the trading state of the underlying venue.
///
/// This is the instruction a keeper calls at 09:30 and 16:00 New York, and on
/// any halt. Everything equity-specific in the engine keys off it - see
/// [`crate::math::session`] for the full matrix of what each state permits.
///
/// Reopening deliberately requires a fresh price in the same breath: a session
/// flipped to `Open` while the last print is Friday's close would let the first
/// trader through the door trade against a three-day-old price, which is
/// exactly the free option the session model exists to close.
pub fn set_market_session(ctx: Context<SetMarketSession>, session: MarketSession) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let oracle = &mut ctx.accounts.oracle;
    let previous = oracle.session;

    if session == MarketSession::Open {
        let age = now
            .checked_sub(oracle.last_update_ts)
            .ok_or(ArclisError::MathOverflow)?;
        require!(
            (0..=MAX_ORACLE_STALENESS_SECS).contains(&age),
            ArclisError::StaleOracle
        );
    }

    oracle.session = session;
    oracle.session_updated_ts = now;

    emit!(SessionChanged {
        oracle: oracle.key(),
        authority: ctx.accounts.authority.key(),
        previous,
        current: session,
        price: oracle.price,
        ts: now,
    });
    Ok(())
}
