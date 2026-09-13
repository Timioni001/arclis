use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::errors::PerpError;
use crate::state::{
    Market, PriceOracle, MAX_LEVERAGE_CAP, MIN_LEVERAGE_CAP, MIN_MARGIN_RATIO_BPS_CEIL,
    MIN_MARGIN_RATIO_BPS_FLOOR, ORACLE_KIND_MOCK, ORACLE_KIND_PYTH,
};

/// Anyone can list a market for any asset backed by an oracle - either a
/// real Pyth price feed (production path) or a mock oracle account (local
/// devnet testing path). This is what makes the engine general-purpose
/// rather than a fixed stock list: a market is just an oracle reference
/// plus a few risk parameters.
///
/// oracle_ref meaning depends on oracle_kind:
/// - ORACLE_KIND_MOCK: the mock_oracle account's own pubkey, as bytes
/// - ORACLE_KIND_PYTH: the Pyth price feed id, e.g. the id for
///   Equity.US.AAPL/USD from https://docs.pyth.network/price-feeds/price-feeds
#[derive(Accounts)]
#[instruction(oracle_kind: u8, oracle_ref: [u8; 32])]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Required, and checked against oracle_ref, when oracle_kind == ORACLE_KIND_MOCK.
    /// Left as None when listing a real Pyth-backed market.
    pub mock_oracle: Option<Account<'info, PriceOracle>>,

    #[account(
        init,
        payer = creator,
        space = Market::SIZE,
        seeds = [Market::SEED, oracle_ref.as_ref()],
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
    oracle_kind: u8,
    oracle_ref: [u8; 32],
    max_leverage: u8,
    min_margin_ratio_bps: u16,
    funding_interval_secs: i64,
) -> Result<()> {
    require!(
        oracle_kind == ORACLE_KIND_MOCK || oracle_kind == ORACLE_KIND_PYTH,
        PerpError::OracleMismatch
    );
    if oracle_kind == ORACLE_KIND_MOCK {
        let mock = ctx.accounts.mock_oracle.as_ref().ok_or(PerpError::OracleMismatch)?;
        require!(mock.key().to_bytes() == oracle_ref, PerpError::OracleMismatch);
    }
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
    market.oracle_kind = oracle_kind;
    market.oracle_ref = oracle_ref;
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
