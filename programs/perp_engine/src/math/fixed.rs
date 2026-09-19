//! Checked fixed-point primitives.
//!
//! Everything in [`crate::math`] is built out of these three helpers so that
//! overflow handling lives in one place instead of being re-derived at every
//! call site. They are deliberately free of Anchor types: the whole module tree
//! compiles and unit-tests on the host with plain `cargo test`.

use crate::errors::PerpError;

/// `a * b / denom`, computed at full `i128` width, with the multiply checked
/// before the divide so intermediate products cannot silently wrap.
///
/// Truncates toward zero, which is Rust's native integer division. Callers that
/// need a specific rounding direction for solvency reasons should use
/// [`mul_div_floor`] instead and say why.
#[inline]
pub fn mul_div(a: i128, b: i128, denom: i128) -> Result<i128, PerpError> {
    if denom == 0 {
        return Err(PerpError::DivideByZero);
    }
    a.checked_mul(b)
        .ok_or(PerpError::MathOverflow)?
        .checked_div(denom)
        .ok_or(PerpError::MathOverflow)
}

/// `a * b / denom`, rounding toward negative infinity.
///
/// Used where truncation would round in the user's favour and against the
/// vault: fees, funding charges, and any other debit. Rounding a debit down
/// toward zero is a systematic leak; rounding it toward -inf is not.
#[inline]
pub fn mul_div_floor(a: i128, b: i128, denom: i128) -> Result<i128, PerpError> {
    if denom == 0 {
        return Err(PerpError::DivideByZero);
    }
    let num = a.checked_mul(b).ok_or(PerpError::MathOverflow)?;
    let q = num.checked_div(denom).ok_or(PerpError::MathOverflow)?;
    let r = num.checked_rem(denom).ok_or(PerpError::MathOverflow)?;
    // Rust truncates toward zero; correct by one when the true quotient is
    // negative and the division was not exact.
    if r != 0 && ((r < 0) != (denom < 0)) {
        q.checked_sub(1).ok_or(PerpError::MathOverflow)
    } else {
        Ok(q)
    }
}

/// Narrow an `i128` to `u64`, refusing negatives and anything that would wrap.
///
/// Every token transfer amount in this program goes through here. The old code
/// used `as u64` casts, which turn a negative balance into ~1.8e19 lamports of
/// phantom credit.
#[inline]
pub fn to_u64(v: i128) -> Result<u64, PerpError> {
    if v < 0 {
        return Err(PerpError::NegativeAmount);
    }
    u64::try_from(v).map_err(|_| PerpError::MathOverflow)
}

/// Narrow an `i128` to `i64`, refusing anything that would wrap.
#[inline]
pub fn to_i64(v: i128) -> Result<i64, PerpError> {
    i64::try_from(v).map_err(|_| PerpError::MathOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_div_is_exact_at_full_width() {
        // Would overflow i64 at the intermediate product.
        let a = 9_000_000_000_000i128;
        let b = 9_000_000_000_000i128;
        assert_eq!(
            mul_div(a, b, 1_000_000).unwrap(),
            81_000_000_000_000_000_000
        );
    }

    #[test]
    fn mul_div_rejects_zero_denominator() {
        assert_eq!(mul_div(1, 1, 0), Err(PerpError::DivideByZero));
    }

    #[test]
    fn mul_div_overflow_is_caught_not_wrapped() {
        assert_eq!(mul_div(i128::MAX, 2, 1), Err(PerpError::MathOverflow));
    }

    #[test]
    fn floor_and_trunc_agree_on_positives() {
        assert_eq!(mul_div(7, 1, 2).unwrap(), 3);
        assert_eq!(mul_div_floor(7, 1, 2).unwrap(), 3);
    }

    #[test]
    fn floor_rounds_debits_away_from_the_user() {
        // Truncation gives -3, which would under-charge by 1.
        assert_eq!(mul_div(-7, 1, 2).unwrap(), -3);
        assert_eq!(mul_div_floor(-7, 1, 2).unwrap(), -4);
    }

    #[test]
    fn floor_is_exact_when_divisible() {
        assert_eq!(mul_div_floor(-8, 1, 2).unwrap(), -4);
    }

    #[test]
    fn to_u64_rejects_negatives_instead_of_wrapping() {
        assert_eq!(to_u64(-1), Err(PerpError::NegativeAmount));
        // The bug this replaces: `-1i128 as u64` == 18446744073709551615.
        assert_eq!(to_u64(0).unwrap(), 0);
        assert_eq!(to_u64(u64::MAX as i128).unwrap(), u64::MAX);
        assert_eq!(to_u64(u64::MAX as i128 + 1), Err(PerpError::MathOverflow));
    }

    #[test]
    fn to_i64_bounds() {
        assert_eq!(to_i64(i64::MIN as i128).unwrap(), i64::MIN);
        assert_eq!(to_i64(i64::MAX as i128 + 1), Err(PerpError::MathOverflow));
    }
}
