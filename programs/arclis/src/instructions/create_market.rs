use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::ArclisError;
use crate::events::MarketCreated;
use crate::state::{GlobalConfig, Market, PriceOracle};

/// Parameters for a new market, passed as one struct.
///
/// The original signature took three loose arguments; this now configures nine
/// risk knobs, and an unnamed nine-argument call is a bug waiting to happen at
/// the TypeScript boundary where argument order is unchecked.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct MarketParams {
    pub max_leverage: u8,
    pub maintenance_margin_bps: u16,
    pub taker_fee_bps: u16,
    pub liquidation_penalty_bps: u16,
    pub funding_interval_secs: i64,
    pub funding_sensitivity_bps: u16,
    pub max_open_interest: u64,
    pub max_skew_bps: u16,
    /// Cap on liquidity-pool utilisation, in bps of pool NAV. This is the
    /// market's main solvency dial: it bounds how much directional exposure the
    /// pool can be made to carry relative to the capital standing behind it.
    pub max_utilization_bps: u16,
}

impl MarketParams {
    /// Validate every parameter against the protocol-wide bounds.
    ///
    /// Market creation is permissionless, which means these bounds are the only
    /// thing standing between a trader and a market deliberately configured to
    /// be unsurvivable. Each one is a hard limit, not a default.
    pub fn validate(&self) -> Result<u16> {
        require!(
            (MIN_LEVERAGE_CAP..=MAX_LEVERAGE_CAP).contains(&self.max_leverage),
            ArclisError::InvalidLeverageParam
        );
        require!(
            (MIN_MARGIN_RATIO_BPS_FLOOR..=MIN_MARGIN_RATIO_BPS_CEIL)
                .contains(&self.maintenance_margin_bps),
            ArclisError::InvalidMarginParam
        );
        require!(
            (MIN_FUNDING_INTERVAL_SECS..=MAX_FUNDING_INTERVAL_SECS)
                .contains(&self.funding_interval_secs),
            ArclisError::InvalidFundingInterval
        );
        require!(
            self.funding_sensitivity_bps <= MAX_FUNDING_SENSITIVITY_BPS,
            ArclisError::InvalidFundingSensitivity
        );
        require!(
            self.taker_fee_bps <= MAX_FEE_BPS,
            ArclisError::InvalidFeeParam
        );
        require!(
            self.liquidation_penalty_bps <= MAX_LIQUIDATION_PENALTY_BPS,
            ArclisError::InvalidPenaltyParam
        );
        require!(self.max_open_interest > 0, ArclisError::InvalidMarginParam);
        require!(
            self.max_skew_bps as i128 <= BPS_SCALE,
            ArclisError::InvalidMarginParam
        );
        require!(
            (MIN_UTILIZATION_CAP_BPS..=MAX_UTILIZATION_CAP_BPS).contains(&self.max_utilization_bps),
            ArclisError::InvalidUtilizationCap
        );

        // Initial margin sits a fixed buffer above maintenance, so a position
        // can never be opened already inside the liquidation band. Derived
        // rather than configured: letting a market creator set initial below
        // maintenance would make every new position instantly liquidatable.
        let initial = i128::from(self.maintenance_margin_bps)
            .checked_add(INITIAL_MARGIN_BUFFER_BPS)
            .ok_or(ArclisError::MathOverflow)?;
        require!(initial <= BPS_SCALE, ArclisError::InvalidMarginParam);

        // Leverage and margin must be mutually consistent: 20x implies at most
        // a 5% initial margin, so a market asking for both is misconfigured.
        let implied_max_leverage_bps = BPS_SCALE
            .checked_div(i128::from(self.max_leverage))
            .ok_or(ArclisError::DivideByZero)?;
        require!(
            initial <= implied_max_leverage_bps,
            ArclisError::InvalidMarginParam
        );

        Ok(initial as u16)
    }
}

/// Anyone can list a market for any asset that already has a `PriceOracle`.
/// That permissionlessness is what makes this a general engine rather than a
/// fixed stock list - and it is exactly why `MarketParams::validate` is strict.
#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    pub oracle: Account<'info, PriceOracle>,

    #[account(
        init,
        payer = creator,
        space = Market::SIZE,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,

    pub quote_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        seeds = [Market::VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = market,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<CreateMarket>, params: MarketParams) -> Result<()> {
    require!(!ctx.accounts.config.paused, ArclisError::ProtocolPaused);
    let initial_margin_bps = params.validate()?;

    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.market;

    market.oracle = ctx.accounts.oracle.key();
    market.vault = ctx.accounts.vault.key();
    market.creator = ctx.accounts.creator.key();
    market.vault_bump = ctx.bumps.vault;
    market.bump = ctx.bumps.market;
    market.paused = false;

    market.max_leverage = params.max_leverage;
    market.maintenance_margin_bps = params.maintenance_margin_bps;
    market.initial_margin_bps = initial_margin_bps;
    market.taker_fee_bps = params.taker_fee_bps;
    market.liquidation_penalty_bps = params.liquidation_penalty_bps;
    market.funding_sensitivity_bps = params.funding_sensitivity_bps;

    market.funding_interval_secs = params.funding_interval_secs;
    market.last_funding_ts = now;
    market.cumulative_funding_index = 0;
    market.cumulative_dividend_index = 0;

    market.open_interest_long = 0;
    market.open_interest_short = 0;
    market.max_open_interest = params.max_open_interest;
    market.max_skew_bps = params.max_skew_bps;
    market.max_utilization_bps = params.max_utilization_bps;

    market.long_entry_notional = 0;
    market.short_entry_notional = 0;
    // No pool until `initialize_liquidity_pool` runs. Until then the market
    // has no counterparty, and every instruction that needs one will refuse
    // because `liquidity_pool` does not match any account passed in.
    market.liquidity_pool = Pubkey::default();
    market.total_collateral = 0;
    market.insurance_balance = 0;
    market.bad_debt = 0;
    market._reserved = [0u8; 64];

    emit!(MarketCreated {
        market: market.key(),
        oracle: market.oracle,
        vault: market.vault,
        creator: market.creator,
        max_leverage: market.max_leverage,
        maintenance_margin_bps: market.maintenance_margin_bps,
        funding_interval_secs: market.funding_interval_secs,
    });
    Ok(())
}
