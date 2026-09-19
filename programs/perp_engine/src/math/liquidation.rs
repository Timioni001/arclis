//! The liquidation waterfall.
//!
//! The original engine paid the liquidator 5% of whatever equity was left and
//! floored a negative balance at zero, which meant a position that blew through
//! its margin silently handed its shortfall to the other traders in the vault
//! and nobody could see it had happened. This module makes the whole split
//! explicit and total: every quote unit is either returned to the trader, paid
//! to the liquidator, credited to insurance, or recorded as bad debt.

use crate::constants::*;
use crate::errors::PerpError;
use crate::math::fixed::mul_div;
use crate::math::pnl::margin_ratio_bps;

/// How a liquidation settles. The four fields partition the position's value;
/// [`LiquidationOutcome::assert_balanced`] is the invariant that says so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiquidationOutcome {
    /// Paid out of the vault to whoever sent the transaction.
    pub liquidator_reward: u64,
    /// Credited to the market's insurance accounting (stays in the vault).
    pub insurance_cut: u64,
    /// Left in the trader's collateral balance after the penalty.
    pub trader_remainder: u64,
    /// Shortfall the vault could not cover from this position's own equity.
    /// Drawn from insurance first; whatever insurance cannot cover is
    /// socialised and recorded on the market so it is visible rather than
    /// silently absorbed.
    pub bad_debt: u64,
}

impl LiquidationOutcome {
    /// Every unit of positive equity is accounted for exactly once.
    ///
    /// Stated as a method rather than a comment so the tests can assert it on
    /// randomised inputs instead of trusting the derivation.
    pub fn assert_balanced(&self, equity: i128) -> bool {
        if equity <= 0 {
            return self.liquidator_reward == 0
                && self.insurance_cut == 0
                && self.trader_remainder == 0
                && i128::from(self.bad_debt) == -equity;
        }
        self.bad_debt == 0
            && i128::from(self.liquidator_reward)
                + i128::from(self.insurance_cut)
                + i128::from(self.trader_remainder)
                == equity
    }
}

/// Is this position liquidatable at the given equity and notional?
///
/// Strictly below maintenance margin. A position exactly at the threshold is
/// healthy: liquidating on equality would make the boundary depend on rounding.
pub fn is_liquidatable(
    equity: i128,
    notional: i128,
    maintenance_margin_bps: u16,
) -> Result<bool, PerpError> {
    if notional == 0 {
        return Ok(false);
    }
    let ratio = margin_ratio_bps(equity, notional)?;
    Ok(ratio < i128::from(maintenance_margin_bps))
}

/// Split a liquidated position's value.
///
/// The penalty is a fraction of *notional*, not of equity, so the incentive to
/// liquidate does not evaporate exactly when the position is closest to bad
/// debt and most urgently needs closing. It is then capped at the equity
/// actually available, because the vault cannot pay out value that is not there.
pub fn settle(
    equity: i128,
    notional: i128,
    penalty_bps: u16,
) -> Result<LiquidationOutcome, PerpError> {
    // Underwater: nothing to split. The whole deficit is bad debt, and the
    // liquidator is paid from insurance by the caller, not from this position.
    if equity <= 0 {
        let deficit = equity.checked_neg().ok_or(PerpError::MathOverflow)?;
        return Ok(LiquidationOutcome {
            liquidator_reward: 0,
            insurance_cut: 0,
            trader_remainder: 0,
            bad_debt: u64::try_from(deficit).map_err(|_| PerpError::MathOverflow)?,
        });
    }

    let penalty = mul_div(notional, i128::from(penalty_bps), BPS_SCALE)?.min(equity);

    let liquidator_reward = mul_div(penalty, LIQUIDATOR_PENALTY_SHARE_BPS, BPS_SCALE)?;
    // Take the remainder rather than a second mul_div, so the two shares always
    // sum back to exactly `penalty` regardless of rounding.
    let insurance_cut = penalty
        .checked_sub(liquidator_reward)
        .ok_or(PerpError::MathOverflow)?;
    let trader_remainder = equity.checked_sub(penalty).ok_or(PerpError::MathOverflow)?;

    Ok(LiquidationOutcome {
        liquidator_reward: u64::try_from(liquidator_reward).map_err(|_| PerpError::MathOverflow)?,
        insurance_cut: u64::try_from(insurance_cut).map_err(|_| PerpError::MathOverflow)?,
        trader_remainder: u64::try_from(trader_remainder).map_err(|_| PerpError::MathOverflow)?,
        bad_debt: 0,
    })
}

/// Draw a shortfall against the insurance balance.
///
/// Returns `(drawn_from_insurance, socialised_remainder)`. The remainder is the
/// part insurance could not cover; it is recorded on the market as realised bad
/// debt so that vault liabilities and vault balance can be reconciled off-chain
/// instead of quietly diverging.
pub fn draw_from_insurance(shortfall: u64, insurance_balance: u64) -> (u64, u64) {
    let drawn = shortfall.min(insurance_balance);
    (drawn, shortfall - drawn)
}

#[cfg(test)]
mod tests {
    use super::*;

    const Q: i128 = QUOTE_SCALE;

    #[test]
    fn healthy_position_is_not_liquidatable() {
        // 10% margin against a 5% maintenance requirement.
        assert!(!is_liquidatable(10 * Q, 100 * Q, 500).unwrap());
    }

    #[test]
    fn position_below_maintenance_is_liquidatable() {
        assert!(is_liquidatable(4 * Q, 100 * Q, 500).unwrap());
    }

    #[test]
    fn exactly_at_maintenance_is_healthy() {
        assert!(!is_liquidatable(5 * Q, 100 * Q, 500).unwrap());
    }

    #[test]
    fn underwater_position_is_liquidatable() {
        assert!(is_liquidatable(-1 * Q, 100 * Q, 500).unwrap());
    }

    #[test]
    fn flat_position_is_never_liquidatable() {
        assert!(!is_liquidatable(0, 0, 500).unwrap());
    }

    #[test]
    fn penalty_splits_evenly_between_liquidator_and_insurance() {
        // 5% penalty on $100 notional == $5, split 50/50.
        let o = settle(10 * Q, 100 * Q, 500).unwrap();
        assert_eq!(o.liquidator_reward, 2_500_000); // $2.50
        assert_eq!(o.insurance_cut, 2_500_000); // $2.50
        assert_eq!(o.trader_remainder, 5_000_000); // $5.00
        assert_eq!(o.bad_debt, 0);
        assert!(o.assert_balanced(10 * Q));
    }

    #[test]
    fn penalty_is_capped_at_available_equity() {
        // Penalty would be $5 but only $2 of equity survives.
        let o = settle(2 * Q, 100 * Q, 500).unwrap();
        assert_eq!(o.trader_remainder, 0);
        assert_eq!(o.liquidator_reward + o.insurance_cut, 2_000_000);
        assert!(o.assert_balanced(2 * Q));
    }

    #[test]
    fn underwater_produces_bad_debt_and_pays_nobody_from_the_position() {
        let o = settle(-3 * Q, 100 * Q, 500).unwrap();
        assert_eq!(o.bad_debt, 3_000_000);
        assert_eq!(o.liquidator_reward, 0);
        assert_eq!(o.insurance_cut, 0);
        assert_eq!(o.trader_remainder, 0);
        assert!(o.assert_balanced(-3 * Q));
    }

    #[test]
    fn zero_equity_is_a_clean_wipeout_not_bad_debt() {
        let o = settle(0, 100 * Q, 500).unwrap();
        assert_eq!(o.bad_debt, 0);
        assert_eq!(o.trader_remainder, 0);
        assert!(o.assert_balanced(0));
    }

    /// The partition invariant, over a wide sweep rather than a few points.
    #[test]
    fn value_is_conserved_across_the_parameter_space() {
        for equity_q in [-50i128, -1, 0, 1, 3, 7, 25, 99, 1_000] {
            for notional_q in [1i128, 10, 100, 5_000] {
                for penalty_bps in [0u16, 1, 250, 500, 1_000] {
                    let equity = equity_q * Q;
                    let o = settle(equity, notional_q * Q, penalty_bps).unwrap();
                    assert!(
                        o.assert_balanced(equity),
                        "unbalanced at equity={equity_q} notional={notional_q} penalty={penalty_bps}: {o:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn insurance_covers_what_it_can_and_the_rest_is_socialised() {
        assert_eq!(draw_from_insurance(100, 1_000), (100, 0));
        assert_eq!(draw_from_insurance(1_000, 100), (100, 900));
        assert_eq!(draw_from_insurance(100, 0), (0, 100));
        assert_eq!(draw_from_insurance(0, 500), (0, 0));
    }
}
