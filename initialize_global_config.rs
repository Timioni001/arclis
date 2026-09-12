use anchor_lang::prelude::*;
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

    /// The token account (or PDA) that receives liquidation shortfall backstops.
    /// CHECK: only stored as a pubkey reference, never read or written here.
    pub insurance_fund: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeGlobalConfig>, fee_bps: u16) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.insurance_fund = ctx.accounts.insurance_fund.key();
    config.fee_bps = fee_bps;
    config.paused = false;
    config.bump = ctx.bumps.config;
    Ok(())
}
