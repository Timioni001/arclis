//! Instruction handlers.
//!
//! Each handler follows the same shape, in this order:
//!
//! 1. guards - pause state, authority, account matching
//! 2. read and validate the oracle price
//! 3. settle funding, so everything downstream sees current state
//! 4. call into [`crate::math`] for the arithmetic
//! 5. write results back to accounts and reconcile market-level accounting
//! 6. emit an event
//!
//! # Every data account is boxed, and has to stay that way
//!
//! Each `#[derive(Accounts)]` struct here declares its data accounts as
//! `Box<Account<'info, T>>` rather than `Account<'info, T>`. That is not a
//! style preference.
//!
//! SBF gives each function a fixed 4KB stack frame and does not trap on
//! overflow. Anchor generates one function per instruction that deserialises
//! the arguments, then constructs the whole accounts struct in that same
//! frame. An unboxed `Account<'info, T>` holds a fully deserialised `T` by
//! value, so a context holding a `Market`, a couple of `TokenAccount`s and a
//! `Position` runs past 4KB on its own - and the write past the end lands on
//! whatever the frame holds next, which includes the instruction arguments.
//!
//! The failure mode is not a crash. `create_market` ran with
//! `max_leverage = 0` and a `max_open_interest` of 2039280 - the rent-exempt
//! minimum for the vault token account, computed a few lines earlier by the
//! `init` constraint and written straight over the parameters - and rejected
//! the caller for sending bad values. The client was correct; the transaction
//! was correct; everything was correct except the bytes the handler read.
//!
//! Boxing moves the account data to the heap and leaves an 8-byte pointer on
//! the stack. It changes nothing about the IDL, so clients are unaffected.
//! `scripts/anchor-test.sh` now fails loudly on the compiler's stack-offset
//! warning, which is the signal that was there all along.
//!
//! Keeping that order uniform is what makes the "did this handler forget to
//! settle funding before resizing?" class of bug visible on inspection.

pub mod admin;
pub mod close_position;
pub mod corporate_action;
pub mod crank_funding;
pub mod create_market;
pub mod deposit_collateral;
pub mod guards;
pub mod initialize_global_config;
pub mod insurance;
pub mod liquidate;
pub mod liquidity;
pub mod open_position;
pub mod price_oracle;
pub mod treasury;
pub mod withdraw_collateral;

// Glob re-exports are load-bearing here, not stylistic: `#[program]` expands to
// code that refers to the `__client_accounts_*` and `__cpi_client_accounts_*`
// modules Anchor generates inside each instruction module, and it resolves them
// through this glob. Replacing these with explicit `pub use` of just the
// `Accounts` structs makes `#[program]` fail to compile.
//
// The cost is that every module's `handler` is re-exported into the same
// namespace, which rustc flags as an ambiguous glob re-export. Nothing resolves
// `instructions::handler` - `lib.rs` always calls the module-qualified path - so
// the ambiguity is inert, and the allow is scoped to this one `use` block rather
// than crate-wide.
#[allow(ambiguous_glob_reexports)]
mod reexports {
    pub use super::admin::*;
    pub use super::close_position::*;
    pub use super::corporate_action::*;
    pub use super::crank_funding::*;
    pub use super::create_market::*;
    pub use super::deposit_collateral::*;
    pub use super::initialize_global_config::*;
    pub use super::insurance::*;
    pub use super::liquidate::*;
    pub use super::liquidity::*;
    pub use super::open_position::*;
    pub use super::price_oracle::*;
    pub use super::treasury::*;
    pub use super::withdraw_collateral::*;
}
pub use reexports::*;
