//! Pure arithmetic, deliberately free of Anchor and Solana types.
//!
//! Nothing in this module touches an account, a `Clock`, or a CPI. That is the
//! point: the interesting parts of a perp engine are the numbers, and keeping
//! them here means they can be exercised with `cargo test` on the host in under
//! a second, rather than only through a validator and a TypeScript harness.
//!
//! The instruction handlers in [`crate::instructions`] are then thin: load
//! accounts, check authority and staleness, call into here, write results back,
//! emit an event.
//!
//! `session` and `corporate_actions` carry the equity-specific rules — trading
//! hours, halts, and splits — that separate a perp on a stock from a perp on a
//! token that trades continuously.

pub mod corporate_actions;
pub mod fixed;
pub mod funding;
pub mod liquidation;
pub mod pnl;
pub mod session;
pub mod treasury;
