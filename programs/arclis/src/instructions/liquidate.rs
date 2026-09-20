use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::BAD_DEBT_LIQUIDATION_BOUNTY;
use crate::errors::ArclisError;
use crate::events::PositionLiquidated;
use crate::events::{PoolSettled, SettlementReason};
use crate::instructions::guards::{require_protocol_live, settle_with_pool, sync_and_settle};
use crate::math::session::PriceUse;
use crate::math::{liquidation, liquidity};
use crate::state::{GlobalConfig, LiquidityPool, Market, Position, PriceOracle};

/// Close an undercollateralised position. Permissionless, paid by penalty.
///
/// Note this does **not** call `require_tradable`: a paused market must still be
/// liquidatable. Pausing a market stops new risk from being taken on; it must
/// not trap the vault holding positions it cannot close while the price keeps
/// moving against it. A protocol-wide pause is a genuine emergency stop and does
/// halt this too.
#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub liquidator: Signer<'info>,

    #[account(
        mut,
        constraint = liquidator_token_account.mint == vault.mint @ ArclisError::VaultMismatch,
    )]
    pub liquidator_token_account: Box<Account<'info, TokenAccount>>,

    #[account(seeds = [GlobalConfig::SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [Market::SEED, oracle.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.oracle @ ArclisError::OracleMismatch)]
    pub oracle: Box<Account<'info, PriceOracle>>,

    #[account(
        mut,
        seeds = [Position::SEED, position.owner.as_ref(), market.key().as_ref()],
        bump = position.bump,
        constraint = position.market == market.key() @ ArclisError::VaultMismatch,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(mut, address = market.vault @ ArclisError::VaultMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// The counterparty, and the second loss absorber after insurance.
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
}

pub fn handler(ctx: Context<Liquidate>) -> Result<()> {
    require_protocol_live(&ctx.accounts.config)?;

    let now = Clock::get()?.unix_timestamp;
    // Liquidation reduces protocol risk, so it stays available against a
    // settled close. A halt still blocks it: there is no mark during a halt,
    // and liquidating against the pre-halt print hands the liquidator a
    // position whose real value nobody knows.
    let mark_price = ctx
        .accounts
        .oracle
        .validated_price(now, PriceUse::ReduceRisk)?;
    let funding_index = ctx.accounts.market.cumulative_funding_index;
    let penalty_bps = ctx.accounts.market.liquidation_penalty_bps;
    let maintenance_bps = ctx.accounts.market.maintenance_margin_bps;

    require!(
        !ctx.accounts.position.is_flat(),
        ArclisError::InsufficientPositionSize
    );

    // Normalise and settle first: unpaid funding is part of why a position is
    // underwater, and the health test must see it.
    let oracle_key = ctx.accounts.oracle.key();
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

    let equity = ctx.accounts.position.equity(mark_price, funding_index)?;
    let notional = ctx.accounts.position.notional(mark_price)?;
    require!(
        liquidation::is_liquidatable(equity, notional, maintenance_bps)?,
        ArclisError::PositionHealthy
    );

    let outcome = liquidation::settle(equity, notional, penalty_bps)?;

    let size_closed = ctx.accounts.position.size;
    let owner = ctx.accounts.position.owner;
    let collateral_before = ctx.accounts.position.collateral;
    let entry_price = ctx.accounts.position.entry_price;
    let was_long = ctx.accounts.position.is_long();

    // Pool NAV, priced before anything moves, so the waterfall below knows how
    // much LP capital is actually available to absorb a shortfall.
    let pool_nav = {
        let net_pnl = ctx.accounts.market.net_trader_pnl(mark_price)?;
        ctx.accounts
            .pool
            .nav(ctx.accounts.pool_vault.amount, net_pnl)?
    };

    // --- flatten the position ------------------------------------------------
    {
        let position = &mut ctx.accounts.position;
        position.size = 0;
        position.entry_price = 0;
        position.entry_funding_index = funding_index;
        position.collateral = outcome.trader_remainder;
        position.last_update_ts = now;
    }

    // --- reconcile market accounting ----------------------------------------
    //
    // The liability side moves by exactly the change in this position's
    // collateral: drop what it held, book what it still holds. Expressing it as
    // a delta rather than adding up the individual flows means the market's
    // `total_collateral` cannot drift away from the sum of live positions,
    // whichever branch below runs.
    let mut bad_debt_socialized = 0u64;
    let mut pool_absorbed = 0u64;
    let mut liquidator_reward = outcome.liquidator_reward;
    {
        let market = &mut ctx.accounts.market;
        market.apply_open_interest(size_closed, false)?;
        market.remove_entry_notional(size_closed.unsigned_abs(), entry_price, was_long)?;

        let bookable = collateral_before.min(market.total_collateral);
        market.debit_collateral(bookable)?;
        market.credit_collateral(outcome.trader_remainder)?;

        if outcome.bad_debt > 0 {
            // The position is underwater: the vault is short by `bad_debt` and
            // there is no equity to pay anyone out of. Three buckets, in order:
            // insurance first, then LP capital, then socialised across everyone
            // still open.
            //
            // LPs sitting behind insurance and in front of other traders is
            // exactly what the funding and fees pay them for, and it is what
            // makes the pool a real second loss absorber rather than a yield
            // wrapper on idle capital.
            let split =
                liquidity::absorb_shortfall(outcome.bad_debt, market.insurance_balance, pool_nav);
            market.debit_insurance(split.from_insurance)?;
            pool_absorbed = split.from_pool;
            if split.socialized > 0 {
                market.record_bad_debt(split.socialized)?;
                bad_debt_socialized = split.socialized;
            }

            // Without this, nobody liquidates an underwater position: the
            // penalty is a share of equity that no longer exists, so the
            // rational liquidator walks away and the bad debt grows. A small
            // bounty from whatever insurance remains keeps the permissionless
            // incentive alive exactly when it matters most. Capped at the
            // remaining balance, so it can never itself create a shortfall.
            let bounty = market.insurance_balance.min(BAD_DEBT_LIQUIDATION_BOUNTY);
            if bounty > 0 {
                market.debit_insurance(bounty)?;
                liquidator_reward = bounty;
            }
        } else {
            // Solvent liquidation: the insurance share of the penalty stays in
            // the vault and becomes insurance; the liquidator's share is about
            // to leave the vault and so is booked nowhere.
            market.credit_insurance(outcome.insurance_cut)?;
        }
    }

    // --- settle this position's PnL against the pool -------------------------
    //
    // `close_position` does this; `liquidate` did not, so a liquidated
    // trader's counterparty was never actually paid. The vault holds
    // `collateral_before` for this position. After the waterfall it still owes
    // `trader_remainder` to the trader, `insurance_cut` to the fund and
    // `liquidator_reward` to whoever sent this transaction. Whatever is left
    // over is the trader's realised loss, and it belongs to the pool that
    // stood on the other side of it.
    //
    // A negative remainder means the opposite: the position was liquidated
    // while still in profit, which is what thin margin rather than a bad mark
    // looks like, and the pool owes the vault. That is the case the
    // reconciliation test caught - the vault was short by exactly the
    // liquidated position's unrealised gain.
    //
    // Derived from `outcome` rather than from `equity - collateral_before`,
    // because those differ precisely when the position is underwater: the
    // part of the loss the collateral cannot cover is bad debt, and the
    // waterfall above already assigned it. This figure is the part that is
    // actually funded.
    //
    // A transfer only, never `settle_realized_pnl`: `total_collateral` already
    // moved by this position's collateral delta above, and that delta includes
    // the PnL. Booking it again would count it twice.
    let funded_realized = i128::from(outcome.trader_remainder)
        .checked_add(i128::from(outcome.liquidator_reward))
        .and_then(|v| v.checked_add(i128::from(outcome.insurance_cut)))
        .and_then(|v| v.checked_sub(i128::from(collateral_before)))
        .ok_or(ArclisError::MathOverflow)?;

    if funded_realized != 0 {
        let oracle_key = ctx.accounts.oracle.key();
        settle_with_pool(
            funded_realized,
            &ctx.accounts.market,
            &ctx.accounts.vault,
            &mut ctx.accounts.pool,
            &ctx.accounts.pool_vault,
            &ctx.accounts.token_program,
            &oracle_key,
        )?;

        // Both vaults just moved. Every guard below reads a cached balance,
        // and a stale read is how a solvency check passes against money that
        // is no longer there.
        ctx.accounts.vault.reload()?;
        ctx.accounts.pool_vault.reload()?;

        emit!(PoolSettled {
            pool: ctx.accounts.pool.key(),
            market: ctx.accounts.market.key(),
            amount: funded_realized,
            reason: SettlementReason::Liquidation,
            pool_realized_pnl_after: ctx.accounts.pool.realized_pnl,
        });
    }

    // The pool's share of the shortfall is a real transfer out of LP capital
    // into the market vault, which is short by exactly that much.
    if pool_absorbed > 0 {
        ctx.accounts.pool.absorbed_bad_debt = ctx
            .accounts
            .pool
            .absorbed_bad_debt
            .checked_add(pool_absorbed)
            .ok_or(ArclisError::MathOverflow)?;

        let oracle_key = ctx.accounts.oracle.key();
        settle_with_pool(
            i128::from(pool_absorbed),
            &ctx.accounts.market,
            &ctx.accounts.vault,
            &mut ctx.accounts.pool,
            &ctx.accounts.pool_vault,
            &ctx.accounts.token_program,
            &oracle_key,
        )?;

        emit!(PoolSettled {
            pool: ctx.accounts.pool.key(),
            market: ctx.accounts.market.key(),
            amount: i128::from(pool_absorbed),
            reason: SettlementReason::BadDebt,
            pool_realized_pnl_after: ctx.accounts.pool.realized_pnl,
        });
    }

    // --- pay the liquidator --------------------------------------------------
    if liquidator_reward > 0 {
        ctx.accounts.vault.reload()?;
        ctx.accounts
            .market
            .require_payable(ctx.accounts.vault.amount, liquidator_reward)?;

        let oracle_key = ctx.accounts.oracle.key();
        let bump = [ctx.accounts.market.bump];
        let seeds = Market::signer_seeds(&oracle_key, &bump);

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.liquidator_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[&seeds],
            ),
            liquidator_reward,
        )?;
    }

    emit!(PositionLiquidated {
        market: ctx.accounts.market.key(),
        owner,
        liquidator: ctx.accounts.liquidator.key(),
        size_closed,
        mark_price,
        equity,
        liquidator_reward,
        insurance_cut: outcome.insurance_cut,
        trader_remainder: outcome.trader_remainder,
        bad_debt_socialized,
        bad_debt_absorbed_by_pool: pool_absorbed,
    });
    Ok(())
}
