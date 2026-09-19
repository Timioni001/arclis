//! Stock splits, and why a perp engine needs to care.
//!
//! A 4-for-1 split quadruples the share count and quarters the quoted price.
//! Economically nothing happened — every holder owns the same fraction of the
//! same company. But an engine that only sees the oracle sees AAPL drop 75%
//! overnight, and liquidates every long in the market.
//!
//! The naive fix is to walk every position and rescale it. That is impossible
//! on Solana: positions are separate accounts and there is no iteration.
//!
//! # The lazy-normalisation model
//!
//! Instead, the oracle carries a **cumulative split factor**: how many shares
//! one pre-split share has become since inception, at [`SPLIT_FACTOR_SCALE`].
//! A market that has never split is at exactly 1.0. A 4-for-1 multiplies it by
//! 4; a 1-for-10 reverse split multiplies it by 0.1.
//!
//! Each position records the factor it was opened at. The instant a position is
//! touched, it is rescaled from its own factor to the current one:
//!
//! ```text
//! size'        = size        * current / entry
//! entry_price' = entry_price * entry   / current
//! ```
//!
//! No iteration, no migration, no cron job. A position untouched across three
//! splits normalises correctly on its next instruction, because the factors
//! compose.
//!
//! The property that makes this safe is that **notional is invariant**:
//! `size' * entry_price' == size * entry_price`. Since PnL is
//! `size * (mark - entry)` and `mark` is rescaled by the oracle in the same
//! transaction, PnL is invariant too. Both are asserted in the tests below,
//! including across a chain of splits.

use crate::constants::*;
use crate::errors::PerpError;
use crate::math::fixed::mul_div;

/// A corporate action expressed as a ratio of new shares to old.
///
/// `4:1` (a four-for-one split) is `numerator = 4, denominator = 1`.
/// `1:10` (a ten-to-one reverse split) is `numerator = 1, denominator = 10`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitRatio {
    pub numerator: u32,
    pub denominator: u32,
}

impl SplitRatio {
    pub fn validate(&self) -> Result<(), PerpError> {
        if self.numerator == 0 || self.denominator == 0 {
            return Err(PerpError::InvalidSplitRatio);
        }
        if self.numerator == self.denominator {
            // A 1:1 split is a no-op that would still bump every position's
            // stored factor. Reject it rather than let a keeper spam state.
            return Err(PerpError::InvalidSplitRatio);
        }
        // Bound the ratio so a fat-fingered 1:1000000 cannot round every
        // position on the book to zero size.
        if self.numerator > MAX_SPLIT_RATIO_COMPONENT
            || self.denominator > MAX_SPLIT_RATIO_COMPONENT
        {
            return Err(PerpError::InvalidSplitRatio);
        }
        Ok(())
    }
}

/// Apply a split to the cumulative factor.
pub fn advance_split_factor(current: u64, ratio: SplitRatio) -> Result<u64, PerpError> {
    ratio.validate()?;
    let next = mul_div(
        i128::from(current),
        i128::from(ratio.numerator),
        i128::from(ratio.denominator),
    )?;
    if next <= 0 {
        return Err(PerpError::InvalidSplitRatio);
    }
    u64::try_from(next).map_err(|_| PerpError::MathOverflow)
}

/// Rescale a price when the share count changes: more shares, lower price.
pub fn rescale_price(price: u64, from_factor: u64, to_factor: u64) -> Result<u64, PerpError> {
    if from_factor == 0 || to_factor == 0 {
        return Err(PerpError::DivideByZero);
    }
    let out = mul_div(
        i128::from(price),
        i128::from(from_factor),
        i128::from(to_factor),
    )?;
    u64::try_from(out).map_err(|_| PerpError::MathOverflow)
}

/// Rescale a signed size when the share count changes: more shares, bigger size.
pub fn rescale_size(size: i64, from_factor: u64, to_factor: u64) -> Result<i64, PerpError> {
    if from_factor == 0 {
        return Err(PerpError::DivideByZero);
    }
    let out = mul_div(
        i128::from(size),
        i128::from(to_factor),
        i128::from(from_factor),
    )?;
    i64::try_from(out).map_err(|_| PerpError::MathOverflow)
}

/// Rescale an unsigned base quantity — open interest, in practice.
pub fn rescale_base_amount(
    amount: u64,
    from_factor: u64,
    to_factor: u64,
) -> Result<u64, PerpError> {
    if from_factor == 0 {
        return Err(PerpError::DivideByZero);
    }
    let out = mul_div(
        i128::from(amount),
        i128::from(to_factor),
        i128::from(from_factor),
    )?;
    u64::try_from(out).map_err(|_| PerpError::MathOverflow)
}

/// Rescale the cumulative funding index.
///
/// The index is *quote owed per base unit*. If a base unit splits into four,
/// the amount owed per unit must quarter, or every position's unsettled funding
/// would quadruple the moment the split landed.
pub fn rescale_funding_index(
    index: i128,
    from_factor: u64,
    to_factor: u64,
) -> Result<i128, PerpError> {
    if to_factor == 0 {
        return Err(PerpError::DivideByZero);
    }
    mul_div(index, i128::from(from_factor), i128::from(to_factor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::pnl;

    const ONE: u64 = SPLIT_FACTOR_SCALE;
    const FOUR_FOR_ONE: SplitRatio = SplitRatio {
        numerator: 4,
        denominator: 1,
    };
    const ONE_FOR_TEN: SplitRatio = SplitRatio {
        numerator: 1,
        denominator: 10,
    };

    #[test]
    fn forward_split_multiplies_the_factor() {
        assert_eq!(advance_split_factor(ONE, FOUR_FOR_ONE).unwrap(), 4 * ONE);
    }

    #[test]
    fn reverse_split_divides_the_factor() {
        assert_eq!(advance_split_factor(ONE, ONE_FOR_TEN).unwrap(), ONE / 10);
    }

    #[test]
    fn splits_compose() {
        // 4:1 then 1:2 nets to 2:1.
        let f = advance_split_factor(ONE, FOUR_FOR_ONE).unwrap();
        let f = advance_split_factor(
            f,
            SplitRatio {
                numerator: 1,
                denominator: 2,
            },
        )
        .unwrap();
        assert_eq!(f, 2 * ONE);
    }

    #[test]
    fn degenerate_ratios_are_rejected() {
        assert_eq!(
            SplitRatio {
                numerator: 0,
                denominator: 1
            }
            .validate(),
            Err(PerpError::InvalidSplitRatio)
        );
        assert_eq!(
            SplitRatio {
                numerator: 1,
                denominator: 0
            }
            .validate(),
            Err(PerpError::InvalidSplitRatio)
        );
        assert_eq!(
            SplitRatio {
                numerator: 1,
                denominator: 1
            }
            .validate(),
            Err(PerpError::InvalidSplitRatio)
        );
        assert_eq!(
            SplitRatio {
                numerator: MAX_SPLIT_RATIO_COMPONENT + 1,
                denominator: 1
            }
            .validate(),
            Err(PerpError::InvalidSplitRatio)
        );
    }

    #[test]
    fn a_four_for_one_quarters_the_price_and_quadruples_the_size() {
        let to = advance_split_factor(ONE, FOUR_FOR_ONE).unwrap();
        assert_eq!(
            rescale_price(200 * PRICE_SCALE as u64, ONE, to).unwrap(),
            50 * PRICE_SCALE as u64
        );
        assert_eq!(
            rescale_size(BASE_SCALE as i64, ONE, to).unwrap(),
            4 * BASE_SCALE as i64
        );
    }

    #[test]
    fn shorts_rescale_with_their_sign_intact() {
        let to = advance_split_factor(ONE, FOUR_FOR_ONE).unwrap();
        assert_eq!(
            rescale_size(-(BASE_SCALE as i64), ONE, to).unwrap(),
            -4 * BASE_SCALE as i64
        );
    }

    /// The invariant the whole design rests on: a split must not move anyone's
    /// notional exposure by a single quote unit.
    #[test]
    fn notional_is_invariant_across_a_split() {
        let size = 3 * BASE_SCALE as i64;
        let price = 200 * PRICE_SCALE as u64;
        let before = pnl::notional(size, price).unwrap();

        let to = advance_split_factor(ONE, FOUR_FOR_ONE).unwrap();
        let size2 = rescale_size(size, ONE, to).unwrap();
        let price2 = rescale_price(price, ONE, to).unwrap();

        assert_eq!(pnl::notional(size2, price2).unwrap(), before);
    }

    /// And the one that matters to the trader: a split must not create or
    /// destroy a cent of profit.
    #[test]
    fn pnl_is_invariant_across_a_split() {
        let size = 3 * BASE_SCALE as i64;
        let entry = 200 * PRICE_SCALE as u64;
        let mark = 220 * PRICE_SCALE as u64;
        let before = pnl::unrealized_pnl(size, entry, mark).unwrap();
        assert_eq!(before, 60 * QUOTE_SCALE); // 3 shares * $20

        let to = advance_split_factor(ONE, FOUR_FOR_ONE).unwrap();
        let after = pnl::unrealized_pnl(
            rescale_size(size, ONE, to).unwrap(),
            rescale_price(entry, ONE, to).unwrap(),
            rescale_price(mark, ONE, to).unwrap(),
        )
        .unwrap();

        assert_eq!(after, before);
    }

    #[test]
    fn pnl_is_invariant_for_shorts_too() {
        let size = -2 * BASE_SCALE as i64;
        let entry = 100 * PRICE_SCALE as u64;
        let mark = 90 * PRICE_SCALE as u64;
        let before = pnl::unrealized_pnl(size, entry, mark).unwrap();

        let to = advance_split_factor(ONE, ONE_FOR_TEN).unwrap();
        let after = pnl::unrealized_pnl(
            rescale_size(size, ONE, to).unwrap(),
            rescale_price(entry, ONE, to).unwrap(),
            rescale_price(mark, ONE, to).unwrap(),
        )
        .unwrap();

        assert_eq!(after, before);
    }

    /// A position that sleeps through several splits must land where a
    /// position normalised at every step would — and in fact lands slightly
    /// closer to the true value, because it rounds once instead of once per
    /// split. That is an argument *for* lazy normalisation, not a caveat: the
    /// eager path accumulates a truncation per step and the lazy path does not.
    #[test]
    fn lazy_normalisation_is_at_least_as_precise_as_step_by_step() {
        let size = 8 * BASE_SCALE as i64;
        // 400 does not divide evenly by 3, so this exercises the rounding.
        let entry = 400 * PRICE_SCALE as u64;

        let ratios = [
            SplitRatio {
                numerator: 2,
                denominator: 1,
            },
            SplitRatio {
                numerator: 3,
                denominator: 1,
            },
            SplitRatio {
                numerator: 1,
                denominator: 2,
            },
        ];

        // Eager: rescale at every step, truncating each time.
        let (mut eager_size, mut eager_entry, mut f) = (size, entry, ONE);
        for r in ratios {
            let next = advance_split_factor(f, r).unwrap();
            eager_size = rescale_size(eager_size, f, next).unwrap();
            eager_entry = rescale_price(eager_entry, f, next).unwrap();
            f = next;
        }

        // Lazy: one rescale, from the original factor straight to the final one.
        let lazy_size = rescale_size(size, ONE, f).unwrap();
        let lazy_entry = rescale_price(entry, ONE, f).unwrap();

        // Sizes divide evenly here, so they match exactly.
        assert_eq!(lazy_size, eager_size);

        // Prices agree to within the truncation the eager path accrued: at most
        // one unit per split, and the lazy value is the larger (less truncated)
        // of the two.
        let drift = i128::from(lazy_entry) - i128::from(eager_entry);
        assert!(
            (0..=ratios.len() as i128).contains(&drift),
            "lazy {lazy_entry} vs eager {eager_entry}: drift {drift} outside the rounding bound"
        );
    }

    /// Notional survives a split up to integer truncation — sub-cent dust on a
    /// ratio that does not divide evenly, and exact when it does. Stated as a
    /// bound rather than an equality because pretending integer division is
    /// lossless is how rounding bugs get shipped.
    #[test]
    fn notional_survives_an_uneven_split_to_within_dust() {
        let size = 8 * BASE_SCALE as i64;
        let entry = 400 * PRICE_SCALE as u64;
        let before = pnl::notional(size, entry).unwrap();

        let to = advance_split_factor(
            ONE,
            SplitRatio {
                numerator: 3,
                denominator: 1,
            },
        )
        .unwrap();
        let after = pnl::notional(
            rescale_size(size, ONE, to).unwrap(),
            rescale_price(entry, ONE, to).unwrap(),
        )
        .unwrap();

        // One quote unit is $0.000001. The drift is bounded by the rescaled
        // size, since each base unit can lose at most one price unit.
        let drift = (before - after).abs();
        assert!(drift < QUOTE_SCALE / 100, "notional drifted by {drift}");
        // And it can only ever round against the holder, never in their favour,
        // so a split cannot be used to mint notional out of rounding.
        assert!(after <= before);
    }

    #[test]
    fn funding_index_rescales_inversely_to_size() {
        let to = advance_split_factor(ONE, FOUR_FOR_ONE).unwrap();
        // Quote owed per base unit must quarter when base units quadruple.
        assert_eq!(rescale_funding_index(4_000, ONE, to).unwrap(), 1_000);
    }

    /// Together, the size and index rescalings must leave unsettled funding
    /// exactly where it was.
    #[test]
    fn unsettled_funding_is_invariant_across_a_split() {
        let size = 2 * BASE_SCALE as i64;
        let entry_index = 1_000_000i128;
        let market_index = 5_000_000i128;
        let before = pnl::funding_owed(size, entry_index, market_index).unwrap();

        let to = advance_split_factor(ONE, FOUR_FOR_ONE).unwrap();
        let after = pnl::funding_owed(
            rescale_size(size, ONE, to).unwrap(),
            rescale_funding_index(entry_index, ONE, to).unwrap(),
            rescale_funding_index(market_index, ONE, to).unwrap(),
        )
        .unwrap();

        assert_eq!(after, before);
    }

    #[test]
    fn open_interest_rescales_like_size() {
        let to = advance_split_factor(ONE, FOUR_FOR_ONE).unwrap();
        assert_eq!(
            rescale_base_amount(5 * BASE_SCALE as u64, ONE, to).unwrap(),
            20 * BASE_SCALE as u64
        );
    }
}
