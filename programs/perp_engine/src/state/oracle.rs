use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::PerpError;
use crate::math::fixed::mul_div;

/// Keeper-fed price account.
///
/// # Why this is not Pyth yet
///
/// The shape here - price, confidence, publish time, exponent - is Pyth's on
/// purpose. Swapping in a real feed should touch [`PriceOracle::validated_price`]
/// and the account type in each instruction's `Accounts` struct, and nothing
/// else.
///
/// It is not Pyth today because a single trusted writer is honest about what a
/// hackathon build actually is, and because pulling `pyth-solana-receiver-sdk`
/// into an Anchor 0.30.1 / Solana 1.18 build drags in the same edition-2024
/// dependency wall documented in `BUILD.md`. Treat the writer as a trusted
/// party and say so; do not ship this to mainnet.
///
/// What the account *does* enforce, so the trust is bounded rather than total:
/// staleness, a positive price, a confidence band, and a per-update deviation
/// cap that stops a compromised keeper from printing an instant 100x.
#[account]
#[derive(InitSpace)]
pub struct PriceOracle {
    pub authority: Pubkey,
    pub symbol: [u8; 16],
    /// Price at [`PRICE_SCALE`].
    pub price: u64,
    /// Half-width of the confidence interval, at [`PRICE_SCALE`].
    pub confidence: u64,
    pub last_update_ts: i64,
    /// Monotonic counter, so a consumer can tell "unchanged" from "not updated".
    pub update_slot: u64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl PriceOracle {
    pub const SEED: &'static [u8] = b"oracle";
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    /// Return the price, or fail with the specific reason it is untrustworthy.
    ///
    /// Called by every instruction that values a position. The original engine
    /// checked staleness and positivity but ignored `confidence` entirely, so a
    /// feed reporting "$100, plus or minus $80" was treated as a clean $100 and
    /// could be liquidated against.
    pub fn validated_price(&self, now: i64) -> Result<u64> {
        require!(self.price > 0, PerpError::InvalidOraclePrice);

        let age = now
            .checked_sub(self.last_update_ts)
            .ok_or(PerpError::MathOverflow)?;
        require!(age <= MAX_ORACLE_STALENESS_SECS, PerpError::StaleOracle);
        // A timestamp from the future means a broken or hostile publisher.
        require!(age >= 0, PerpError::StaleOracle);

        let conf_bps = mul_div(
            i128::from(self.confidence),
            BPS_SCALE,
            i128::from(self.price),
        )?;
        require!(
            conf_bps <= MAX_ORACLE_CONFIDENCE_BPS,
            PerpError::OracleConfidenceTooWide
        );

        Ok(self.price)
    }

    /// Reject an update that jumps further than [`MAX_ORACLE_DEVIATION_BPS`]
    /// from the current price.
    ///
    /// This bounds the damage a compromised oracle authority can do in a single
    /// transaction. It cannot stop a determined attacker who walks the price
    /// over many updates, but it removes the one-transaction drain, which is
    /// the difference between a slow, observable attack and an atomic one.
    pub fn check_deviation(&self, new_price: u64) -> Result<()> {
        if self.price == 0 {
            return Ok(());
        }
        let delta = i128::from(new_price)
            .checked_sub(i128::from(self.price))
            .ok_or(PerpError::MathOverflow)?
            .abs();
        let deviation_bps = mul_div(delta, BPS_SCALE, i128::from(self.price))?;
        require!(
            deviation_bps <= MAX_ORACLE_DEVIATION_BPS,
            PerpError::OracleDeviationTooLarge
        );
        Ok(())
    }
}
