use anchor_lang::prelude::*;

pub mod errors;
pub mod state;
pub mod instructions;

use instructions::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// General-purpose oracle-priced perpetuals engine.
///
/// - Cash-settled against an oracle price, not an order book or AMM.
/// - `create_market` is permissionless: any keeper-fed oracle can back a
///   market, which is what makes this a general engine rather than a
///   hardcoded stock list. Production note: this uses a keeper-fed
///   PriceOracle account rather than a live Pyth feed, because Pyth's
///   Solana SDK currently pulls in dependencies that need a newer Rust
///   edition than Solana's own build toolchain supports as of this
///   writing (see README) - swapping it in later only touches
///   `read_oracle_price` in state.rs and the oracle account type used
///   across instructions.
/// - Custody is program-owned, not team-owned - there is no admin
///   withdrawal instruction anywhere in this program.
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
