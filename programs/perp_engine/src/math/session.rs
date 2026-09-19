//! Market sessions: what an equity perp must do when the underlying is shut.
//!
//! This is the gap that made the original design unworkable for stocks rather
//! than merely risky. A perpetual never expires, but equities trade roughly
//! 32.5 hours of the 168 in a week — about 19%. For the other 81%, the oracle
//! is reporting a price that is correct but frozen.
//!
//! A single staleness constant cannot express that. Sixty seconds shuts the
//! market every evening and all weekend. Five days lets someone be liquidated
//! on Sunday against Friday's close, which is worse.
//!
//! The resolution is to stop asking "how old is this price?" and start asking
//! **"what is the caller trying to do with it?"** Increasing risk against a
//! frozen price is a free option: the trader knows the price cannot move
//! against them until the open. Reducing risk against the same frozen price is
//! just letting someone out of a position. The first must be refused while the
//! market is shut; the second must stay available, or traders are trapped all
//! weekend and the vault carries exposure nobody can close.

// Only the derives, not the prelude: `anchor_lang::prelude::*` exports a
// one-argument `Result<T>` alias that would shadow the std `Result<T, E>` this
// module returns.
use anchor_lang::{AnchorDeserialize, AnchorSerialize, InitSpace};
// The Borsh derives above expand to paths rooted at `borsh::`, which the
// prelude would normally bring in.
use anchor_lang::prelude::borsh;

use crate::constants::*;
use crate::errors::PerpError;

/// Trading state of the underlying venue, published by the oracle authority.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketSession {
    /// Venue shut. The last print stands as the settlement price, and is
    /// allowed to be old — that is what "closed" means.
    Closed,
    /// Auction period before the open. Indications exist but there is no
    /// firm price, so this is treated as strictly as a halt.
    PreOpen,
    /// Regular trading. Normal staleness applies.
    Open,
    /// Trading halt — news pending, volatility interruption, or a delisting.
    /// There is no valid price at all, so nothing may be valued against it.
    Halted,
}

/// What the caller intends to do with the price.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriceUse {
    /// Opening or adding to a position, or withdrawing collateral. Anything
    /// that leaves the trader with more exposure than they started with.
    IncreaseRisk,
    /// Closing, or liquidating. Anything that leaves the protocol with less.
    ReduceRisk,
}

/// How stale a price may be, for this session and this intent.
///
/// Returns `None` when the price may not be used at all.
pub fn staleness_budget(session: MarketSession, use_: PriceUse) -> Option<i64> {
    match (session, use_) {
        // Live market: one budget, regardless of direction.
        (MarketSession::Open, _) => Some(MAX_ORACLE_STALENESS_SECS),

        // Shut, but with a settled closing price. Let people out, not in.
        // The budget covers a long weekend plus a holiday, after which even the
        // close is too old to be trusted and the market needs a fresh print.
        (MarketSession::Closed, PriceUse::ReduceRisk) => Some(MAX_CLOSED_SESSION_STALENESS_SECS),
        (MarketSession::Closed, PriceUse::IncreaseRisk) => None,

        // No firm price exists in either state, so neither direction is safe.
        // Refusing to liquidate during a halt is deliberate: a halted stock has
        // no mark, and liquidating against the pre-halt print would hand the
        // liquidator a position whose real value nobody knows.
        (MarketSession::PreOpen, _) | (MarketSession::Halted, _) => None,
    }
}

/// Validate a price age against the session and intent.
pub fn check_session(
    session: MarketSession,
    use_: PriceUse,
    age_secs: i64,
) -> Result<(), PerpError> {
    let budget = match staleness_budget(session, use_) {
        Some(b) => b,
        None => {
            return Err(match session {
                MarketSession::Halted => PerpError::MarketHalted,
                MarketSession::PreOpen => PerpError::SessionNotOpen,
                // Closed + IncreaseRisk: the specific, common case deserves its
                // own error so a frontend can say "opens Monday" rather than
                // "stale oracle".
                _ => PerpError::CannotIncreaseRiskWhileClosed,
            });
        }
    };
    if age_secs < 0 {
        // A price stamped in the future means a broken or hostile publisher.
        return Err(PerpError::StaleOracle);
    }
    if age_secs > budget {
        return Err(PerpError::StaleOracle);
    }
    Ok(())
}

/// Should funding accrue right now?
///
/// Only while the venue is open. Skew funding exists to pull the book back
/// toward balance by paying traders to take the lighter side — but while the
/// market is shut nobody can take any side, so charging for the imbalance is
/// a penalty with no corresponding lever. Over a three-day weekend at the cap
/// that is a material, unavoidable charge for doing nothing.
pub fn funding_accrues(session: MarketSession) -> bool {
    matches!(session, MarketSession::Open)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: i64 = 60;
    const DAY: i64 = 86_400;

    #[test]
    fn open_market_allows_both_directions_within_the_normal_budget() {
        assert!(check_session(MarketSession::Open, PriceUse::IncreaseRisk, 30).is_ok());
        assert!(check_session(MarketSession::Open, PriceUse::ReduceRisk, 30).is_ok());
    }

    #[test]
    fn open_market_still_enforces_staleness() {
        assert_eq!(
            check_session(MarketSession::Open, PriceUse::IncreaseRisk, 5 * MINUTE),
            Err(PerpError::StaleOracle)
        );
    }

    /// The core rule. Over a weekend the price is frozen, so opening a position
    /// is a free option on Monday's gap; closing one is not.
    #[test]
    fn closed_market_lets_traders_out_but_not_in() {
        assert!(check_session(MarketSession::Closed, PriceUse::ReduceRisk, 2 * DAY).is_ok());
        assert_eq!(
            check_session(MarketSession::Closed, PriceUse::IncreaseRisk, 2 * DAY),
            Err(PerpError::CannotIncreaseRiskWhileClosed)
        );
    }

    #[test]
    fn closed_market_refuses_a_price_older_than_a_long_weekend() {
        assert!(check_session(MarketSession::Closed, PriceUse::ReduceRisk, 4 * DAY).is_ok());
        assert_eq!(
            check_session(MarketSession::Closed, PriceUse::ReduceRisk, 30 * DAY),
            Err(PerpError::StaleOracle)
        );
    }

    #[test]
    fn a_halt_blocks_everything_including_liquidation() {
        assert_eq!(
            check_session(MarketSession::Halted, PriceUse::ReduceRisk, 0),
            Err(PerpError::MarketHalted)
        );
        assert_eq!(
            check_session(MarketSession::Halted, PriceUse::IncreaseRisk, 0),
            Err(PerpError::MarketHalted)
        );
    }

    #[test]
    fn preopen_has_no_firm_price_so_blocks_everything() {
        assert_eq!(
            check_session(MarketSession::PreOpen, PriceUse::ReduceRisk, 0),
            Err(PerpError::SessionNotOpen)
        );
        assert_eq!(
            check_session(MarketSession::PreOpen, PriceUse::IncreaseRisk, 0),
            Err(PerpError::SessionNotOpen)
        );
    }

    #[test]
    fn a_future_timestamp_is_rejected_in_every_session() {
        for s in [MarketSession::Open, MarketSession::Closed] {
            assert_eq!(
                check_session(s, PriceUse::ReduceRisk, -1),
                Err(PerpError::StaleOracle)
            );
        }
    }

    #[test]
    fn funding_only_accrues_while_the_venue_is_open() {
        assert!(funding_accrues(MarketSession::Open));
        assert!(!funding_accrues(MarketSession::Closed));
        assert!(!funding_accrues(MarketSession::PreOpen));
        assert!(!funding_accrues(MarketSession::Halted));
    }

    #[test]
    fn every_session_and_intent_pair_has_a_defined_answer() {
        // Guards against a new session variant silently defaulting to
        // permissive behaviour.
        for s in [
            MarketSession::Open,
            MarketSession::Closed,
            MarketSession::PreOpen,
            MarketSession::Halted,
        ] {
            for u in [PriceUse::IncreaseRisk, PriceUse::ReduceRisk] {
                let budget = staleness_budget(s, u);
                match budget {
                    Some(b) => assert!(b > 0, "{s:?}/{u:?} had a non-positive budget"),
                    None => assert!(check_session(s, u, 0).is_err()),
                }
            }
        }
    }
}
