//! Numeric conventions and protocol-wide bounds.
//!
//! # Fixed-point conventions
//!
//! Every quantity in this program is an integer with an implicit scale. Getting
//! these wrong is the single most common source of bugs in a perp engine, so
//! they are stated once, here, and referenced everywhere else.
//!
//! | quantity        | type   | scale                | meaning                              |
//! |-----------------|--------|----------------------|--------------------------------------|
//! | base size       | `i64`  | [`BASE_SCALE`] 1e6   | signed; +long / -short, 1e6 = 1 unit |
//! | price           | `u64`  | [`PRICE_SCALE`] 1e6  | quote per base unit                  |
//! | quote / USDC    | `u64`  | [`QUOTE_SCALE`] 1e6  | matches USDC's 6 decimals            |
//! | funding index   | `i128` | [`FUNDING_INDEX_SCALE`] 1e9 | cumulative quote owed per base unit |
//! | ratios / rates  | `i128` | [`BPS_SCALE`] 1e4    | basis points                         |
//!
//! The one identity every caller depends on:
//!
//! ```text
//! notional_quote = |size| * price / PRICE_SCALE
//! ```
//!
//! which is dimensionally `(base·1e6) * (quote·1e6) / 1e6 = quote·1e6`. Any
//! expression that multiplies a size by a price and does *not* divide by
//! [`PRICE_SCALE`] is wrong.

/// Scale for signed base sizes. `1_000_000` == one whole unit of the asset.
pub const BASE_SCALE: i128 = 1_000_000;

/// Scale for prices, quoted as quote-per-base.
pub const PRICE_SCALE: i128 = 1_000_000;

/// Scale for quote amounts. Matches USDC's 6 decimals so vault balances and
/// collateral are directly comparable to raw token amounts.
pub const QUOTE_SCALE: i128 = 1_000_000;

/// Extra-precision scale for the cumulative funding index.
///
/// The index is "cumulative quote owed per base unit". Because it accrues in
/// small increments over a long lifetime, it carries three more decimal places
/// than the quote scale so that rounding does not eat a small position's
/// funding entirely on every crank.
pub const FUNDING_INDEX_SCALE: i128 = 1_000_000_000;

/// Basis-point scale. 10_000 bps == 100%.
pub const BPS_SCALE: i128 = 10_000;

// ---------------------------------------------------------------------------
// Oracle bounds
// ---------------------------------------------------------------------------

/// Reject any price older than this while the venue is open.
pub const MAX_ORACLE_STALENESS_SECS: i64 = 60;

/// How old a closing price may be and still be used to *reduce* risk.
///
/// Sized to cover the longest ordinary gap in an equity calendar: a Friday
/// close into a Tuesday open across a Monday holiday, plus slack. Past this the
/// close is no longer a defensible mark and the market needs a fresh print
/// before anyone can even exit. See [`crate::math::session`].
pub const MAX_CLOSED_SESSION_STALENESS_SECS: i64 = 5 * 86_400;

/// Reject a price whose confidence interval is wider than this fraction of the
/// price itself. A 2% band on a tokenized equity means the feed is in trouble
/// (halt, gap, thin book) and we would rather refuse than liquidate on it.
pub const MAX_ORACLE_CONFIDENCE_BPS: i128 = 200;

/// A price update may not move more than this from the previous price in a
/// single update. Bounds the blast radius of a compromised or fat-fingered
/// oracle authority: an attacker cannot print an instant 100x and drain the
/// vault in one transaction, they have to walk the price and eat the
/// per-update cap each time.
pub const MAX_ORACLE_DEVIATION_BPS: i128 = 1_000;

// ---------------------------------------------------------------------------
// Corporate actions
// ---------------------------------------------------------------------------

/// Scale for the cumulative split factor. `1e9` == "one share is still one
/// share". See [`crate::math::corporate_actions`].
pub const SPLIT_FACTOR_SCALE: u64 = 1_000_000_000;

/// Bound on either side of a split ratio. Real splits are single or double
/// digits; a 1:1000000 would round every position on the book to zero size, so
/// a fat finger is refused rather than applied.
pub const MAX_SPLIT_RATIO_COMPONENT: u32 = 1_000;

// ---------------------------------------------------------------------------
// Market parameter bounds (enforced at create_market)
// ---------------------------------------------------------------------------

pub const MIN_LEVERAGE_CAP: u8 = 1;
pub const MAX_LEVERAGE_CAP: u8 = 20;

/// Maintenance margin floor/ceiling, in bps of notional.
pub const MIN_MARGIN_RATIO_BPS_FLOOR: u16 = 100; // 1%
pub const MIN_MARGIN_RATIO_BPS_CEIL: u16 = 5_000; // 50%

/// Initial margin must exceed maintenance margin by at least this much, so a
/// position cannot be opened already inside the liquidation band.
pub const INITIAL_MARGIN_BUFFER_BPS: i128 = 100; // 1%

pub const MIN_FUNDING_INTERVAL_SECS: i64 = 60;
pub const MAX_FUNDING_INTERVAL_SECS: i64 = 86_400;

/// Per-interval funding rate cap, in bps of notional. Applied after the skew
/// sensitivity, so no configuration of a market can produce a larger charge.
pub const MAX_FUNDING_RATE_BPS_PER_INTERVAL: i128 = 50; // 0.50%

/// Upper bound on how many intervals one crank may settle at once. Without this
/// a market left un-cranked over a weekend would apply an enormous one-shot
/// charge the moment someone touched it.
pub const MAX_FUNDING_INTERVALS_PER_CRANK: i128 = 24;

/// Bound on `Market::funding_sensitivity_bps`. At 10_000 the funding rate
/// equals the raw skew in bps (before the cap above).
pub const MAX_FUNDING_SENSITIVITY_BPS: u16 = 10_000;

// ---------------------------------------------------------------------------
// Fees and liquidation
// ---------------------------------------------------------------------------

/// Cap on the protocol taker fee, charged on notional at open and close.
pub const MAX_FEE_BPS: u16 = 100; // 1%

/// Cap on `Market::liquidation_penalty_bps`, charged on the notional of a
/// liquidated position.
pub const MAX_LIQUIDATION_PENALTY_BPS: u16 = 1_000; // 10%

/// Share of the liquidation penalty that goes to whoever sent the transaction.
/// The remainder capitalises the insurance fund. This is the incentive that
/// makes liquidation permissionless rather than a privileged keeper role.
pub const LIQUIDATOR_PENALTY_SHARE_BPS: i128 = 5_000; // 50% of the penalty

/// Minimum quote value of a position. Positions below this are not worth the
/// transaction fee to liquidate, so they become sticky bad debt; requiring a
/// floor keeps every open position economically liquidatable.
pub const MIN_POSITION_NOTIONAL: u64 = 10 * (QUOTE_SCALE as u64); // $10

/// Flat bounty paid from insurance to whoever liquidates an underwater
/// position.
///
/// A percentage-of-equity reward pays nothing precisely when equity has gone
/// negative, which is when closing the position matters most - so nobody does
/// it, and the shortfall keeps growing. A small fixed bounty, capped at the
/// remaining insurance balance, keeps the permissionless incentive alive in the
/// one case the percentage model abandons.
pub const BAD_DEBT_LIQUIDATION_BOUNTY: u64 = QUOTE_SCALE as u64; // $1

// ---------------------------------------------------------------------------
// Agent treasuries
// ---------------------------------------------------------------------------

/// Widest drift band a treasury may set before a rebalance is allowed.
///
/// A band above this stops being a fee-farming guard and starts being a way to
/// claim a hedge that is never actually maintained.
pub const MAX_REBALANCE_TOLERANCE_BPS: u16 = 2_000; // 20%

// ---------------------------------------------------------------------------
// Liquidity pool
// ---------------------------------------------------------------------------

/// Bounds on a market's pool utilisation cap.
///
/// Utilisation is the pool's directional exposure over its own NAV. Above
/// 10_000 bps the pool is levered against its own capital, which is a choice a
/// market creator may legitimately make but not without limit.
pub const MIN_UTILIZATION_CAP_BPS: u16 = 1_000; // 10%
pub const MAX_UTILIZATION_CAP_BPS: u16 = 20_000; // 200%

/// Bounds on the LP withdrawal cooldown.
///
/// The floor is what makes the pool something other than a hot wallet: without
/// a delay, LPs exit the instant the pool is underwater and the last one out
/// carries every loss. The ceiling stops a market creator locking capital up
/// indefinitely.
pub const MIN_LP_COOLDOWN_SECS: i64 = 3_600; // 1 hour
pub const MAX_LP_COOLDOWN_SECS: i64 = 14 * 86_400; // 14 days

/// How much utilisation amplifies the funding rate, in bps of the base rate.
///
/// At 100% utilisation funding is doubled, so the book pays progressively more
/// to whichever side would unload the pool. Applied before the hard per-interval
/// clamp, so it can never produce a charge larger than the protocol maximum.
pub const UTILIZATION_FUNDING_MULTIPLIER_BPS: i128 = 10_000;
