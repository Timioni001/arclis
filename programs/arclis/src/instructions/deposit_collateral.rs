use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ArclisError;
use crate::events::CollateralDeposited;
use crate::instructions::guards::require_tradable;
use crate::state::{GlobalConfig, Market, Position, PriceOracle};

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(mut, seeds = [Market::SEED, oracle.key().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,

    /// Needed only for its split factor, so a freshly created position starts
    /// at the market's current corporate-action state rather than at 1.0 and
    /// then rescales itself on first use.
    #[account(address = market.oracle @ ArclisError::OracleMismatch)]
    pub oracle: Account<'info, PriceOracle>,

    #[account(
        init_if_needed,
        payer = owner,
        space = Position::SIZE,
        seeds = [Position::SEED, owner.key().as_ref(), market.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key() @ ArclisError::Unauthorized,
        constraint = owner_token_account.mint == vault.mint @ ArclisError::VaultMismatch,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    #[account(mut, address = market.vault @ ArclisError::VaultMismatch)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
    require_tradable(&ctx.accounts.config, &ctx.accounts.market)?;
    require!(amount > 0, ArclisError::InsufficientCollateral);

    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let owner_key = ctx.accounts.owner.key();

    // `init_if_needed` gives a zeroed account on first use. Initialise it
    // before touching any field, and snapshot the market's current funding
    // index so a brand-new position is not charged for funding that accrued
    // before it existed.
    {
        let position = &mut ctx.accounts.position;
        if position.owner == Pubkey::default() {
            position.owner = owner_key;
            position.market = market_key;
            position.size = 0;
            position.entry_price = 0;
            position.collateral = 0;
            position.entry_funding_index = ctx.accounts.market.cumulative_funding_index;
            position.entry_split_factor = ctx.accounts.oracle.split_factor;
            position.bump = ctx.bumps.position;
            position._reserved = [0u8; 24];
        } else {
            // Re-using an existing account: it must be this owner's, in this
            // market. The PDA seeds already guarantee it, but an explicit check
            // costs nothing and survives a future seed change.
            require_keys_eq!(position.owner, owner_key, ArclisError::Unauthorized);
            require_keys_eq!(position.market, market_key, ArclisError::VaultMismatch);
            // Depositing does not need a price, but it must not leave a
            // position holding a stale split factor for the next instruction.
            position.normalize_for_splits(ctx.accounts.oracle.split_factor)?;
        }
    }

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    let position = &mut ctx.accounts.position;
    position.collateral = position
        .collateral
        .checked_add(amount)
        .ok_or(ArclisError::MathOverflow)?;
    position.last_update_ts = now;

    // The market's liability total moves in lockstep with trader collateral.
    ctx.accounts.market.credit_collateral(amount)?;

    emit!(CollateralDeposited {
        market: market_key,
        owner: owner_key,
        amount,
        collateral_after: position.collateral,
    });
    Ok(())
}
