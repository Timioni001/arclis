use anchor_lang::prelude::*;

pub mod errors;
pub mod state;
pub mod instructions;

use instructions::*;

declare_id!("8KwHVevdqvNrwTCgsTvwQzvWXNsdonHKCi9mrH6gN23x");

/// General-purpose oracle-priced perpetuals engine.
///
/// Design choices worth knowing before you read further:
/// - Cash-settled against an oracle price, not an order book or AMM - so
///   there is no separate "mark price" to keep in sync, and no slippage
///   model to get wrong under hackathon time pressure.
/// - `create_market` is permissionless: any oracle-backed asset can be
///   listed by anyone, which is what makes this a general engine rather
///   than a hardcoded stock list.
/// - Custody is program-owned (users deposit into a market vault the
///   program controls), not team-controlled - there is no admin
///   withdrawal instruction anywhere in this program. The only ways
///   funds move are: user-initiated withdraw (margin-checked),
///   close_position settlement, and liquidation (margin-triggered,
///   permissionless, reward-capped).
#[program]
pub mod perp_engine {
    use super::*;

    pub fn initialize_global_config(
        ctx: Context<InitializeGlobalConfig>,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::initialize_global_config::handler(ctx, fee_bps)
    }

    pub fn initialize_price_oracle(
        ctx: Context<InitializePriceOracle>,
        symbol: [u8; 16],
        initial_price: u64,
    ) -> Result<()> {
        instructions::price_oracle::initialize_price_oracle(ctx, symbol, initial_price)
    }

    pub fn update_price_oracle(
        ctx: Context<UpdatePriceOracle>,
        price: u64,
        confidence: u64,
    ) -> Result<()> {
        instructions::price_oracle::update_price_oracle(ctx, price, confidence)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        max_leverage: u8,
        min_margin_ratio_bps: u16,
        funding_interval_secs: i64,
    ) -> Result<()> {
        instructions::create_market::handler(ctx, max_leverage, min_margin_ratio_bps, funding_interval_secs)
    }

    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        instructions::deposit_collateral::handler(ctx, amount)
    }

    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        instructions::withdraw_collateral::handler(ctx, amount)
    }

    pub fn open_position(ctx: Context<OpenPosition>, size_delta: i64) -> Result<()> {
        instructions::open_position::handler(ctx, size_delta)
    }

    pub fn close_position(ctx: Context<ClosePosition>, reduce_size: u64) -> Result<()> {
        instructions::close_position::handler(ctx, reduce_size)
    }

    pub fn crank_funding(ctx: Context<CrankFunding>) -> Result<()> {
        instructions::crank_funding::handler(ctx)
    }

    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        instructions::liquidate::handler(ctx)
    }
}
