use anchor_lang::prelude::*;
use std::cmp::Ordering;

use crate::constants::SPLIT_FACTOR_SCALE;
use crate::errors::ArclisError;
use crate::math::{corporate_actions, fixed, pnl};

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
    /// The oracle's cumulative split factor when this position was last
    /// touched. Lazy corporate-action normalisation keys off this; see
    /// [`Position::normalize_for_splits`].
    pub entry_split_factor: u64,
    /// The market's cumulative dividend index at the last settlement.
    pub entry_dividend_index: i128,
    pub bump: u8,
    pub _reserved: [u8; 8],
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

    /// Bring this position up to date with any corporate actions that happened
    /// while it sat untouched.
    ///
    /// Must be called before any valuation or mutation, because every field it
    /// rewrites - size, entry price, funding snapshot - feeds directly into
    /// PnL. Callers go through `guards::sync_position`, which does this and the
    /// funding settlement together in the right order.
    ///
    /// Cheap and idempotent: the common case is a single `u64` comparison that
    /// returns immediately.
    pub fn normalize_for_splits(&mut self, oracle_split_factor: u64) -> Result<()> {
        let from = self.entry_split_factor;
        let to = oracle_split_factor;
        if from == to {
            return Ok(());
        }
        require!(from != 0 && to != 0, ArclisError::MathOverflow);

        self.size = corporate_actions::rescale_size(self.size, from, to)?;
        self.entry_price = corporate_actions::rescale_price(self.entry_price, from, to)?;
        // The funding index is quote-per-base; if a base unit splits into four,
        // the amount owed per unit must quarter or the position's unsettled
        // funding would quadruple the instant the split landed.
        self.entry_funding_index =
            corporate_actions::rescale_funding_index(self.entry_funding_index, from, to)?;
        self.entry_dividend_index =
            corporate_actions::rescale_funding_index(self.entry_dividend_index, from, to)?;
        self.entry_split_factor = to;
        Ok(())
    }

    /// Fail loudly if a caller forgot to normalise.
    ///
    /// Belt and braces: every handler routes through `guards::sync_position`,
    /// but a future instruction that does not would otherwise silently value a
    /// stale position against a rescaled oracle - which is exactly the
    /// liquidate-everyone bug corporate-action handling exists to prevent.
    pub fn require_normalized(&self, oracle_split_factor: u64) -> Result<()> {
        require!(
            self.entry_split_factor == oracle_split_factor,
            ArclisError::PositionNotNormalized
        );
        Ok(())
    }

    /// Factor a freshly created position starts at.
    pub const fn initial_split_factor() -> u64 {
        SPLIT_FACTOR_SCALE
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
                let credit = fixed::to_u64(owed.checked_neg().ok_or(ArclisError::MathOverflow)?)?;
                self.collateral = self
                    .collateral
                    .checked_add(credit)
                    .ok_or(ArclisError::MathOverflow)?;
            }
        }
        self.entry_funding_index = market_funding_index;
        Ok(owed)
    }

    /// Settle dividends accrued since the last touch.
    ///
    /// Positive means the position is owed (a long); negative means it pays (a
    /// short). Returns the amount so the caller can reconcile the market's
    /// liability total, exactly as with funding.
    pub fn settle_dividends(&mut self, market_dividend_index: i128) -> Result<i128> {
        let owed = corporate_actions::dividend_owed(
            self.size,
            self.entry_dividend_index,
            market_dividend_index,
        )?;
        match owed.cmp(&0) {
            Ordering::Greater => {
                self.collateral = self
                    .collateral
                    .checked_add(fixed::to_u64(owed)?)
                    .ok_or(ArclisError::MathOverflow)?;
            }
            Ordering::Less => {
                let debit = fixed::to_u64(owed.checked_neg().ok_or(ArclisError::MathOverflow)?)?;
                // A short that cannot cover the dividend goes negative on
                // equity, which the liquidation waterfall already handles.
                self.collateral = self.collateral.saturating_sub(debit);
            }
            Ordering::Equal => {}
        }
        self.entry_dividend_index = market_dividend_index;
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
                    .ok_or(ArclisError::MathOverflow)?;
            }
            Ordering::Less => {
                let loss = fixed::to_u64(pnl.checked_neg().ok_or(ArclisError::MathOverflow)?)?;
                self.collateral = self.collateral.saturating_sub(loss);
            }
            Ordering::Equal => {}
        }
        Ok(())
    }

    /// Add to the position at `fill_price`, re-pricing the weighted entry.
    ///
    /// Shared by `open_position` and by treasury hedge rebalancing, which is
    /// the same operation with a PDA rather than a wallet as the owner.
    /// Callers must have settled funding first.
    pub fn increase(&mut self, size_delta: i64, fill_price: u64) -> Result<()> {
        require!(size_delta != 0, ArclisError::ZeroSize);
        if !self.is_flat() {
            require!(
                self.is_long() == (size_delta > 0),
                ArclisError::DirectionFlip
            );
        }
        self.entry_price =
            pnl::weighted_entry_price(self.size, self.entry_price, size_delta, fill_price)?;
        self.size = fixed::to_i64(
            i128::from(self.size)
                .checked_add(i128::from(size_delta))
                .ok_or(ArclisError::MathOverflow)?,
        )?;
        Ok(())
    }

    /// Reduce the position by `reduce_size` base units, realising the
    /// proportional slice of PnL into collateral and returning it.
    ///
    /// Entry price is deliberately left untouched, so the surviving remainder
    /// keeps its original cost basis. Callers must have settled funding first.
    pub fn reduce(&mut self, reduce_size: u64, fill_price: u64) -> Result<i128> {
        require!(reduce_size > 0, ArclisError::ZeroSize);
        require!(!self.is_flat(), ArclisError::InsufficientPositionSize);
        let abs_size = self.size.unsigned_abs();
        require!(
            reduce_size <= abs_size,
            ArclisError::InsufficientPositionSize
        );

        let total_pnl = self.unrealized_pnl(fill_price)?;
        let realized = fixed::mul_div(total_pnl, i128::from(reduce_size), i128::from(abs_size))?;
        self.apply_realized_pnl(realized)?;

        let was_long = self.is_long();
        let new_abs = abs_size
            .checked_sub(reduce_size)
            .ok_or(ArclisError::MathOverflow)?;
        let new_size = fixed::to_i64(i128::from(new_abs))?;
        self.size = if was_long { new_size } else { -new_size };
        if new_abs == 0 {
            self.entry_price = 0;
        }
        Ok(realized)
    }

    pub fn debit_collateral(&mut self, amount: u64) -> Result<()> {
        self.collateral = self
            .collateral
            .checked_sub(amount)
            .ok_or(ArclisError::InsufficientCollateral)?;
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
        require!(equity > 0, ArclisError::BelowInitialMargin);
        let max_notional = equity
            .checked_mul(i128::from(market.max_leverage))
            .ok_or(ArclisError::MathOverflow)?;
        require!(notional <= max_notional, ArclisError::ExceedsMaxLeverage);

        // Initial margin, which sits strictly above maintenance.
        let ratio = pnl::margin_ratio_bps(equity, notional)?;
        require!(
            ratio >= i128::from(market.initial_margin_bps),
            ArclisError::BelowInitialMargin
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{FUNDING_INDEX_SCALE, PRICE_SCALE};
    use crate::math::corporate_actions::SplitRatio;

    /// The 1e6 scale every quote quantity in these tests is quoted at, as
    /// `u64`. The constants are `i128` because the math layer works in `i128`;
    /// `Position` stores `u64`, so the tests need both.
    const Q: u64 = PRICE_SCALE as u64;
    const SHARE: i64 = 1_000_000;

    fn position(size: i64, entry_price: u64, collateral: u64) -> Position {
        Position {
            owner: Pubkey::default(),
            market: Pubkey::default(),
            size,
            entry_price,
            collateral,
            entry_funding_index: 0,
            last_update_ts: 0,
            entry_split_factor: SPLIT_FACTOR_SCALE,
            entry_dividend_index: 0,
            bump: 0,
            _reserved: [0u8; 8],
        }
    }

    /// Index in the same units `Market::apply_dividend` produces.
    fn dividend_index(per_share: u64) -> i128 {
        corporate_actions::dividend_index_delta(per_share).unwrap()
    }

    #[test]
    fn a_long_is_credited_and_a_short_pays_the_same_amount() {
        // 5 shares, $2 a share.
        let mut long = position(5 * SHARE, 100 * Q, 1_000 * Q);
        let mut short = position(-5 * SHARE, 100 * Q, 1_000 * Q);
        let index = dividend_index(2 * Q);

        let credited = long.settle_dividends(index).unwrap();
        let paid = short.settle_dividends(index).unwrap();

        assert_eq!(credited, 10 * PRICE_SCALE);
        assert_eq!(paid, -credited);
        assert_eq!(long.collateral, 1_010 * Q);
        assert_eq!(short.collateral, 990 * Q);
    }

    #[test]
    fn settling_twice_pays_once() {
        let mut long = position(5 * SHARE, 100 * Q, 1_000 * Q);
        let index = dividend_index(2 * Q);

        long.settle_dividends(index).unwrap();
        let second = long.settle_dividends(index).unwrap();

        assert_eq!(second, 0);
        assert_eq!(long.collateral, 1_010 * Q);
    }

    #[test]
    fn a_flat_position_is_owed_nothing_but_still_moves_its_snapshot() {
        let mut flat = position(0, 0, 500 * Q);
        let index = dividend_index(2 * Q);

        assert_eq!(flat.settle_dividends(index).unwrap(), 0);
        assert_eq!(flat.collateral, 500 * Q);
        // Critical: a position that was flat over the ex-date must not be able
        // to open afterwards and immediately claim the credit.
        assert_eq!(flat.entry_dividend_index, index);
    }

    #[test]
    fn a_short_that_cannot_cover_the_dividend_goes_to_zero_not_negative() {
        // Collateral is `u64`, so the shortfall shows up as negative equity via
        // unrealised PnL rather than as a wrapped balance.
        let mut short = position(-5 * SHARE, 100 * Q, 3 * Q);
        let index = dividend_index(2 * Q);

        assert_eq!(short.settle_dividends(index).unwrap(), -10 * PRICE_SCALE);
        assert_eq!(short.collateral, 0);
    }

    /// The interaction that actually has teeth: a dividend accrues, then the
    /// stock splits before the position is next touched. The credit was earned
    /// on pre-split shares and must not quadruple when the share count does.
    #[test]
    fn a_dividend_earned_before_a_split_is_not_multiplied_by_it() {
        let mut held = position(5 * SHARE, 100 * Q, 1_000 * Q);
        let mut settled_early = position(5 * SHARE, 100 * Q, 1_000 * Q);

        let index = dividend_index(2 * Q);

        // One position settles before the split, the other sleeps through it.
        settled_early.settle_dividends(index).unwrap();

        let from = SPLIT_FACTOR_SCALE;
        let to = corporate_actions::advance_split_factor(
            from,
            SplitRatio {
                numerator: 4,
                denominator: 1,
            },
        )
        .unwrap();

        settled_early.normalize_for_splits(to).unwrap();
        held.normalize_for_splits(to).unwrap();

        // The market's index rescales with the factor in the same transaction.
        let rescaled_index = corporate_actions::rescale_funding_index(index, from, to).unwrap();
        held.settle_dividends(rescaled_index).unwrap();

        assert_eq!(held.collateral, settled_early.collateral);
        assert_eq!(held.collateral, 1_010 * Q);
    }

    #[test]
    fn dividends_and_funding_do_not_share_a_snapshot() {
        let mut long = position(5 * SHARE, 100 * Q, 1_000 * Q);

        // $1 of funding paid, $2 of dividend received: the two are independent
        // and must not cancel through one shared index.
        let funding_index = FUNDING_INDEX_SCALE / 5; // 0.2 quote per share
        long.settle_funding(funding_index).unwrap();
        let after_funding = long.collateral;
        assert_eq!(after_funding, 1_000 * Q - Q);

        long.settle_dividends(dividend_index(2 * Q)).unwrap();
        assert_eq!(long.collateral, after_funding + 10 * Q);
        assert_eq!(long.entry_funding_index, funding_index);
    }
}
