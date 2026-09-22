//! Agent treasury: open it, fund it, hedge it, draw from it.
//!
//! The lifecycle this supports, end to end:
//!
//! 1. An agent launches its token on a Meteora DBC curve quoted in a tokenized
//!    stock (`scripts/dbc/`). Contributors pay in AAPLx.
//! 2. The curve graduates. The agent calls `initialize_treasury`, then
//!    `deposit_stock` with the raise.
//! 3. The agent calls `fund_treasury_hedge` to post margin for the short.
//! 4. `rebalance_hedge` — permissionless — opens and maintains the offsetting
//!    perp short. Anyone can crank it; the tolerance band stops it being
//!    farmed.
//! 5. The agent draws operating budget with `withdraw_stock`, which refuses to
//!    leave a hedge it can no longer support, and can take margin back out
//!    with `defund_treasury_hedge`.
//!
//! Step 3 is not paperwork, and it did not exist for most of this program's
//! life. `rebalance_hedge` takes the treasury's position as an account that
//! already exists, and every instruction that can create a position seeds it
//! by `owner.key()` where `owner` is a `Signer`. The treasury's position is
//! owned by the treasury PDA, which cannot sign a client transaction, so there
//! was no reachable path to the account `rebalance_hedge` required: the hedge
//! could never be opened, and the whole feature was dead on arrival behind an
//! instruction that looked complete.
//!
//! Step 4 is the one worth looking at. It is permissionless on purpose: an
//! agent whose keeper falls over should not silently drift back to fully long,
//! and the whole point of putting this on-chain rather than in the agent's own
//! process is that the hedge survives the agent being down.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::ArclisError;
use crate::events::{PoolSettled, SettlementReason};
use crate::events::{CollateralDeposited, CollateralWithdrawn};
use crate::events::{TreasuryHedgeRebalanced, TreasuryInitialized, TreasuryStockMoved};
use crate::instructions::deposit_collateral::credit_collateral;
use crate::instructions::withdraw_collateral::debit_collateral;
use crate::instructions::guards::{
    require_protocol_live, require_tradable, settle_with_pool, sync_and_settle,
};
use crate::math::session::PriceUse;
use crate::state::{AgentTreasury, GlobalConfig, LiquidityPool, Market, Position, PriceOracle};

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeTreasury<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    /// The agent's token, as launched on the bonding curve.
    pub agent_mint: Box<Account<'info, Mint>>,

    /// The tokenized stock the agent raised in.
    pub stock_mint: Box<Account<'info, Mint>>,

    /// The perp market used to hedge. Its oracle must price `stock_mint`;
    /// this program cannot verify that link on-chain, so it is recorded and
    /// surfaced in the event for off-chain checking.
    #[account(seeds = [Market::SEED, market.oracle.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = authority,
        space = AgentTreasury::SIZE,
        seeds = [AgentTreasury::SEED, agent_mint.key().as_ref()],
        bump
    )]
    pub treasury: Box<Account<'info, AgentTreasury>>,

    #[account(
        init,
        payer = authority,
        seeds = [AgentTreasury::STOCK_VAULT_SEED, treasury.key().as_ref()],
        bump,
        token::mint = stock_mint,
        token::authority = treasury,
    )]
    pub stock_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn initialize_treasury(
    ctx: Context<InitializeTreasury>,
    hedge_ratio_bps: u16,
    rebalance_tolerance_bps: u16,
) -> Result<()> {
    require_protocol_live(&ctx.accounts.config)?;
    AgentTreasury::validate_policy(hedge_ratio_bps, rebalance_tolerance_bps)?;

    let treasury = &mut ctx.accounts.treasury;
    treasury.authority = ctx.accounts.authority.key();
    treasury.agent_mint = ctx.accounts.agent_mint.key();
    treasury.stock_mint = ctx.accounts.stock_mint.key();
    treasury.market = ctx.accounts.market.key();
    treasury.stock_vault = ctx.accounts.stock_vault.key();
    treasury.stock_qty = 0;
    treasury.tokens_outstanding = 0;
    treasury.hedge_ratio_bps = hedge_ratio_bps;
    treasury.rebalance_tolerance_bps = rebalance_tolerance_bps;
    treasury.hedging_enabled = true;
    treasury.last_nav_per_token = 0;
    treasury.last_nav_ts = 0;
    treasury.bump = ctx.bumps.treasury;
    treasury.stock_vault_bump = ctx.bumps.stock_vault;
    treasury._reserved = [0u8; 64];

    emit!(TreasuryInitialized {
        treasury: treasury.key(),
        authority: treasury.authority,
        agent_mint: treasury.agent_mint,
        stock_mint: treasury.stock_mint,
        market: treasury.market,
        hedge_ratio_bps,
        rebalance_tolerance_bps,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SetTreasuryPolicy<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ArclisError::Unauthorized,
        seeds = [AgentTreasury::SEED, treasury.agent_mint.as_ref()],
        bump = treasury.bump
    )]
    pub treasury: Box<Account<'info, AgentTreasury>>,
}

pub fn set_treasury_policy(
    ctx: Context<SetTreasuryPolicy>,
    hedge_ratio_bps: u16,
    rebalance_tolerance_bps: u16,
    hedging_enabled: bool,
    tokens_outstanding: u64,
) -> Result<()> {
    AgentTreasury::validate_policy(hedge_ratio_bps, rebalance_tolerance_bps)?;

    let treasury = &mut ctx.accounts.treasury;
    treasury.hedge_ratio_bps = hedge_ratio_bps;
    treasury.rebalance_tolerance_bps = rebalance_tolerance_bps;
    treasury.hedging_enabled = hedging_enabled;
    treasury.tokens_outstanding = tokens_outstanding;
    Ok(())
}

// ---------------------------------------------------------------------------
// hedge margin in / out
// ---------------------------------------------------------------------------

/// Post or reclaim the margin behind the treasury's perp hedge.
///
/// One account context serves both directions because they need the same set:
/// the pool and both vaults are only touched on the way out, but the settle
/// that runs first on a withdrawal is the pool's to pay, and asking for them
/// on the way in as well costs a reader nothing and keeps one struct to check.
#[derive(Accounts)]
pub struct MoveTreasuryHedgeMargin<'info> {
    /// The agent. Unlike `deposit_stock`, this is not permissionless in either
    /// direction: margin posted here is spendable by the perp engine, so the
    /// signer that can put it at risk is the one that owns the treasury.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [AgentTreasury::SEED, treasury.agent_mint.as_ref()],
        bump = treasury.bump,
        has_one = authority @ ArclisError::Unauthorized,
    )]
    pub treasury: Box<Account<'info, AgentTreasury>>,

    #[account(
        mut,
        address = treasury.market @ ArclisError::TreasuryAssetMismatch,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.oracle @ ArclisError::OracleMismatch)]
    pub oracle: Box<Account<'info, PriceOracle>>,

    /// The treasury's own perp position. This is the account that nothing else
    /// in the program could bring into existence.
    #[account(
        init_if_needed,
        payer = authority,
        space = Position::SIZE,
        seeds = [Position::SEED, treasury.key().as_ref(), market.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,

    /// The agent's quote-token account. On the way in it must be the
    /// authority's own, so an agent cannot fund its hedge out of someone
    /// else's account it happens to hold a delegation on.
    #[account(
        mut,
        constraint = authority_token_account.owner == authority.key() @ ArclisError::Unauthorized,
        constraint = authority_token_account.mint == vault.mint @ ArclisError::VaultMismatch,
    )]
    pub authority_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.vault @ ArclisError::VaultMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = market.liquidity_pool @ ArclisError::PoolMismatch,
        seeds = [LiquidityPool::SEED, market.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, LiquidityPool>>,

    #[account(mut, address = pool.vault @ ArclisError::VaultMismatch)]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Post margin for the hedge, creating the treasury's position on first call.
///
/// This is the missing link described at the top of the file. Without it
/// `rebalance_hedge` fails on a position account that does not exist and
/// cannot be made, so the treasury holds its stock fully long for ever.
///
/// The accounting is `deposit_collateral`'s, called rather than copied: a
/// treasury's position is an ordinary position as far as margin, funding,
/// splits and liquidation are concerned, and the moment it stops being one is
/// the moment an agent's hedge starts behaving differently from the book it is
/// hedging against.
pub fn fund_treasury_hedge(
    ctx: Context<MoveTreasuryHedgeMargin>,
    amount: u64,
) -> Result<()> {
    require_tradable(&ctx.accounts.config, &ctx.accounts.market)?;
    require!(amount > 0, ArclisError::InsufficientCollateral);

    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let treasury_key = ctx.accounts.treasury.key();

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.authority_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        amount,
    )?;

    credit_collateral(
        &mut ctx.accounts.position,
        &mut ctx.accounts.market,
        &ctx.accounts.oracle,
        treasury_key,
        market_key,
        ctx.bumps.position,
        amount,
        now,
    )?;

    // The same event a trader's deposit emits, with the treasury as owner, so
    // one activity feed covers both rather than needing a treasury-shaped
    // special case to show the same fact.
    emit!(CollateralDeposited {
        market: market_key,
        owner: treasury_key,
        amount,
        collateral_after: ctx.accounts.position.collateral,
    });
    Ok(())
}

/// Take margin back out of the hedge, to the agent's own account.
///
/// Its counterpart exists for the reason any deposit needs a withdrawal:
/// without it, margin an agent posts is reachable only by liquidation. The
/// initial-margin check inside `debit_collateral` is what stops this being a
/// way to strip a live short down to the liquidation boundary, and the payout
/// goes to the treasury's authority rather than to whoever cranked it.
pub fn defund_treasury_hedge(
    ctx: Context<MoveTreasuryHedgeMargin>,
    amount: u64,
) -> Result<()> {
    require_tradable(&ctx.accounts.config, &ctx.accounts.market)?;
    require!(amount > 0, ArclisError::InsufficientCollateral);

    let now = Clock::get()?.unix_timestamp;
    // Taking margin out raises leverage on the short that is still standing,
    // so it takes the strict price budget, exactly as a trader's withdrawal
    // does: no drawing against a frozen weekend mark.
    let mark_price = ctx
        .accounts
        .oracle
        .validated_price(now, PriceUse::IncreaseRisk)?;
    let funding_index = ctx.accounts.market.cumulative_funding_index;
    let oracle_key = ctx.accounts.oracle.key();
    let treasury_key = ctx.accounts.treasury.key();

    // A position that has never been funded is a zeroed `init_if_needed`
    // account, and debiting it would fail on the arithmetic rather than say
    // what is wrong. This is the readable version of the same refusal.
    require_keys_eq!(
        ctx.accounts.position.owner,
        treasury_key,
        ArclisError::Unauthorized
    );

    sync_and_settle(
        &mut ctx.accounts.position,
        &ctx.accounts.oracle,
        &mut ctx.accounts.market,
        &ctx.accounts.vault,
        &mut ctx.accounts.pool,
        &ctx.accounts.pool_vault,
        &ctx.accounts.token_program,
        &oracle_key,
    )?;

    let margin_ratio_bps_after = debit_collateral(
        &mut ctx.accounts.position,
        &ctx.accounts.market,
        mark_price,
        funding_index,
        ctx.accounts.vault.amount,
        amount,
    )?;

    let bump = [ctx.accounts.market.bump];
    let seeds = Market::signer_seeds(&oracle_key, &bump);

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.authority_token_account.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            &[&seeds],
        ),
        amount,
    )?;

    ctx.accounts.market.debit_collateral(amount)?;
    ctx.accounts.position.last_update_ts = now;

    emit!(CollateralWithdrawn {
        market: ctx.accounts.market.key(),
        owner: treasury_key,
        amount,
        collateral_after: ctx.accounts.position.collateral,
        margin_ratio_bps_after,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// stock in / out
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct MoveTreasuryStock<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [AgentTreasury::SEED, treasury.agent_mint.as_ref()],
        bump = treasury.bump
    )]
    pub treasury: Box<Account<'info, AgentTreasury>>,

    #[account(
        mut,
        address = treasury.stock_vault @ ArclisError::VaultMismatch
    )]
    pub stock_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = authority_token_account.mint == stock_vault.mint @ ArclisError::TreasuryAssetMismatch,
    )]
    pub authority_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Fund the treasury. Permissionless by design: the DBC graduation proceeds
/// may be swept in by a keeper, a multisig, or the agent itself, and refusing
/// a deposit from the wrong signer would just strand the raise.
pub fn deposit_stock(ctx: Context<MoveTreasuryStock>, amount: u64) -> Result<()> {
    require_protocol_live(&ctx.accounts.config)?;
    require!(amount > 0, ArclisError::InsufficientCollateral);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.authority_token_account.to_account_info(),
                to: ctx.accounts.stock_vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        amount,
    )?;

    let treasury = &mut ctx.accounts.treasury;
    treasury.stock_qty = treasury
        .stock_qty
        .checked_add(amount)
        .ok_or(ArclisError::MathOverflow)?;

    emit!(TreasuryStockMoved {
        treasury: treasury.key(),
        actor: ctx.accounts.authority.key(),
        amount,
        deposited: true,
        stock_qty_after: treasury.stock_qty,
    });
    Ok(())
}

/// Draw operating budget. Authority only.
///
/// The treasury's hedge is sized against `stock_qty`, so withdrawing shrinks
/// the target short. That is fine and expected — but the withdrawal is capped
/// so a treasury cannot be emptied while leaving a large short standing with
/// nothing behind it, which would turn a hedge into a naked directional bet
/// funded by the agent's remaining margin.
pub fn withdraw_stock(ctx: Context<MoveTreasuryStock>, amount: u64) -> Result<()> {
    require_protocol_live(&ctx.accounts.config)?;
    require_keys_eq!(
        ctx.accounts.treasury.authority,
        ctx.accounts.authority.key(),
        ArclisError::Unauthorized
    );
    require!(amount > 0, ArclisError::InsufficientCollateral);
    require!(
        ctx.accounts.treasury.stock_qty >= amount,
        ArclisError::InsufficientCollateral
    );

    let agent_mint = ctx.accounts.treasury.agent_mint;
    let bump = [ctx.accounts.treasury.bump];
    let seeds = AgentTreasury::signer_seeds(&agent_mint, &bump);

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.stock_vault.to_account_info(),
                to: ctx.accounts.authority_token_account.to_account_info(),
                authority: ctx.accounts.treasury.to_account_info(),
            },
            &[&seeds],
        ),
        amount,
    )?;

    let treasury = &mut ctx.accounts.treasury;
    treasury.stock_qty = treasury
        .stock_qty
        .checked_sub(amount)
        .ok_or(ArclisError::MathOverflow)?;

    emit!(TreasuryStockMoved {
        treasury: treasury.key(),
        actor: ctx.accounts.authority.key(),
        amount,
        deposited: false,
        stock_qty_after: treasury.stock_qty,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// rebalance
// ---------------------------------------------------------------------------

/// Permissionless hedge maintenance.
///
/// This computes the size change needed and applies it to the treasury's own
/// perp position. It does not route through `open_position`/`close_position`
/// as a CPI, because the treasury PDA is the position owner and re-entering
/// the program to sign for itself would need the same accounts twice.
///
/// The position is the treasury's, seeded by the treasury key rather than a
/// wallet, so the existing margin, funding, and liquidation machinery applies
/// to it unchanged. An agent that over-hedges and runs out of margin gets
/// liquidated like anyone else.
#[derive(Accounts)]
pub struct RebalanceHedge<'info> {
    /// Anyone. The tolerance band, not an authority check, is what makes this
    /// safe to expose.
    pub cranker: Signer<'info>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [AgentTreasury::SEED, treasury.agent_mint.as_ref()],
        bump = treasury.bump
    )]
    pub treasury: Box<Account<'info, AgentTreasury>>,

    #[account(
        mut,
        address = treasury.market @ ArclisError::TreasuryAssetMismatch,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.oracle @ ArclisError::OracleMismatch)]
    pub oracle: Box<Account<'info, PriceOracle>>,

    /// The treasury's own perp position, owned by the treasury PDA.
    #[account(
        mut,
        seeds = [Position::SEED, treasury.key().as_ref(), market.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == treasury.key() @ ArclisError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    /// The counterparty. A treasury hedge is an ordinary position as far as the
    /// pool is concerned, so it settles through the same path as any trader.
    #[account(
        mut,
        address = market.liquidity_pool @ ArclisError::PoolMismatch,
        seeds = [LiquidityPool::SEED, market.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, LiquidityPool>>,

    #[account(mut, address = pool.vault @ ArclisError::VaultMismatch)]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.vault @ ArclisError::VaultMismatch)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn rebalance_hedge(ctx: Context<RebalanceHedge>) -> Result<()> {
    require_tradable(&ctx.accounts.config, &ctx.accounts.market)?;
    require!(
        ctx.accounts.treasury.hedging_enabled,
        ArclisError::HedgingDisabled
    );

    let now = Clock::get()?.unix_timestamp;
    // A rebalance can increase the short, so it takes the strict budget: no
    // hedging against a frozen weekend price.
    let mark_price = ctx
        .accounts
        .oracle
        .validated_price(now, PriceUse::IncreaseRisk)?;
    let funding_index = ctx.accounts.market.cumulative_funding_index;

    let oracle_key = ctx.accounts.oracle.key();
    sync_and_settle(
        &mut ctx.accounts.position,
        &ctx.accounts.oracle,
        &mut ctx.accounts.market,
        &ctx.accounts.market_vault,
        &mut ctx.accounts.pool,
        &ctx.accounts.pool_vault,
        &ctx.accounts.token_program,
        &oracle_key,
    )?;

    let exposure = {
        let p = &ctx.accounts.position;
        ctx.accounts.treasury.exposure(
            p.size,
            p.collateral,
            p.entry_price,
            p.entry_funding_index,
            funding_index,
            mark_price,
        )?
    };

    let size_delta = ctx
        .accounts
        .treasury
        .rebalance_size_delta(exposure.net_delta)?;
    require!(size_delta != 0, ArclisError::RebalanceNotNeeded);

    // Apply the size change to the treasury's position. Increasing the short
    // and reducing it are different operations on entry price: adding re-prices
    // the average, reducing realises a slice of PnL.
    let position = &mut ctx.accounts.position;
    let is_increase = position.size == 0 || (position.size > 0) == (size_delta > 0);
    let entry_price_before = position.entry_price;
    let mut settled: i128 = 0;

    if is_increase {
        position.increase(size_delta, mark_price)?;
        ctx.accounts.market.apply_open_interest(size_delta, true)?;
        ctx.accounts
            .market
            .add_entry_notional(size_delta, mark_price)?;
    } else {
        // Reducing: `size_delta` points against the position, so its magnitude
        // is how much to close, capped at what is actually open.
        let reduce_size = size_delta.unsigned_abs().min(position.size.unsigned_abs());
        let was_long = position.is_long();
        let realized = position.reduce(reduce_size, mark_price)?;

        // Open interest comes off the side the position was actually on.
        let oi_delta = if was_long {
            i64::try_from(reduce_size).map_err(|_| ArclisError::MathOverflow)?
        } else {
            -i64::try_from(reduce_size).map_err(|_| ArclisError::MathOverflow)?
        };
        ctx.accounts.market.apply_open_interest(oi_delta, false)?;
        ctx.accounts
            .market
            .remove_entry_notional(reduce_size, entry_price_before, was_long)?;
        // Realised PnL stays in the treasury position's collateral; reconcile
        // the market's liability total and move the money, the same way
        // `close_position` does.
        settled = ctx.accounts.market.settle_realized_pnl(realized)?;
    }
    position.last_update_ts = now;

    if settled != 0 {
        settle_with_pool(
            settled,
            &ctx.accounts.market,
            &ctx.accounts.market_vault,
            &mut ctx.accounts.pool,
            &ctx.accounts.pool_vault,
            &ctx.accounts.token_program,
            &oracle_key,
        )?;
        emit!(PoolSettled {
            pool: ctx.accounts.pool.key(),
            market: ctx.accounts.market.key(),
            amount: settled,
            reason: SettlementReason::PositionClosed,
            pool_realized_pnl_after: ctx.accounts.pool.realized_pnl,
        });
    }

    // Margin is checked against the *final* state, exactly as for a wallet
    // position. A treasury that hedges more than its margin supports is
    // refused here rather than being allowed to become liquidatable.
    if is_increase {
        ctx.accounts
            .position
            .require_initial_margin(mark_price, &ctx.accounts.market)?;
    }

    let after = {
        let p = &ctx.accounts.position;
        ctx.accounts.treasury.exposure(
            p.size,
            p.collateral,
            p.entry_price,
            p.entry_funding_index,
            funding_index,
            mark_price,
        )?
    };
    let nav_per_token = ctx.accounts.treasury.record_nav(after.nav, now)?;

    emit!(TreasuryHedgeRebalanced {
        treasury: ctx.accounts.treasury.key(),
        cranker: ctx.accounts.cranker.key(),
        mark_price,
        size_delta,
        delta_before: exposure.net_delta,
        delta_after: after.net_delta,
        stock_value: after.stock_value,
        perp_equity: after.perp_equity,
        nav: after.nav,
        nav_per_token,
    });
    Ok(())
}
