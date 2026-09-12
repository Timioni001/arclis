use anchor_lang::prelude::*;
use crate::errors::PerpError;
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
    pub oracle: Account<'info, PriceOracle>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_price_oracle(
    ctx: Context<InitializePriceOracle>,
    symbol: [u8; 16],
    initial_price: u64,
) -> Result<()> {
    require!(initial_price > 0, PerpError::InvalidOraclePrice);
    let oracle = &mut ctx.accounts.oracle;
    oracle.authority = ctx.accounts.authority.key();
    oracle.symbol = symbol;
    oracle.price = initial_price;
    oracle.confidence = 0;
    oracle.last_update_ts = Clock::get()?.unix_timestamp;
    oracle.bump = ctx.bumps.oracle;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdatePriceOracle<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        seeds = [PriceOracle::SEED, oracle.symbol.as_ref()],
        bump = oracle.bump
    )]
    pub oracle: Account<'info, PriceOracle>,
}

pub fn update_price_oracle(ctx: Context<UpdatePriceOracle>, price: u64, confidence: u64) -> Result<()> {
    require!(price > 0, PerpError::InvalidOraclePrice);
    let oracle = &mut ctx.accounts.oracle;
    oracle.price = price;
    oracle.confidence = confidence;
    oracle.last_update_ts = Clock::get()?.unix_timestamp;
    Ok(())
}
