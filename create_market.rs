use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::errors::PerpError;
use crate::state::{Market, PriceOracle, MAX_LEVERAGE_CAP, MIN_LEVERAGE_CAP, MIN_MARGIN_RATIO_BPS_CEIL, MIN_MARGIN_RATIO_BPS_FLOOR};

/// Anyone can list a market for any asset that has a PriceOracle account.
/// This is what makes the engine general-purpose rather than a fixed
/// stock list: a market is just an oracle plus a few risk parameters.
#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub oracle: Account<'info, PriceOracle>,

    #[account(
        init,
        payer = creator,
        space = Market::SIZE,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        seeds = [Market::VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<CreateMarket>,
    max_leverage: u8,
    min_margin_ratio_bps: u16,
    funding_interval_secs: i64,
) -> Result<()> {
    require!(
        (MIN_LEVERAGE_CAP..=MAX_LEVERAGE_CAP).contains(&max_leverage),
        PerpError::InvalidLeverageParam
    );
    require!(
        (MIN_MARGIN_RATIO_BPS_FLOOR..=MIN_MARGIN_RATIO_BPS_CEIL).contains(&min_margin_ratio_bps),
        PerpError::InvalidMarginParam
    );
    require!(funding_interval_secs > 0, PerpError::InvalidMarginParam);

    let market = &mut ctx.accounts.market;
    market.oracle = ctx.accounts.oracle.key();
    market.vault = ctx.accounts.vault.key();
    market.vault_bump = ctx.bumps.vault;
    market.max_leverage = max_leverage;
    market.min_margin_ratio_bps = min_margin_ratio_bps;
    market.funding_interval_secs = funding_interval_secs;
    market.last_funding_ts = Clock::get()?.unix_timestamp;
    market.cumulative_funding_index = 0;
    market.open_interest_long = 0;
    market.open_interest_short = 0;
    market.paused = false;
    market.bump = ctx.bumps.market;
    Ok(())
}
