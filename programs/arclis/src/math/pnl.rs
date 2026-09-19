//! Position valuation: notional, PnL, funding, equity, margin.
//!
//! These are pure functions over plain integers. `state::Position` is a thin
//! wrapper that forwards its own fields into them, which keeps the account
//! layout and the arithmetic independently reviewable.

use crate::constants::*;
use crate::errors::ArclisError;
use crate::math::fixed::{mul_div, mul_div_floor};

/// Quote value of a position at a given price: `|size| * price / PRICE_SCALE`.
///
/// Always non-negative - direction lives in the sign of `size`, not in notional.
#[inline]
pub fn notional(size: i64, price: u64) -> Result<i128, ArclisError> {
    mul_div(i128::from(size).abs(), i128::from(price), PRICE_SCALE)
}

/// Unrealized PnL in quote units. Positive means the trader is up.
///
/// `size * (mark - entry) / PRICE_SCALE`. The sign of `size` makes this work
/// for both directions without a branch: a short (negative size) profits when
/// `mark < entry` because both factors are negative.
#[inline]
pub fn unrealized_pnl(size: i64, entry_price: u64, mark_price: u64) -> Result<i128, ArclisError> {
    let delta = i128::from(mark_price)
        .checked_sub(i128::from(entry_price))
        .ok_or(ArclisError::MathOverflow)?;
    mul_div(i128::from(size), delta, PRICE_SCALE)
}

/// Funding owed by a position since it last settled. Positive means the trader
/// pays; negative means the trader receives.
///
/// `size * (index_now - index_at_entry) / FUNDING_INDEX_SCALE`.
///
/// The index is denominated in **quote per base unit**, so this returns quote
/// directly. That is the fix for the original engine's funding bug, where the
/// index was a bare rate and the mark price never entered the calculation - a
/// $200 asset was charged the same funding as a $1 asset.
///
/// Rounds toward -inf so that a charge is never rounded down in the payer's
/// favour.
#[inline]
pub fn funding_owed(
    size: i64,
    entry_funding_index: i128,
    market_funding_index: i128,
) -> Result<i128, ArclisError> {
    let delta = market_funding_index
        .checked_sub(entry_funding_index)
        .ok_or(ArclisError::MathOverflow)?;
    mul_div_floor(i128::from(size), delta, FUNDING_INDEX_SCALE)
}

/// Account equity: collateral, marked to market, net of unsettled funding.
///
/// May be negative - that is precisely the bad-debt case, and callers must not
/// clamp it before deciding how to handle the shortfall.
#[inline]
pub fn equity(
    collateral: u64,
    size: i64,
    entry_price: u64,
    mark_price: u64,
    entry_funding_index: i128,
    market_funding_index: i128,
) -> Result<i128, ArclisError> {
    let pnl = unrealized_pnl(size, entry_price, mark_price)?;
    let funding = funding_owed(size, entry_funding_index, market_funding_index)?;
    i128::from(collateral)
        .checked_add(pnl)
        .ok_or(ArclisError::MathOverflow)?
        .checked_sub(funding)
        .ok_or(ArclisError::MathOverflow)
}

/// Margin ratio in bps: `equity / notional`.
///
/// A flat position has no notional and therefore infinite margin; callers get
/// `i128::MAX` rather than a division error, because "cannot be liquidated" is
/// the correct answer, not a failure.
#[inline]
pub fn margin_ratio_bps(equity: i128, notional: i128) -> Result<i128, ArclisError> {
    if notional == 0 {
        return Ok(i128::MAX);
    }
    mul_div(equity, BPS_SCALE, notional)
}

/// Size-weighted average entry price when adding to an existing position.
///
/// Both legs are valued at their own entry price and the total is divided by
/// the combined size. Only called for same-direction increases; flipping
/// direction is rejected upstream so this never has to net two signs.
pub fn weighted_entry_price(
    old_size: i64,
    old_entry_price: u64,
    added_size: i64,
    fill_price: u64,
) -> Result<u64, ArclisError> {
    let old_abs = i128::from(old_size).abs();
    let added_abs = i128::from(added_size).abs();
    let new_abs = old_abs
        .checked_add(added_abs)
        .ok_or(ArclisError::MathOverflow)?;
    if new_abs == 0 {
        return Ok(0);
    }
    let old_leg = old_abs
        .checked_mul(i128::from(old_entry_price))
        .ok_or(ArclisError::MathOverflow)?;
    let added_leg = added_abs
        .checked_mul(i128::from(fill_price))
        .ok_or(ArclisError::MathOverflow)?;
    let avg = old_leg
        .checked_add(added_leg)
        .ok_or(ArclisError::MathOverflow)?
        .checked_div(new_abs)
        .ok_or(ArclisError::MathOverflow)?;
    u64::try_from(avg).map_err(|_| ArclisError::MathOverflow)
}

/// Fee on a notional amount, rounded up so the protocol never under-charges.
#[inline]
pub fn fee_on_notional(notional: i128, fee_bps: u16) -> Result<i128, ArclisError> {
    if fee_bps == 0 {
        return Ok(0);
    }
    let num = notional
        .checked_mul(i128::from(fee_bps))
        .ok_or(ArclisError::MathOverflow)?;
    // Ceiling division on a non-negative numerator.
    num.checked_add(BPS_SCALE - 1)
        .ok_or(ArclisError::MathOverflow)?
        .checked_div(BPS_SCALE)
        .ok_or(ArclisError::MathOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: i64 = BASE_SCALE as i64; // one whole unit of base
    const P100: u64 = 100 * PRICE_SCALE as u64;
    const P110: u64 = 110 * PRICE_SCALE as u64;
    const P90: u64 = 90 * PRICE_SCALE as u64;

    #[test]
    fn notional_ignores_direction() {
        assert_eq!(notional(ONE, P100).unwrap(), 100 * QUOTE_SCALE);
        assert_eq!(notional(-ONE, P100).unwrap(), 100 * QUOTE_SCALE);
    }

    #[test]
    fn long_profits_when_price_rises() {
        assert_eq!(unrealized_pnl(ONE, P100, P110).unwrap(), 10 * QUOTE_SCALE);
        assert_eq!(unrealized_pnl(ONE, P100, P90).unwrap(), -10 * QUOTE_SCALE);
    }

    #[test]
    fn short_profits_when_price_falls() {
        assert_eq!(unrealized_pnl(-ONE, P100, P90).unwrap(), 10 * QUOTE_SCALE);
        assert_eq!(unrealized_pnl(-ONE, P100, P110).unwrap(), -10 * QUOTE_SCALE);
    }

    #[test]
    fn pnl_is_zero_at_entry() {
        assert_eq!(unrealized_pnl(ONE, P100, P100).unwrap(), 0);
        assert_eq!(unrealized_pnl(-ONE, P100, P100).unwrap(), 0);
    }

    /// The regression test for the original funding bug. The index carries the
    /// price, so a 1% funding charge on a $100 asset is $1 per unit, not the
    /// price-independent 0.01 the old code produced.
    #[test]
    fn funding_is_denominated_in_quote_not_base() {
        // index delta == 1 quote unit per base unit, at 1e9 scale
        let delta = QUOTE_SCALE * FUNDING_INDEX_SCALE / QUOTE_SCALE;
        assert_eq!(funding_owed(ONE, 0, delta).unwrap(), QUOTE_SCALE);
        // A short with the same index delta receives instead of pays.
        assert_eq!(funding_owed(-ONE, 0, delta).unwrap(), -QUOTE_SCALE);
    }

    #[test]
    fn funding_is_zero_when_index_has_not_moved() {
        assert_eq!(funding_owed(ONE, 12_345, 12_345).unwrap(), 0);
    }

    #[test]
    fn equity_combines_collateral_pnl_and_funding() {
        // $50 collateral, 1 unit long from $100, mark $110, no funding.
        let e = equity(50 * QUOTE_SCALE as u64, ONE, P100, P110, 0, 0).unwrap();
        assert_eq!(e, 60 * QUOTE_SCALE);
    }

    #[test]
    fn equity_goes_negative_on_bad_debt_and_is_not_clamped() {
        // $5 collateral, 1 unit long from $100, mark crashes to $90.
        let e = equity(5 * QUOTE_SCALE as u64, ONE, P100, P90, 0, 0).unwrap();
        assert_eq!(e, -5 * QUOTE_SCALE);
    }

    #[test]
    fn margin_ratio_matches_hand_calculation() {
        // $10 equity against $100 notional == 1000 bps == 10%.
        assert_eq!(
            margin_ratio_bps(10 * QUOTE_SCALE, 100 * QUOTE_SCALE).unwrap(),
            1_000
        );
    }

    #[test]
    fn flat_position_has_infinite_margin_not_an_error() {
        assert_eq!(margin_ratio_bps(0, 0).unwrap(), i128::MAX);
    }

    #[test]
    fn weighted_entry_is_the_midpoint_for_equal_legs() {
        // 1 unit at $100 plus 1 unit at $110 averages to $105.
        let p = weighted_entry_price(ONE, P100, ONE, P110).unwrap();
        assert_eq!(p, 105 * PRICE_SCALE as u64);
    }

    #[test]
    fn weighted_entry_works_for_shorts() {
        let p = weighted_entry_price(-ONE, P100, -ONE, P110).unwrap();
        assert_eq!(p, 105 * PRICE_SCALE as u64);
    }

    #[test]
    fn weighted_entry_from_flat_is_the_fill_price() {
        assert_eq!(weighted_entry_price(0, 0, ONE, P100).unwrap(), P100);
    }

    #[test]
    fn fee_rounds_up_so_dust_trades_still_pay() {
        // 1 bps on $100 notional == $0.01
        assert_eq!(fee_on_notional(100 * QUOTE_SCALE, 1).unwrap(), 10_000);
        // Any non-zero notional with a non-zero rate pays at least 1 unit.
        assert_eq!(fee_on_notional(1, 1).unwrap(), 1);
        assert_eq!(fee_on_notional(0, 10).unwrap(), 0);
        assert_eq!(fee_on_notional(100 * QUOTE_SCALE, 0).unwrap(), 0);
    }
}
