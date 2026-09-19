//! On-chain account layouts.
//!
//! One file per account, and every account derives `InitSpace` so its size is
//! computed rather than hand-summed. The previous single `state.rs` mixed four
//! account definitions with all of the protocol's arithmetic; splitting them
//! means a change to the funding formula no longer sits in the same file as the
//! account layout it has to stay compatible with.
//!
//! The arithmetic itself now lives in [`crate::math`], and the methods here are
//! thin forwards into it.

pub mod global_config;
pub mod liquidity;
pub mod market;
pub mod oracle;
pub mod position;
pub mod treasury;

pub use global_config::GlobalConfig;
pub use liquidity::{LiquidityPool, LpPosition};
pub use market::Market;
pub use oracle::PriceOracle;
pub use position::Position;
pub use treasury::AgentTreasury;
