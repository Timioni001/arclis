//! Treasury hedging maths.
//!
//! # The problem this solves
//!
//! An agent launches its token on a Meteora DBC curve whose **quote token is a
//! tokenized stock** — contributors pay in AAPLx rather than SOL or USDC. That
//! is the whole point of a stock-paired launch: the raise is denominated in the
//! asset the agent is supposed to be expert in.
//!
//! It also leaves the agent holding a problem. When the curve graduates, the
//! treasury is 100% long AAPL beta that nobody chose. An agent that raised the
//! equivalent of $100k to pay for inference and data now has a war chest that
//! is worth $70k if Apple has a bad quarter. The agent's runway is levered to a
//! stock price it has no view on and no control over.
//!
//! The fix is the oldest one in finance: hold the asset, short the future.
//! The treasury keeps its AAPLx — it stays the agent's balance sheet, it can
//! still be used as the DBC quote asset — and opens an offsetting short on the
//! AAPL perp market in this same program. Net delta goes to roughly zero, the
//! dollar value of the runway stops moving, and while the book is skewed long
//! the short *earns* funding rather than paying it.
//!
//! # What "hedged" means numerically
//!
//! ```text
//! delta        = stock_qty + perp_size      (perp_size is negative for a short)
//! target_delta = stock_qty * (1 - hedge_ratio)
//! ```
//!
//! A `hedge_ratio` of 10_000 bps is fully neutral; 0 is unhedged; 5_000 keeps
//! half the exposure for an agent that does want a view. Rebalancing is
//! permissionless and only fires outside a tolerance band, so it cannot be
//! farmed for fees by cranking it every slot.

use crate::constants::*;
use crate::errors::ArclisError;
use crate::math::fixed::mul_div;
use crate::math::pnl;

/// A treasury's exposure, valued at a point in time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreasuryExposure {
    /// Quote value of the stock the treasury holds outright.
    pub stock_value: i128,
    /// Quote value of the perp position's PnL and collateral.
    pub perp_equity: i128,
    /// Net base-unit exposure: positive is net long the underlying.
    pub net_delta: i64,
    /// Total treasury value in quote units.
    pub nav: i128,
}

/// Value a treasury.
///
/// `stock_qty` is held spot, at [`BASE_SCALE`]. `perp_size` is the offsetting
/// perp position, signed, so a short is negative and the two cancel.
pub fn exposure(
    stock_qty: u64,
    perp_size: i64,
    perp_collateral: u64,
    perp_entry_price: u64,
    perp_entry_funding_index: i128,
    market_funding_index: i128,
    mark_price: u64,
) -> Result<TreasuryExposure, ArclisError> {
    let stock_value = mul_div(i128::from(stock_qty), i128::from(mark_price), PRICE_SCALE)?;

    let perp_equity = pnl::equity(
        perp_collateral,
        perp_size,
        perp_entry_price,
        mark_price,
        perp_entry_funding_index,
        market_funding_index,
    )?;

    let net_delta = i64::try_from(
        i128::from(stock_qty)
            .checked_add(i128::from(perp_size))
            .ok_or(ArclisError::MathOverflow)?,
    )
    .map_err(|_| ArclisError::MathOverflow)?;

    let nav = stock_value
        .checked_add(perp_equity)
        .ok_or(ArclisError::MathOverflow)?;

    Ok(TreasuryExposure {
        stock_value,
        perp_equity,
        net_delta,
        nav,
    })
}

/// The delta this treasury is *aiming* for, given its hedge ratio.
///
/// At 10_000 bps the target is zero — fully neutral. At 0 the target is the
/// full stock holding — completely unhedged, which is a legitimate choice for
/// an agent that wants the exposure.
pub fn target_delta(stock_qty: u64, hedge_ratio_bps: u16) -> Result<i64, ArclisError> {
    let unhedged_bps = BPS_SCALE
        .checked_sub(i128::from(hedge_ratio_bps))
        .ok_or(ArclisError::MathOverflow)?;
    let target = mul_div(i128::from(stock_qty), unhedged_bps, BPS_SCALE)?;
    i64::try_from(target).map_err(|_| ArclisError::MathOverflow)
}

/// The perp size change that would bring the treasury back to target.
///
/// Returns `0` when the drift is inside `tolerance_bps` of the stock holding.
/// That band is what makes a permissionless rebalance safe to expose: without
/// it, anyone could crank a one-lamport correction every slot and bleed the
/// treasury through taker fees.
pub fn rebalance_size_delta(
    stock_qty: u64,
    current_delta: i64,
    hedge_ratio_bps: u16,
    tolerance_bps: u16,
) -> Result<i64, ArclisError> {
    let target = target_delta(stock_qty, hedge_ratio_bps)?;
    let drift = i128::from(current_delta)
        .checked_sub(i128::from(target))
        .ok_or(ArclisError::MathOverflow)?;

    let tolerance = mul_div(i128::from(stock_qty), i128::from(tolerance_bps), BPS_SCALE)?;
    if drift.abs() <= tolerance {
        return Ok(0);
    }

    // Move the perp by the negative of the drift: too long, sell more.
    i64::try_from(drift.checked_neg().ok_or(ArclisError::MathOverflow)?)
        .map_err(|_| ArclisError::MathOverflow)
}

/// Value of one agent token, in quote units, at [`QUOTE_SCALE`].
///
/// This is the number that makes an agent's token legible to a buyer: not a
/// market cap pulled off a bonding curve, but the audited quote value of what
/// the treasury actually holds, divided by tokens outstanding.
///
/// A NAV at or below zero returns zero rather than erroring — a treasury can
/// genuinely be wiped out, and a frontend needs to render that rather than
/// fail.
pub fn nav_per_token(nav: i128, tokens_outstanding: u64) -> Result<u64, ArclisError> {
    if tokens_outstanding == 0 || nav <= 0 {
        return Ok(0);
    }
    let per = mul_div(nav, QUOTE_SCALE, i128::from(tokens_outstanding))?;
    u64::try_from(per).map_err(|_| ArclisError::MathOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNIT: u64 = BASE_SCALE as u64;
    const P100: u64 = 100 * PRICE_SCALE as u64;
    const P80: u64 = 80 * PRICE_SCALE as u64;
    const Q: i128 = QUOTE_SCALE;

    #[test]
    fn an_unhedged_treasury_is_fully_long() {
        let e = exposure(10 * UNIT, 0, 0, 0, 0, 0, P100).unwrap();
        assert_eq!(e.stock_value, 1_000 * Q);
        assert_eq!(e.net_delta, 10 * UNIT as i64);
        assert_eq!(e.nav, 1_000 * Q);
    }

    #[test]
    fn a_fully_hedged_treasury_has_no_delta() {
        // 10 shares held, 10 shares short.
        let e = exposure(
            10 * UNIT,
            -10 * UNIT as i64,
            1_000 * Q as u64,
            P100,
            0,
            0,
            P100,
        )
        .unwrap();
        assert_eq!(e.net_delta, 0);
    }

    /// The property the whole product rests on: when the stock falls 20%, an
    /// unhedged treasury loses 20% and a hedged one does not move.
    #[test]
    fn hedging_holds_nav_flat_through_a_drawdown() {
        let stock = 10 * UNIT;
        let margin = 1_000 * Q as u64;

        let unhedged_before = exposure(stock, 0, 0, 0, 0, 0, P100).unwrap().nav;
        let unhedged_after = exposure(stock, 0, 0, 0, 0, 0, P80).unwrap().nav;
        assert_eq!(unhedged_before, 1_000 * Q);
        assert_eq!(unhedged_after, 800 * Q); // -20%

        let short = -10 * UNIT as i64;
        let hedged_before = exposure(stock, short, margin, P100, 0, 0, P100)
            .unwrap()
            .nav;
        let hedged_after = exposure(stock, short, margin, P100, 0, 0, P80).unwrap().nav;

        // Stock lost $200, the short made $200.
        assert_eq!(hedged_before, 2_000 * Q);
        assert_eq!(hedged_after, 2_000 * Q);
    }

    #[test]
    fn a_hedged_treasury_also_gives_up_the_upside() {
        // Stated explicitly because it is the trade, not a bug: neutral means
        // neutral in both directions.
        let stock = 10 * UNIT;
        let margin = 1_000 * Q as u64;
        let up = 120 * PRICE_SCALE as u64;
        let nav = exposure(stock, -10 * UNIT as i64, margin, P100, 0, 0, up)
            .unwrap()
            .nav;
        assert_eq!(nav, 2_000 * Q);
    }

    #[test]
    fn target_delta_spans_neutral_to_unhedged() {
        assert_eq!(target_delta(10 * UNIT, 10_000).unwrap(), 0);
        assert_eq!(target_delta(10 * UNIT, 0).unwrap(), 10 * UNIT as i64);
        assert_eq!(target_delta(10 * UNIT, 5_000).unwrap(), 5 * UNIT as i64);
    }

    #[test]
    fn rebalance_sells_when_the_treasury_is_too_long() {
        // Holding 10, no hedge yet, want neutral: short 10.
        let d = rebalance_size_delta(10 * UNIT, 10 * UNIT as i64, 10_000, 100).unwrap();
        assert_eq!(d, -10 * UNIT as i64);
    }

    #[test]
    fn rebalance_buys_back_when_over_hedged() {
        // Short 12 against 10 held: 2 too short, buy 2 back.
        let d = rebalance_size_delta(10 * UNIT, -2 * UNIT as i64, 10_000, 100).unwrap();
        assert_eq!(d, 2 * UNIT as i64);
    }

    /// The tolerance band is what makes a permissionless crank safe: without
    /// it, anyone could rebalance a dust amount every slot and bleed the
    /// treasury through taker fees.
    ///
    /// The band is a fraction of the *holding*, not of one base unit: against
    /// 10 shares held, a 100 bps tolerance is 0.1 shares.
    #[test]
    fn small_drift_inside_the_band_does_nothing() {
        let held = 10 * UNIT;
        let band = held / 100; // 100 bps of the holding
        let drift = (band / 2) as i64; // half a band
        assert_eq!(rebalance_size_delta(held, drift, 10_000, 100).unwrap(), 0);
    }

    #[test]
    fn drift_exactly_at_the_band_still_does_nothing() {
        let held = 10 * UNIT;
        let band = (held / 100) as i64;
        assert_eq!(rebalance_size_delta(held, band, 10_000, 100).unwrap(), 0);
    }

    #[test]
    fn drift_past_the_band_triggers_a_full_correction() {
        let held = 10 * UNIT;
        let drift = (held / 100) as i64 + 1; // one unit past the band
                                             // Correction is the whole drift, not just the excess over the band:
                                             // once it fires, it returns all the way to target rather than to the
                                             // edge, so the next tick does not immediately re-trigger.
        assert_eq!(
            rebalance_size_delta(held, drift, 10_000, 100).unwrap(),
            -drift
        );
    }

    #[test]
    fn a_zero_tolerance_rebalances_on_any_drift() {
        assert_eq!(rebalance_size_delta(10 * UNIT, 1, 10_000, 0).unwrap(), -1);
    }

    #[test]
    fn a_partial_hedge_rebalances_to_its_own_target() {
        // 50% hedged against 10 held: target delta is 5, currently 10.
        let d = rebalance_size_delta(10 * UNIT, 10 * UNIT as i64, 5_000, 100).unwrap();
        assert_eq!(d, -5 * UNIT as i64);
    }

    #[test]
    fn rebalancing_is_idempotent_at_target() {
        let d = rebalance_size_delta(10 * UNIT, 0, 10_000, 0).unwrap();
        assert_eq!(d, 0);
    }

    #[test]
    fn nav_per_token_divides_the_treasury() {
        // $2,000 across 1,000 tokens == $2.00 each.
        assert_eq!(
            nav_per_token(2_000 * Q, 1_000 * QUOTE_SCALE as u64).unwrap(),
            2 * Q as u64
        );
    }

    #[test]
    fn nav_per_token_handles_a_wiped_out_treasury() {
        assert_eq!(nav_per_token(-5 * Q, 1_000).unwrap(), 0);
        assert_eq!(nav_per_token(1_000 * Q, 0).unwrap(), 0);
    }

    /// Funding is the reason a hedge can be better than free. While the book is
    /// skewed long, the treasury's short is on the receiving side.
    #[test]
    fn a_short_receives_funding_while_longs_pay() {
        let stock = 10 * UNIT;
        let short = -10 * UNIT as i64;
        let margin = 1_000 * Q as u64;
        // Market index has advanced: longs owe, shorts receive.
        let idx = 500_000_000i128;
        let flat = exposure(stock, short, margin, P100, 0, 0, P100)
            .unwrap()
            .nav;
        let funded = exposure(stock, short, margin, P100, 0, idx, P100)
            .unwrap()
            .nav;
        assert!(
            funded > flat,
            "short should have accrued funding: {funded} vs {flat}"
        );
    }
}
