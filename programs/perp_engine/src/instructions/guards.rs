//! Cross-cutting preconditions.
//!
//! These were previously inline `constraint =` attributes duplicated across
//! instruction structs, with the result that `GlobalConfig::paused` was declared
//! but never actually checked anywhere - the protocol kill switch did nothing.
//! Routing every trading instruction through one function means a new
//! instruction cannot forget a check by omission.

use anchor_lang::prelude::*;

use crate::errors::PerpError;
use crate::state::{GlobalConfig, Market};

/// Both kill switches, protocol first.
///
/// Called by every instruction that opens, closes, or moves collateral.
/// Deliberately *not* called by [`crate::instructions::liquidate`]: a paused
/// market must still be liquidatable, or pausing would trap the vault with
/// underwater positions it cannot close while the price keeps moving.
pub fn require_tradable(config: &GlobalConfig, market: &Market) -> Result<()> {
    require!(!config.paused, PerpError::ProtocolPaused);
    require!(!market.paused, PerpError::MarketPaused);
    Ok(())
}

/// Protocol-level pause only. Liquidation uses this: a globally paused protocol
/// is an emergency stop and should halt everything, but a single paused market
/// should not block the risk engine.
pub fn require_protocol_live(config: &GlobalConfig) -> Result<()> {
    require!(!config.paused, PerpError::ProtocolPaused);
    Ok(())
}

pub fn require_authority(config: &GlobalConfig, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(config.authority, *signer, PerpError::Unauthorized);
    Ok(())
}
