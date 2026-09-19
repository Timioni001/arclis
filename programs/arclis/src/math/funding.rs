//! Skew-driven funding.
//!
//! # Why skew and not mark-minus-index
//!
//! A conventional perp derives funding from the premium of its own mark price
//! over the index. This engine is cash-settled straight against the oracle, so
//! mark *is* index and that premium is identically zero. There is no internal
//! price to compare against.
//!
//! What remains observable is the open-interest imbalance. If longs outweigh
//! shorts, the vault is net short the asset and wants to attract shorts, so
//! longs pay. That is the same economic role - pull the book toward balance -
//! driven by the only signal this design exposes.
//!
//! The honest limitation: skew funding responds to positioning, not to price,
//! so it cannot arbitrage a persistent basis the way premium funding does. It
//! is the right choice given no internal order book, and the wrong choice the
//! moment one exists. See `docs/FEASIBILITY.md`.

use crate::constants::*;
use crate::errors::ArclisError;
use crate::math::fixed::mul_div;

/// Open-interest skew in bps, positive when longs dominate.
///
/// `(long - short) / (long + short)`, so it is bounded to ±10_000 by
/// construction and a market with no open interest reports zero rather than
/// dividing by zero.
pub fn skew_bps(open_interest_long: u64, open_interest_short: u64) -> Result<i128, ArclisError> {
    let long = i128::from(open_interest_long);
    let short = i128::from(open_interest_short);
    let total = long.checked_add(short).ok_or(ArclisError::MathOverflow)?;
    if total == 0 {
        return Ok(0);
    }
    let diff = long.checked_sub(short).ok_or(ArclisError::MathOverflow)?;
    mul_div(diff, BPS_SCALE, total)
}

/// Per-interval funding rate in bps, positive when longs pay shorts.
///
/// Scaled by the market's sensitivity, then amplified by how hard the
/// liquidity pool is working, then hard-clamped to
/// [`MAX_FUNDING_RATE_BPS_PER_INTERVAL`].
///
/// # Why utilisation enters here
///
/// Skew alone says the book is lopsided. It does not say whether that matters.
/// A 60% long skew against a deep pool is a rounding error; the same skew
/// against a pool at its utilisation cap is the thing standing between the
/// protocol and insolvency.
///
/// Folding utilisation into the rate makes funding do the job it exists for:
/// the more of the pool's capital the imbalance is consuming, the more the
/// heavy side pays to whoever will take the other one. At zero utilisation
/// this is exactly the old skew-only rate, so quiet markets are unaffected;
/// at 100% it doubles.
///
/// The clamp is applied last and is not configurable, so no combination of
/// sensitivity and utilisation can produce a charge larger than the protocol
/// maximum.
pub fn funding_rate_bps(
    skew_bps: i128,
    sensitivity_bps: u16,
    utilization_bps: i128,
) -> Result<i128, ArclisError> {
    let base = mul_div(skew_bps, i128::from(sensitivity_bps), BPS_SCALE)?;

    // Amplify by (1 + utilisation), saturating rather than overflowing on the
    // `i128::MAX` a zero-NAV pool reports.
    let utilization = utilization_bps.clamp(0, UTILIZATION_FUNDING_MULTIPLIER_BPS);
    let multiplier = BPS_SCALE
        .checked_add(utilization)
        .ok_or(ArclisError::MathOverflow)?;
    let amplified = mul_div(base, multiplier, BPS_SCALE)?;

    Ok(amplified.clamp(
        -MAX_FUNDING_RATE_BPS_PER_INTERVAL,
        MAX_FUNDING_RATE_BPS_PER_INTERVAL,
    ))
}

/// How many whole funding intervals a crank should settle.
///
/// Capped at [`MAX_FUNDING_INTERVALS_PER_CRANK`]. A market nobody cranked over
/// a long weekend would otherwise hit every open position with a single
/// enormous charge the moment someone touched it; the cap converts that into a
/// bounded catch-up that several cranks can work through.
pub fn intervals_elapsed(elapsed_secs: i64, interval_secs: i64) -> Result<i128, ArclisError> {
    if interval_secs <= 0 {
        return Err(ArclisError::DivideByZero);
    }
    let n = i128::from(elapsed_secs)
        .checked_div(i128::from(interval_secs))
        .ok_or(ArclisError::MathOverflow)?;
    Ok(n.clamp(0, MAX_FUNDING_INTERVALS_PER_CRANK))
}

/// The increment to add to `Market::cumulative_funding_index`.
///
/// The index is **quote owed per base unit**, at [`FUNDING_INDEX_SCALE`]:
///
/// ```text
/// delta = rate_bps * mark_price * FUNDING_INDEX_SCALE / (BPS_SCALE * PRICE_SCALE)
/// ```
///
/// Folding `mark_price` in here is what makes
/// [`crate::math::pnl::funding_owed`] return quote directly. The original
/// engine omitted it, which under-charged a $200 asset by 200x relative to a
/// $1 one; it is also why `crank_funding` now requires the oracle account,
/// which it previously did not take at all.
pub fn funding_index_delta(
    rate_bps: i128,
    mark_price: u64,
    intervals: i128,
) -> Result<i128, ArclisError> {
    if intervals == 0 || rate_bps == 0 {
        return Ok(0);
    }
    // quote-per-base at index scale, for a single interval
    let per_interval = mul_div(
        i128::from(mark_price),
        rate_bps
            .checked_mul(FUNDING_INDEX_SCALE)
            .ok_or(ArclisError::MathOverflow)?,
        BPS_SCALE
            .checked_mul(PRICE_SCALE)
            .ok_or(ArclisError::MathOverflow)?,
    )?;
    per_interval
        .checked_mul(intervals)
        .ok_or(ArclisError::MathOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const P100: u64 = 100 * PRICE_SCALE as u64;

    #[test]
    fn balanced_book_has_no_skew() {
        assert_eq!(skew_bps(1_000, 1_000).unwrap(), 0);
    }

    #[test]
    fn empty_book_has_no_skew_and_does_not_divide_by_zero() {
        assert_eq!(skew_bps(0, 0).unwrap(), 0);
    }

    #[test]
    fn skew_is_bounded_to_full_bps_at_the_extremes() {
        assert_eq!(skew_bps(1_000, 0).unwrap(), 10_000);
        assert_eq!(skew_bps(0, 1_000).unwrap(), -10_000);
    }

    #[test]
    fn skew_sign_follows_the_heavier_side() {
        assert_eq!(skew_bps(3_000, 1_000).unwrap(), 5_000);
        assert_eq!(skew_bps(1_000, 3_000).unwrap(), -5_000);
    }

    #[test]
    fn sensitivity_scales_the_rate() {
        // 5000 bps skew at 10% sensitivity == 500 bps, then clamped to 50.
        assert_eq!(funding_rate_bps(5_000, 1_000, 0).unwrap(), 50);
        // 5000 bps skew at 0.1% sensitivity == 5 bps, under the clamp.
        assert_eq!(funding_rate_bps(5_000, 10, 0).unwrap(), 5);
    }

    #[test]
    fn rate_is_clamped_in_both_directions_regardless_of_config() {
        assert_eq!(
            funding_rate_bps(10_000, 10_000, 10_000).unwrap(),
            MAX_FUNDING_RATE_BPS_PER_INTERVAL
        );
        assert_eq!(
            funding_rate_bps(-10_000, 10_000, 10_000).unwrap(),
            -MAX_FUNDING_RATE_BPS_PER_INTERVAL
        );
    }

    #[test]
    fn zero_sensitivity_disables_funding() {
        assert_eq!(funding_rate_bps(10_000, 0, 10_000).unwrap(), 0);
    }

    /// An idle pool must leave the rate exactly where the old skew-only formula
    /// put it, so quiet markets are unaffected by adding utilisation.
    #[test]
    fn zero_utilization_reproduces_the_skew_only_rate() {
        assert_eq!(funding_rate_bps(5_000, 10, 0).unwrap(), 5);
    }

    #[test]
    fn full_utilization_doubles_the_rate() {
        let idle = funding_rate_bps(5_000, 10, 0).unwrap();
        let loaded = funding_rate_bps(5_000, 10, 10_000).unwrap();
        assert_eq!(loaded, idle * 2);
    }

    #[test]
    fn utilization_amplification_is_monotonic() {
        let mut previous = 0;
        for u in [0, 2_500, 5_000, 7_500, 10_000] {
            let rate = funding_rate_bps(5_000, 4, u).unwrap();
            assert!(
                rate >= previous,
                "rate fell as utilisation rose: {rate} < {previous}"
            );
            previous = rate;
        }
    }

    /// A pool with no NAV reports `i128::MAX` utilisation. That must saturate
    /// to the cap rather than overflow the multiply.
    #[test]
    fn saturated_utilization_does_not_overflow() {
        assert_eq!(
            funding_rate_bps(10_000, 10_000, i128::MAX).unwrap(),
            MAX_FUNDING_RATE_BPS_PER_INTERVAL
        );
    }

    #[test]
    fn utilization_cannot_break_the_clamp() {
        for u in [0, 10_000, 1_000_000, i128::MAX] {
            let rate = funding_rate_bps(10_000, 10_000, u).unwrap();
            assert!(rate.abs() <= MAX_FUNDING_RATE_BPS_PER_INTERVAL);
        }
    }

    #[test]
    fn intervals_are_whole_and_capped() {
        assert_eq!(intervals_elapsed(3_600, 3_600).unwrap(), 1);
        assert_eq!(intervals_elapsed(7_199, 3_600).unwrap(), 1);
        assert_eq!(intervals_elapsed(7_200, 3_600).unwrap(), 2);
        // A week of neglect settles at most the cap, not 168 intervals.
        assert_eq!(
            intervals_elapsed(168 * 3_600, 3_600).unwrap(),
            MAX_FUNDING_INTERVALS_PER_CRANK
        );
    }

    #[test]
    fn intervals_rejects_a_zero_interval() {
        assert_eq!(intervals_elapsed(100, 0), Err(ArclisError::DivideByZero));
    }

    /// End-to-end units check: 50 bps on a $100 asset must charge $0.50 per
    /// base unit, and the index must carry that in quote, not in rate.
    #[test]
    fn index_delta_carries_the_price() {
        use crate::math::pnl::funding_owed;
        let delta = funding_index_delta(50, P100, 1).unwrap();
        let owed = funding_owed(BASE_SCALE as i64, 0, delta).unwrap();
        assert_eq!(owed, 500_000); // $0.50 at 1e6
    }

    /// The same rate on a 200x more expensive asset must charge 200x more.
    /// This is the property the original engine violated.
    #[test]
    fn index_delta_scales_with_asset_price() {
        let cheap = funding_index_delta(50, PRICE_SCALE as u64, 1).unwrap();
        let dear = funding_index_delta(50, 200 * PRICE_SCALE as u64, 1).unwrap();
        assert_eq!(dear, cheap * 200);
    }

    #[test]
    fn index_delta_is_linear_in_intervals() {
        let one = funding_index_delta(50, P100, 1).unwrap();
        let six = funding_index_delta(50, P100, 6).unwrap();
        assert_eq!(six, one * 6);
    }

    #[test]
    fn no_rate_or_no_intervals_means_no_accrual() {
        assert_eq!(funding_index_delta(0, P100, 5).unwrap(), 0);
        assert_eq!(funding_index_delta(50, P100, 0).unwrap(), 0);
    }

    #[test]
    fn negative_rate_moves_the_index_down() {
        assert_eq!(
            funding_index_delta(-50, P100, 1).unwrap(),
            -funding_index_delta(50, P100, 1).unwrap()
        );
    }
}
