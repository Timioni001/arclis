//! The counterparty pool.
//!
//! # What this fixes
//!
//! Arclis is cash-settled against an oracle with no order book and no AMM. Up
//! to this module, that left one unanswered question: when a long closes at a
//! profit, **where does the money come from?**
//!
//! It came from the market vault, which holds other traders' deposits. For that
//! to be solvent, winners' profits had to be exactly funded by losers' losses —
//! which requires long and short open interest to be balanced, continuously, at
//! every price. Nothing made that true. An 80%-long market in a rising tape
//! paid the longs out of the shorts' collateral and then out of everyone else's.
//!
//! The liquidity pool is the explicit answer. LPs deposit quote, and the pool
//! takes the other side of whatever imbalance the traders leave:
//!
//! ```text
//! pool exposure = -(open_interest_long - open_interest_short)
//! ```
//!
//! Traders' realised losses flow into the pool; their realised profits flow out
//! of it. LPs are paid for that in taker fees and funding, and their capital is
//! what stands behind a winning trader.
//!
//! # What LPs are actually buying
//!
//! Worth being blunt, because it should be in the product copy and not a
//! surprise: an LP here is **not** a neutral market maker. The pool is short
//! whatever the traders are long. In an Arclis equity market where agent
//! treasuries hedge their spot holdings — which means they are structurally
//! short the perp — the pool ends up structurally **long the underlying**.
//!
//! An LP position is therefore closer to "synthetic long equity, plus fee and
//! funding income, minus trader alpha" than to a delta-neutral yield product.
//! That is a coherent thing to sell. It is not a stablecoin vault.
//!
//! # Computing the pool's liability without iterating
//!
//! The pool owes traders their aggregate unrealised profit, and there is no way
//! to iterate position accounts on Solana. So [`crate::state::Market`] carries
//! running sums of entry notional per side, maintained as positions open and
//! close, and [`net_trader_pnl`] turns those into the pool's mark-to-market
//! liability in O(1).

use crate::constants::*;
use crate::errors::ArclisError;
use crate::math::fixed::mul_div;

/// Aggregate unrealised PnL across every open position in a market.
///
/// Positive means traders are collectively up, so the pool owes them. This is
/// the pool's mark-to-market liability, and the reason share pricing has to be
/// done against NAV rather than against the vault balance: a depositor who
/// bought in at book value while traders were sitting on a large gain would be
/// buying a loss that had already happened.
///
/// `*_entry_notional` are the running sums of `|size| * entry_price` that
/// `Market` maintains, at [`PRICE_SCALE`].
pub fn net_trader_pnl(
    open_interest_long: u64,
    long_entry_notional: u128,
    open_interest_short: u64,
    short_entry_notional: u128,
    mark_price: u64,
) -> Result<i128, ArclisError> {
    // Longs profit when the mark exceeds what they paid.
    let long_value = mul_div(
        i128::from(open_interest_long),
        i128::from(mark_price),
        PRICE_SCALE,
    )?;
    let long_cost = i128::try_from(long_entry_notional)
        .map_err(|_| ArclisError::MathOverflow)?
        .checked_div(PRICE_SCALE)
        .ok_or(ArclisError::MathOverflow)?;
    let long_pnl = long_value
        .checked_sub(long_cost)
        .ok_or(ArclisError::MathOverflow)?;

    // Shorts profit when it falls below.
    let short_value = mul_div(
        i128::from(open_interest_short),
        i128::from(mark_price),
        PRICE_SCALE,
    )?;
    let short_cost = i128::try_from(short_entry_notional)
        .map_err(|_| ArclisError::MathOverflow)?
        .checked_div(PRICE_SCALE)
        .ok_or(ArclisError::MathOverflow)?;
    let short_pnl = short_cost
        .checked_sub(short_value)
        .ok_or(ArclisError::MathOverflow)?;

    long_pnl
        .checked_add(short_pnl)
        .ok_or(ArclisError::MathOverflow)
}

/// Pool net asset value: what the LP vault holds, less what it owes traders.
///
/// Can go negative when traders are up by more than the pool holds. Callers
/// must not clamp before deciding what to do about it — a negative NAV is
/// exactly the case where deposits and withdrawals have to stop.
pub fn pool_nav(lp_vault_balance: u64, net_trader_pnl: i128) -> Result<i128, ArclisError> {
    i128::from(lp_vault_balance)
        .checked_sub(net_trader_pnl)
        .ok_or(ArclisError::MathOverflow)
}

/// Shares to mint for a deposit.
///
/// The first depositor sets the ratio at 1:1. Everyone after buys in at the
/// current NAV per share, so no deposit dilutes or is diluted by the
/// unrealised position the pool is already carrying.
pub fn shares_for_deposit(amount: u64, total_shares: u64, nav: i128) -> Result<u64, ArclisError> {
    if total_shares == 0 {
        return Ok(amount);
    }
    // A pool that is underwater or wiped out cannot price a share: dividing by
    // a non-positive NAV would mint a negative or infinite number of them.
    if nav <= 0 {
        return Err(ArclisError::PoolNavNonPositive);
    }
    let shares = mul_div(i128::from(amount), i128::from(total_shares), nav)?;
    u64::try_from(shares).map_err(|_| ArclisError::MathOverflow)
}

/// Quote owed for a redemption, at the current NAV per share.
pub fn amount_for_shares(shares: u64, total_shares: u64, nav: i128) -> Result<u64, ArclisError> {
    if total_shares == 0 || shares == 0 {
        return Ok(0);
    }
    if nav <= 0 {
        return Err(ArclisError::PoolNavNonPositive);
    }
    let amount = mul_div(nav, i128::from(shares), i128::from(total_shares))?;
    u64::try_from(amount).map_err(|_| ArclisError::MathOverflow)
}

/// How hard the pool is working, in bps of NAV.
///
/// `10_000` means the pool is backing directional exposure exactly equal to its
/// own capital. Above that it is levered, and a move against it eats principal
/// faster than the mark moves.
///
/// A pool with no NAV reports maximum utilisation rather than dividing by zero,
/// which is the correct answer: any exposure at all is infinite leverage.
pub fn utilization_bps(net_exposure_notional: i128, nav: i128) -> Result<i128, ArclisError> {
    let exposure = net_exposure_notional.abs();
    if exposure == 0 {
        return Ok(0);
    }
    if nav <= 0 {
        return Ok(i128::MAX);
    }
    mul_div(exposure, BPS_SCALE, nav)
}

/// Notional value of the imbalance the pool is carrying.
///
/// The pool is only exposed to the *net* of the two sides. A market with a
/// billion dollars long and a billion short is fully hedged internally and
/// costs the pool nothing.
pub fn net_exposure_notional(
    open_interest_long: u64,
    open_interest_short: u64,
    mark_price: u64,
) -> Result<i128, ArclisError> {
    let net = i128::from(open_interest_long)
        .checked_sub(i128::from(open_interest_short))
        .ok_or(ArclisError::MathOverflow)?;
    mul_div(net, i128::from(mark_price), PRICE_SCALE)
}

/// The most an LP may redeem without pushing utilisation past the cap.
///
/// Withdrawals are what turn a drawdown into a collapse: if LPs can exit freely
/// while the pool is carrying exposure, the first out are paid in full and the
/// last holds everything. Capping redemptions at the capital the open book
/// actually requires means the pool cannot be drained out from under live
/// positions.
///
/// Returns quote units, never more than the NAV itself.
pub fn max_withdrawable(
    nav: i128,
    net_exposure_notional: i128,
    max_utilization_bps: u16,
) -> Result<u64, ArclisError> {
    if nav <= 0 {
        return Ok(0);
    }
    let exposure = net_exposure_notional.abs();
    if exposure == 0 {
        return u64::try_from(nav).map_err(|_| ArclisError::MathOverflow);
    }
    if max_utilization_bps == 0 {
        return Ok(0);
    }

    // Capital the open book requires: exposure / max_utilization.
    let required = mul_div(exposure, BPS_SCALE, i128::from(max_utilization_bps))?;
    let free = nav.checked_sub(required).ok_or(ArclisError::MathOverflow)?;
    if free <= 0 {
        return Ok(0);
    }
    u64::try_from(free).map_err(|_| ArclisError::MathOverflow)
}

/// Split a shortfall across the loss waterfall.
///
/// Order: insurance first, then LP capital, then socialised. LPs sit *behind*
/// the insurance fund and *in front of* other traders, which is what they are
/// being paid for — and it is why the pool is a genuine second loss absorber
/// rather than a yield wrapper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShortfallSplit {
    pub from_insurance: u64,
    pub from_pool: u64,
    pub socialized: u64,
}

impl ShortfallSplit {
    /// Every unit of the shortfall is assigned to exactly one bucket.
    pub fn is_complete(&self, shortfall: u64) -> bool {
        u128::from(self.from_insurance) + u128::from(self.from_pool) + u128::from(self.socialized)
            == u128::from(shortfall)
    }
}

pub fn absorb_shortfall(shortfall: u64, insurance_balance: u64, pool_nav: i128) -> ShortfallSplit {
    let from_insurance = shortfall.min(insurance_balance);
    let mut remaining = shortfall - from_insurance;

    let pool_capacity = if pool_nav > 0 {
        u64::try_from(pool_nav).unwrap_or(u64::MAX)
    } else {
        0
    };
    let from_pool = remaining.min(pool_capacity);
    remaining -= from_pool;

    ShortfallSplit {
        from_insurance,
        from_pool,
        socialized: remaining,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const Q: i128 = QUOTE_SCALE;
    const UNIT: u64 = BASE_SCALE as u64;
    const P100: u64 = 100 * PRICE_SCALE as u64;
    const P110: u64 = 110 * PRICE_SCALE as u64;
    const P90: u64 = 90 * PRICE_SCALE as u64;

    /// 10 units long, opened at $100: entry notional is 10 * 100 at PRICE_SCALE.
    fn long_10_at_100() -> (u64, u128) {
        (10 * UNIT, 10u128 * UNIT as u128 * P100 as u128)
    }

    #[test]
    fn a_balanced_book_costs_the_pool_nothing() {
        let (oi, notional) = long_10_at_100();
        // Same size both sides at the same entry: the pool is flat whatever
        // the price does.
        for price in [P90, P100, P110] {
            assert_eq!(
                net_trader_pnl(oi, notional, oi, notional, price).unwrap(),
                0
            );
            assert_eq!(net_exposure_notional(oi, oi, price).unwrap(), 0);
        }
    }

    #[test]
    fn the_pool_owes_longs_when_price_rises() {
        let (oi, notional) = long_10_at_100();
        // 10 units up $10 == $100 owed.
        assert_eq!(net_trader_pnl(oi, notional, 0, 0, P110).unwrap(), 100 * Q);
    }

    #[test]
    fn the_pool_gains_when_longs_are_wrong() {
        let (oi, notional) = long_10_at_100();
        assert_eq!(net_trader_pnl(oi, notional, 0, 0, P90).unwrap(), -100 * Q);
    }

    #[test]
    fn the_pool_owes_shorts_when_price_falls() {
        let (oi, notional) = long_10_at_100();
        assert_eq!(net_trader_pnl(0, 0, oi, notional, P90).unwrap(), 100 * Q);
    }

    #[test]
    fn nav_subtracts_what_the_pool_owes() {
        // $10,000 of LP capital against $100 owed to traders.
        assert_eq!(pool_nav(10_000 * Q as u64, 100 * Q).unwrap(), 9_900 * Q);
    }

    #[test]
    fn nav_can_go_negative_and_is_not_clamped() {
        assert_eq!(pool_nav(100 * Q as u64, 500 * Q).unwrap(), -400 * Q);
    }

    #[test]
    fn the_first_depositor_sets_the_ratio() {
        assert_eq!(
            shares_for_deposit(1_000 * Q as u64, 0, 0).unwrap(),
            1_000 * Q as u64
        );
    }

    /// Share pricing is the defence against a depositor buying in at book value
    /// while the pool is already carrying a loss it has not realised.
    #[test]
    fn later_depositors_buy_in_at_nav_not_book() {
        // Pool holds $10,000 but owes traders $5,000, so NAV is $5,000 against
        // 10,000 shares - half a dollar a share. A $1,000 deposit must buy
        // 2,000 shares, not 1,000.
        let shares = shares_for_deposit(1_000 * Q as u64, 10_000 * Q as u64, 5_000 * Q).unwrap();
        assert_eq!(shares, 2_000 * Q as u64);
    }

    #[test]
    fn deposit_and_redeem_round_trip_at_a_flat_nav() {
        let nav = 5_000 * Q;
        let total = 5_000 * Q as u64;
        let shares = shares_for_deposit(1_000 * Q as u64, total, nav).unwrap();
        // Redeeming straight back out of the enlarged pool returns the deposit.
        let back = amount_for_shares(shares, total + shares, nav + 1_000 * Q).unwrap();
        assert_eq!(back, 1_000 * Q as u64);
    }

    #[test]
    fn an_underwater_pool_refuses_to_price_shares() {
        assert_eq!(
            shares_for_deposit(1_000, 1_000, -1),
            Err(ArclisError::PoolNavNonPositive)
        );
        assert_eq!(
            amount_for_shares(1_000, 1_000, 0),
            Err(ArclisError::PoolNavNonPositive)
        );
    }

    #[test]
    fn utilization_is_exposure_over_capital() {
        // $5,000 of exposure against $10,000 of NAV == 50%.
        assert_eq!(utilization_bps(5_000 * Q, 10_000 * Q).unwrap(), 5_000);
        assert_eq!(utilization_bps(10_000 * Q, 10_000 * Q).unwrap(), 10_000);
        // Direction does not matter; the pool is exposed either way.
        assert_eq!(utilization_bps(-5_000 * Q, 10_000 * Q).unwrap(), 5_000);
    }

    #[test]
    fn an_idle_pool_is_at_zero_utilization() {
        assert_eq!(utilization_bps(0, 10_000 * Q).unwrap(), 0);
        // Even with no capital, no exposure is no utilisation.
        assert_eq!(utilization_bps(0, 0).unwrap(), 0);
    }

    #[test]
    fn exposure_with_no_capital_is_infinite_utilization() {
        assert_eq!(utilization_bps(1, 0).unwrap(), i128::MAX);
        assert_eq!(utilization_bps(1, -5).unwrap(), i128::MAX);
    }

    #[test]
    fn an_unused_pool_is_fully_withdrawable() {
        assert_eq!(
            max_withdrawable(10_000 * Q, 0, 8_000).unwrap(),
            10_000 * Q as u64
        );
    }

    /// The rule that stops a bank run: LPs can only take out what the open book
    /// does not need.
    #[test]
    fn withdrawals_are_capped_by_what_the_open_book_requires() {
        // $4,000 of exposure at an 80% cap requires $5,000 of capital.
        // From $10,000 of NAV, $5,000 is free.
        assert_eq!(
            max_withdrawable(10_000 * Q, 4_000 * Q, 8_000).unwrap(),
            5_000 * Q as u64
        );
    }

    #[test]
    fn a_fully_utilized_pool_allows_no_withdrawal() {
        // $8,000 exposure at an 80% cap needs the whole $10,000.
        assert_eq!(max_withdrawable(10_000 * Q, 8_000 * Q, 8_000).unwrap(), 0);
        // And past the cap, still zero rather than a negative.
        assert_eq!(max_withdrawable(10_000 * Q, 20_000 * Q, 8_000).unwrap(), 0);
    }

    #[test]
    fn an_underwater_pool_allows_no_withdrawal() {
        assert_eq!(max_withdrawable(-1, 0, 8_000).unwrap(), 0);
    }

    #[test]
    fn insurance_absorbs_a_shortfall_before_lps_do() {
        let s = absorb_shortfall(100 * Q as u64, 500 * Q as u64, 10_000 * Q);
        assert_eq!(s.from_insurance, 100 * Q as u64);
        assert_eq!(s.from_pool, 0);
        assert_eq!(s.socialized, 0);
        assert!(s.is_complete(100 * Q as u64));
    }

    #[test]
    fn lps_absorb_what_insurance_cannot() {
        let s = absorb_shortfall(500 * Q as u64, 100 * Q as u64, 10_000 * Q);
        assert_eq!(s.from_insurance, 100 * Q as u64);
        assert_eq!(s.from_pool, 400 * Q as u64);
        assert_eq!(s.socialized, 0);
        assert!(s.is_complete(500 * Q as u64));
    }

    #[test]
    fn only_what_exceeds_both_is_socialized() {
        let s = absorb_shortfall(1_000 * Q as u64, 100 * Q as u64, 200 * Q);
        assert_eq!(s.from_insurance, 100 * Q as u64);
        assert_eq!(s.from_pool, 200 * Q as u64);
        assert_eq!(s.socialized, 700 * Q as u64);
        assert!(s.is_complete(1_000 * Q as u64));
    }

    #[test]
    fn an_underwater_pool_absorbs_nothing() {
        let s = absorb_shortfall(500 * Q as u64, 0, -100 * Q);
        assert_eq!(s.from_pool, 0);
        assert_eq!(s.socialized, 500 * Q as u64);
        assert!(s.is_complete(500 * Q as u64));
    }

    /// The waterfall must account for every unit across the whole space, not
    /// just the points above.
    #[test]
    fn the_waterfall_is_total() {
        for shortfall in [0u64, 1, 999, 1_000_000, 5_000_000_000] {
            for insurance in [0u64, 1, 500_000, 3_000_000_000] {
                for nav in [-1i128, 0, 1, 750_000, 4_000_000_000] {
                    let s = absorb_shortfall(shortfall, insurance, nav);
                    assert!(
                        s.is_complete(shortfall),
                        "lost value at shortfall={shortfall} insurance={insurance} nav={nav}: {s:?}"
                    );
                }
            }
        }
    }
}
