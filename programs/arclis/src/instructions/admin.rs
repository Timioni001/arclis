//! Authority actions.
//!
//! Both instructions here flip a boolean. Neither moves value, and there is
//! deliberately no instruction anywhere in this program that lets the authority
//! transfer out of a market vault - that absence is the security claim, so it is
//! worth noticing that this file is the complete list of what an admin can do.

use anchor_lang::prelude::*;

use crate::events::{MarketPauseToggled, ProtocolPauseToggled};
use crate::instructions::guards::require_authority;
use crate::state::{GlobalConfig, Market};

#[derive(Accounts)]
pub struct SetProtocolPaused<'info> {
    pub authority: Signer<'info>,

    #[account(mut, seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,
}

pub fn set_protocol_paused(ctx: Context<SetProtocolPaused>, paused: bool) -> Result<()> {
    require_authority(&ctx.accounts.config, &ctx.accounts.authority.key())?;
    ctx.accounts.config.paused = paused;

    emit!(ProtocolPauseToggled {
        authority: ctx.accounts.authority.key(),
        paused,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetMarketPaused<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(mut, seeds = [Market::SEED, market.oracle.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
}

pub fn set_market_paused(ctx: Context<SetMarketPaused>, paused: bool) -> Result<()> {
    require_authority(&ctx.accounts.config, &ctx.accounts.authority.key())?;
    ctx.accounts.market.paused = paused;

    emit!(MarketPauseToggled {
        market: ctx.accounts.market.key(),
        authority: ctx.accounts.authority.key(),
        paused,
    });
    Ok(())
}
