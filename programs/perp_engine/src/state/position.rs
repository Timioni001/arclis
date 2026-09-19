use anchor_lang::prelude::*;
use std::cmp::Ordering;

use crate::errors::PerpError;
use crate::math::{fixed, pnl};

use super::market::Market;

/// A trader's position in one market. One per (owner, market) pair.
///
/// Collateral is isolated per market by construction, because the PDA seeds
/// include the market. That is a deliberate risk choice: a blow-up in one
/// market cannot reach into a trader's margin in another. It also means capital
/// is less efficient than a cross-margin design, which is the trade-off to
/// revisit if this ever grows past a handful of markets.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    /// Signed base size at [`crate::constants::BASE_SCALE`]. `+` long, `-` short.
    pub size: i64,
    /// Size-weighted average entry, at [`crate::constants::PRICE_SCALE`].
    pub entry_price: u64,
    /// Quote collateral at [`crate::constants::QUOTE_SCALE`].
    pub collateral: u64,
    /// Funding index snapshot at the last settlement.
    pub entry_funding_index: i128,
    pub last_update_ts: i64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl Position {
    pub const SEED: &'static [u8] = b"position";
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    pub fn is_long(&self) -> bool {
        self.size > 0
    }

    pub fn is_flat(&self) -> bool {
        self.size == 0
    }

    // --- valuation: thin forwards into `math::pnl` -------------------------

    pub fn notional(&self, mark_price: u64) -> Result<i128> {
        Ok(pnl::notional(self.size, mark_price)?)
    }

    pub fn unrealized_pnl(&self, mark_price: u64) -> Result<i128> {
        Ok(pnl::unrealized_pnl(
            self.size,
            self.entry_price,
            mark_price,
        )?)
    }

    pub fn funding_owed(&self, market_funding_index: i128) -> Result<i128> {
        Ok(pnl::funding_owed(
            self.size,
            self.entry_funding_index,
            market_funding_index,
        )?)
    }

    pub fn equity(&self, mark_price: u64, market_funding_index: i128) -> Result<i128> {
        Ok(pnl::equity(
            self.collateral,
            self.size,
            self.entry_price,
            mark_price,
            self.entry_funding_index,
            market_funding_index,
        )?)
    }

    pub fn margin_ratio_bps(&self, mark_price: u64, market_funding_index: i128) -> Result<i128> {
        let equity = self.equity(mark_price, market_funding_index)?;
        let notional = self.notional(mark_price)?;
        Ok(pnl::margin_ratio_bps(equity, notional)?)
    }

    // --- mutation ----------------------------------------------------------

    /// Move accrued funding into realised collateral and re-snapshot the index.
    ///
    /// Returns the amount settled (positive = the trader paid) so the caller can
    /// emit it and reconcile the market's liability total. Every path that
    /// changes size or collateral must call this *first*, or the position would
    /// accrue funding against a size it no longer has.
    ///
    /// A charge larger than the collateral saturates at zero here; the
    /// uncovered part is not silently forgiven, it shows up as negative equity
    /// and is handled by the liquidation waterfall.
    pub fn settle_funding(&mut self, market_funding_index: i128) -> Result<i128> {
        let owed = self.funding_owed(market_funding_index)?;
        if owed != 0 {
            if owed > 0 {
                let charge = fixed::to_u64(owed)?;
                self.collateral = self.collateral.saturating_sub(charge);
            } else {
                let credit = fixed::to_u64(owed.checked_neg().ok_or(PerpError::MathOverflow)?)?;
                self.collateral = self
                    .collateral
                    .checked_add(credit)
                    .ok_or(PerpError::MathOverflow)?;
            }
        }
        self.entry_funding_index = market_funding_index;
        Ok(owed)
    }

    /// Apply realised PnL to collateral, saturating at zero on a loss.
    ///
    /// Saturation is correct here and not a papering-over: the shortfall is
    /// exactly the bad debt the liquidation path is responsible for, and
    /// letting collateral go "negative" is not representable in a `u64`.
    pub fn apply_realized_pnl(&mut self, pnl: i128) -> Result<()> {
        match pnl.cmp(&0) {
            Ordering::Greater => {
                self.collateral = self
                    .collateral
                    .checked_add(fixed::to_u64(pnl)?)
                    .ok_or(PerpError::MathOverflow)?;
            }
            Ordering::Less => {
                let loss = fixed::to_u64(pnl.checked_neg().ok_or(PerpError::MathOverflow)?)?;
                self.collateral = self.collateral.saturating_sub(loss);
            }
            Ordering::Equal => {}
        }
        Ok(())
    }

    pub fn debit_collateral(&mut self, amount: u64) -> Result<()> {
        self.collateral = self
            .collateral
            .checked_sub(amount)
            .ok_or(PerpError::InsufficientCollateral)?;
        Ok(())
    }

    /// Check the position against the market's *initial* margin requirement.
    ///
    /// Called after any size increase. The original engine only checked a
    /// leverage cap against raw collateral, which ignored unrealised PnL and
    /// unsettled funding entirely: a position sitting on a large loss could add
    /// to itself right up to the leverage cap and land below maintenance margin
    /// in the same instruction, instantly liquidatable.
    pub fn require_initial_margin(&self, mark_price: u64, market: &Market) -> Result<()> {
        if self.is_flat() {
            return Ok(());
        }
        let equity = self.equity(mark_price, self.entry_funding_index)?;
        let notional = self.notional(mark_price)?;

        // Leverage cap, on notional against equity rather than raw collateral.
        require!(equity > 0, PerpError::BelowInitialMargin);
        let max_notional = equity
            .checked_mul(i128::from(market.max_leverage))
            .ok_or(PerpError::MathOverflow)?;
        require!(notional <= max_notional, PerpError::ExceedsMaxLeverage);

        // Initial margin, which sits strictly above maintenance.
        let ratio = pnl::margin_ratio_bps(equity, notional)?;
        require!(
            ratio >= i128::from(market.initial_margin_bps),
            PerpError::BelowInitialMargin
        );
        Ok(())
    }
}
