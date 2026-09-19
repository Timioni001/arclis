use anchor_lang::prelude::*;

/// Protocol-level configuration. Exactly one exists, at a fixed PDA.
///
/// Note what is *not* here: no vault, no withdrawal authority, no fee sink the
/// authority can sweep. The authority can set a default fee and pause trading;
/// it cannot move user funds. That is the concrete content of the security
/// claim in the README, and it is enforced by the absence of any instruction
/// that transfers out of a market vault to an admin-chosen destination.
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub authority: Pubkey,
    /// Recorded for off-chain accounting. Insurance is held inside each
    /// market's own vault and tracked by `Market::insurance_balance`, so this
    /// is a label, not a spendable account.
    pub insurance_fund: Pubkey,
    /// Default taker fee applied to markets created after this is set.
    pub default_fee_bps: u16,
    /// Protocol-wide kill switch. Unlike the original engine, this is actually
    /// enforced - see `instructions::guards::require_tradable`.
    pub paused: bool,
    pub bump: u8,
    /// Reserved so new fields can be added without a migration.
    pub _reserved: [u8; 64],
}

impl GlobalConfig {
    pub const SEED: &'static [u8] = b"config";
    /// `8` discriminator + derived layout. Using `InitSpace` instead of a
    /// hand-summed constant removes a whole class of "account too small" bugs
    /// that only surface at runtime.
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}
