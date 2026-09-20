//! Capitalising the insurance fund from outside the fee stream.
//!
//! Fees and liquidation penalties are the fund's ongoing income, but a market
//! on day one has neither: the first liquidation that goes bad has nothing in
//! front of the LPs at all. That is the wrong shape for a venue whose whole
//! pitch is that LPs sit behind a backstop.
//!
//! So insurance is seedable. It is deliberately permissionless: anyone may pay
//! in, nobody may take out. There is no withdraw counterpart to this
//! instruction and there should not be - an insurance fund a privileged key can
//! drain is not an insurance fund, and the protocol authority being able to
//! empty the backstop it also controls the pause switch for is exactly the
//! trust assumption this design is trying to avoid.
//!
//! The one thing a deposit *can* do is retire bad debt. Socialised bad debt is
//! a haircut already taken by traders and LPs; paying it down with fresh
//! capital is the only way it ever goes away.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ArclisError;
use crate::events::InsuranceDeposited;
use crate::instructions::guards::require_protocol_live;
use crate::state::{GlobalConfig, Market};

#[derive(Accounts)]
pub struct DepositInsurance<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(mut, seeds = [Market::SEED, market.oracle.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        constraint = depositor_token_account.owner == depositor.key() @ ArclisError::Unauthorized,
        constraint = depositor_token_account.mint == vault.mint @ ArclisError::VaultMismatch,
    )]
    pub depositor_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.vault @ ArclisError::VaultMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Pay `amount` of quote into the market's insurance fund.
///
/// A paused market still accepts this. Pausing exists to stop risk being
/// added, and adding a loss absorber is the opposite of adding risk; refusing
/// it would mean the one moment the fund is most needed is the one moment it
/// cannot be topped up. The protocol-wide kill switch is still honoured,
/// because that one stops token movement entirely.
pub fn handler(ctx: Context<DepositInsurance>, amount: u64) -> Result<()> {
    require_protocol_live(&ctx.accounts.config)?;
    require!(amount > 0, ArclisError::InsufficientCollateral);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    let market = &mut ctx.accounts.market;

    // Retire socialised bad debt first. Bad debt is a claim traders and LPs
    // already ate; leaving it on the books while insurance grows beside it
    // would report a healthier fund than the market actually has, because the
    // first thing that fund owes is the hole.
    let retired = amount.min(market.bad_debt);
    if retired > 0 {
        market.bad_debt -= retired;
    }
    let to_insurance = amount - retired;
    if to_insurance > 0 {
        market.credit_insurance(to_insurance)?;
    }

    emit!(InsuranceDeposited {
        market: market.key(),
        depositor: ctx.accounts.depositor.key(),
        amount,
        insurance_balance_after: market.insurance_balance,
        bad_debt_after: market.bad_debt,
    });
    Ok(())
}
