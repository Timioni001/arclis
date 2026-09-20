//! Cross-cutting preconditions.
//!
//! These were previously inline `constraint =` attributes duplicated across
//! instruction structs, with the result that `GlobalConfig::paused` was declared
//! but never actually checked anywhere - the protocol kill switch did nothing.
//! Routing every trading instruction through one function means a new
//! instruction cannot forget a check by omission.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ArclisError;
use crate::math::fixed;
use crate::state::{GlobalConfig, LiquidityPool, Market, Position, PriceOracle};

/// Both kill switches, protocol first.
///
/// Called by every instruction that opens, closes, or moves collateral.
/// Deliberately *not* called by [`crate::instructions::liquidate`]: a paused
/// market must still be liquidatable, or pausing would trap the vault with
/// underwater positions it cannot close while the price keeps moving.
pub fn require_tradable(config: &GlobalConfig, market: &Market) -> Result<()> {
    require!(!config.paused, ArclisError::ProtocolPaused);
    require!(!market.paused, ArclisError::MarketPaused);
    Ok(())
}

/// Protocol-level pause only. Liquidation uses this: a globally paused protocol
/// is an emergency stop and should halt everything, but a single paused market
/// should not block the risk engine.
pub fn require_protocol_live(config: &GlobalConfig) -> Result<()> {
    require!(!config.paused, ArclisError::ProtocolPaused);
    Ok(())
}

pub fn require_authority(config: &GlobalConfig, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(config.authority, *signer, ArclisError::Unauthorized);
    Ok(())
}

pub fn require_oracle_authority(oracle: &PriceOracle, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(oracle.authority, *signer, ArclisError::NotOracleAuthority);
    Ok(())
}

/// Bring a position fully up to date, in the one order that is correct.
///
/// Splits first, then dividends and funding. The order matters and is not
/// interchangeable: both settlements multiply size by an index delta, and all
/// three quantities are denominated in pre-split base units. Settling first and
/// normalising second would charge against a size that no longer exists.
///
/// Returns `(funding_settled, dividends_settled)`, signed from the trader's
/// side: positive funding means they paid, positive dividends means they were
/// paid.
///
/// Every handler that reads or writes a position calls this before doing
/// anything else. It exists because "did this instruction remember to
/// normalise, and in the right order?" is not a question anyone should have to
/// re-answer per handler.
pub fn sync_position(
    position: &mut Position,
    oracle: &PriceOracle,
    market: &Market,
) -> Result<(i128, i128)> {
    position.normalize_for_splits(oracle.split_factor)?;
    let dividends = position.settle_dividends(market.cumulative_dividend_index)?;
    let funding = position.settle_funding(market.cumulative_funding_index)?;
    Ok((funding, dividends))
}

/// What a [`sync_and_settle`] call actually did, all three numbers signed from
/// the trader's side.
///
/// `funding` positive means the trader paid; `dividends` positive means the
/// trader was paid; `settled` is the net amount that moved between the two
/// vaults after clamping for bad debt, which is what the caller emits.
pub struct PositionSync {
    pub funding: i128,
    pub dividends: i128,
    pub settled: i128,
}

/// Sync a position **and** move the resulting money.
///
/// This is the function handlers should call. [`sync_position`] only rewrites
/// the position; on its own it would credit a long its dividend and leave the
/// market vault short by exactly that much, which is the liability-versus-
/// tokens gap the pool exists to close. Funding has the same shape: it is only
/// self-financing when long and short open interest are equal, and they never
/// are.
///
/// The amount moved is read back from the position's collateral rather than
/// taken from the owed figures, because both settlements saturate at zero when
/// a position cannot cover the charge. Booking the owed amount instead of the
/// applied amount would let `total_collateral` drift above the sum of live
/// positions - the exact drift the market's bad-debt accounting exists to make
/// visible.
#[allow(clippy::too_many_arguments)]
pub fn sync_and_settle<'info>(
    position: &mut Position,
    oracle: &PriceOracle,
    market: &mut Account<'info, Market>,
    market_vault: &Account<'info, TokenAccount>,
    pool: &mut Account<'info, LiquidityPool>,
    pool_vault: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    oracle_key: &Pubkey,
) -> Result<PositionSync> {
    let collateral_before = i128::from(position.collateral);
    let (funding, dividends) = sync_position(position, oracle, market)?;
    let applied = i128::from(position.collateral)
        .checked_sub(collateral_before)
        .ok_or(ArclisError::MathOverflow)?;

    if applied == 0 {
        return Ok(PositionSync {
            funding,
            dividends,
            settled: 0,
        });
    }

    let settled = market.settle_realized_pnl(applied)?;
    settle_with_pool(
        settled,
        market,
        market_vault,
        pool,
        pool_vault,
        token_program,
        oracle_key,
    )?;

    Ok(PositionSync {
        funding,
        dividends,
        settled,
    })
}

/// Move realised trader PnL between the market vault and the liquidity pool.
///
/// This is where the counterparty relationship actually becomes money. A
/// trader's realised profit is paid out of the pool; a realised loss is
/// collected into it. Before the pool existed, both sides silently netted
/// against other traders' collateral in one vault, which is the insolvency the
/// pool is here to end.
///
/// `realized` is signed from the *trader's* perspective: positive means the
/// trader made money and the pool pays.
///
/// Both vaults are PDA-owned, so each direction needs its own signer seeds -
/// hence the two branches rather than one transfer with a flipped sign.
#[allow(clippy::too_many_arguments)]
pub fn settle_with_pool<'info>(
    realized: i128,
    market: &Account<'info, Market>,
    market_vault: &Account<'info, TokenAccount>,
    pool: &mut Account<'info, LiquidityPool>,
    pool_vault: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    oracle_key: &Pubkey,
) -> Result<i128> {
    if realized == 0 {
        return Ok(0);
    }

    if realized > 0 {
        // Trader profited: the pool pays into the market vault.
        let amount = fixed::to_u64(realized)?;
        require!(pool_vault.amount >= amount, ArclisError::VaultInsolvent);

        let market_key = market.key();
        let bump = [pool.bump];
        let seeds = LiquidityPool::signer_seeds(&market_key, &bump);
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: pool_vault.to_account_info(),
                    to: market_vault.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[&seeds],
            ),
            amount,
        )?;
        pool.record_realized_pnl(-realized)?;
    } else {
        // Trader lost: the market vault pays into the pool.
        let amount = fixed::to_u64(realized.checked_neg().ok_or(ArclisError::MathOverflow)?)?;
        // Clamp to what the market vault actually holds. A loss larger than the
        // collateral backing it is bad debt, and the caller records it as such
        // rather than this transfer failing and trapping the position.
        let payable = amount.min(market_vault.amount);
        if payable > 0 {
            let bump = [market.bump];
            let seeds = Market::signer_seeds(oracle_key, &bump);
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    Transfer {
                        from: market_vault.to_account_info(),
                        to: pool_vault.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    &[&seeds],
                ),
                payable,
            )?;
            pool.record_realized_pnl(i128::from(payable))?;
        }
    }
    Ok(realized)
}
