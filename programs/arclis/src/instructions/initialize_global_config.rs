use anchor_lang::prelude::*;

use crate::constants::MAX_FEE_BPS;
use crate::errors::ArclisError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct InitializeGlobalConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = GlobalConfig::SIZE,
        seeds = [GlobalConfig::SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,

    /// Label for off-chain insurance accounting. Insurance value itself lives
    /// inside each market vault and is tracked by `Market::insurance_balance`,
    /// so nothing is ever transferred to this address by this program.
    /// CHECK: stored as a pubkey only; never read, written, or transferred to.
    pub insurance_fund: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeGlobalConfig>, default_fee_bps: u16) -> Result<()> {
    require!(default_fee_bps <= MAX_FEE_BPS, ArclisError::InvalidFeeParam);

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.insurance_fund = ctx.accounts.insurance_fund.key();
    config.default_fee_bps = default_fee_bps;
    config.paused = false;
    config.bump = ctx.bumps.config;
    config._reserved = [0u8; 64];
    Ok(())
}
