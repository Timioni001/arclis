use anchor_lang::prelude::*;

use crate::errors::PerpError;
use crate::math::funding;

/// One market == one oracle plus a risk configuration plus a vault.
///
/// # Solvency accounting
///
/// The fields `total_collateral`, `insurance_balance`, and `bad_debt` exist to
/// answer a question the original engine could not: *does the vault actually
/// hold what it owes?* Previously, closing a profitable position credited the
/// trader's collateral out of thin air and `withdraw_collateral` paid it from a
/// pool of other people's deposits, with no check that the money was there. A
/// sufficiently profitable long could drain the vault and the last trader out
/// would simply find the transfer failing at the token-program level with no
/// explanation.
///
/// Now, `total_collateral` is the protocol's liability to traders and is
/// maintained on every path that touches collateral. Payouts are checked
/// against the vault's real balance before transferring, and any shortfall a
/// liquidation cannot cover is recorded in `bad_debt` rather than quietly
/// consuming someone else's deposit.
///
/// This does not make the design solvent - see `docs/FEASIBILITY.md`, the
/// counterparty problem is structural and not fixable with accounting alone -
/// but it makes insolvency *visible and bounded* instead of silent.
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub oracle: Pubkey,
    pub vault: Pubkey,
    pub creator: Pubkey,

    pub vault_bump: u8,
    pub bump: u8,
    pub paused: bool,

    // --- risk configuration ------------------------------------------------
    pub max_leverage: u8,
    /// Maintenance margin. Below this a position can be liquidated.
    pub maintenance_margin_bps: u16,
    /// Initial margin, always above maintenance by at least
    /// [`INITIAL_MARGIN_BUFFER_BPS`], so a freshly opened position is never
    /// already inside the liquidation band.
    pub initial_margin_bps: u16,
    pub taker_fee_bps: u16,
    pub liquidation_penalty_bps: u16,
    /// Scales raw skew into a funding rate. 10_000 == funding equals skew.
    pub funding_sensitivity_bps: u16,

    // --- funding ------------------------------------------------------------
    pub funding_interval_secs: i64,
    pub last_funding_ts: i64,
    /// Cumulative quote owed per base unit, at [`FUNDING_INDEX_SCALE`].
    /// Positive means longs have paid shorts on net since inception.
    pub cumulative_funding_index: i128,

    // --- open interest, in base units at [`BASE_SCALE`] --------------------
    pub open_interest_long: u64,
    pub open_interest_short: u64,
    /// Per-side cap. Bounds how large the vault's directional exposure can get.
    pub max_open_interest: u64,
    /// Cap on |skew|. Refusing the trade that would breach it is the only
    /// structural defence this design has against the counterparty gap.
    pub max_skew_bps: u16,

    // --- solvency accounting ------------------------------------------------
    /// Sum of every open position's collateral: what the vault owes traders.
    pub total_collateral: u64,
    /// Fees and liquidation penalties retained in the vault as a backstop.
    pub insurance_balance: u64,
    /// Shortfall insurance could not cover. Non-zero means the vault is
    /// under-collateralised by this amount and an operator must recapitalise.
    pub bad_debt: u64,

    pub _reserved: [u8; 64],
}

impl Market {
    pub const SEED: &'static [u8] = b"market";
    pub const VAULT_SEED: &'static [u8] = b"vault";
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    /// Signer seeds for the market PDA, which owns the vault.
    ///
    /// Centralised here because it was previously rebuilt by hand in
    /// `withdraw_collateral` and `liquidate`; two copies of a seed derivation
    /// is one copy too many.
    pub fn signer_seeds<'a>(oracle: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
        [Self::SEED, oracle.as_ref(), bump]
    }

    pub fn skew_bps(&self) -> Result<i128> {
        Ok(funding::skew_bps(
            self.open_interest_long,
            self.open_interest_short,
        )?)
    }

    /// What the vault must hold to be solvent: trader collateral plus the
    /// insurance it claims to have set aside.
    pub fn liabilities(&self) -> Result<u64> {
        self.total_collateral
            .checked_add(self.insurance_balance)
            .ok_or(PerpError::MathOverflow.into())
    }

    /// Refuse a payout the vault cannot actually fund.
    ///
    /// `vault_balance` is read from the live token account, not from our own
    /// bookkeeping, so this catches drift between the two rather than trusting
    /// the accounting to be right.
    pub fn require_payable(&self, vault_balance: u64, amount: u64) -> Result<()> {
        require!(vault_balance >= amount, PerpError::VaultInsolvent);
        Ok(())
    }

    /// Apply a size change to open interest and enforce both caps.
    ///
    /// `delta` is signed: positive adds to the long side, negative to the short
    /// side. Reductions pass the opposite sign with `increase = false`.
    pub fn apply_open_interest(&mut self, delta: i64, increase: bool) -> Result<()> {
        let abs = delta.unsigned_abs();
        let is_long = delta > 0;

        if increase {
            if is_long {
                self.open_interest_long = self
                    .open_interest_long
                    .checked_add(abs)
                    .ok_or(PerpError::MathOverflow)?;
            } else {
                self.open_interest_short = self
                    .open_interest_short
                    .checked_add(abs)
                    .ok_or(PerpError::MathOverflow)?;
            }
        } else if is_long {
            self.open_interest_long = self
                .open_interest_long
                .checked_sub(abs)
                .ok_or(PerpError::MathOverflow)?;
        } else {
            self.open_interest_short = self
                .open_interest_short
                .checked_sub(abs)
                .ok_or(PerpError::MathOverflow)?;
        }

        // Caps are only enforced on the way up. A reduction that still leaves
        // the market over a cap lowered by governance must remain possible, or
        // traders would be trapped in positions they cannot exit.
        if increase {
            require!(
                self.open_interest_long <= self.max_open_interest
                    && self.open_interest_short <= self.max_open_interest,
                PerpError::OpenInterestCapExceeded
            );
            let skew = self.skew_bps()?;
            require!(
                skew.abs() <= i128::from(self.max_skew_bps),
                PerpError::SkewCapExceeded
            );
        }
        Ok(())
    }

    /// Credit collateral to a trader and to the liability total together, so
    /// the two cannot drift apart.
    pub fn credit_collateral(&mut self, amount: u64) -> Result<()> {
        self.total_collateral = self
            .total_collateral
            .checked_add(amount)
            .ok_or(PerpError::MathOverflow)?;
        Ok(())
    }

    pub fn debit_collateral(&mut self, amount: u64) -> Result<()> {
        self.total_collateral = self
            .total_collateral
            .checked_sub(amount)
            .ok_or(PerpError::MathOverflow)?;
        Ok(())
    }

    pub fn credit_insurance(&mut self, amount: u64) -> Result<()> {
        self.insurance_balance = self
            .insurance_balance
            .checked_add(amount)
            .ok_or(PerpError::MathOverflow)?;
        Ok(())
    }

    pub fn debit_insurance(&mut self, amount: u64) -> Result<()> {
        self.insurance_balance = self
            .insurance_balance
            .checked_sub(amount)
            .ok_or(PerpError::MathOverflow)?;
        Ok(())
    }

    pub fn record_bad_debt(&mut self, amount: u64) -> Result<()> {
        self.bad_debt = self
            .bad_debt
            .checked_add(amount)
            .ok_or(PerpError::MathOverflow)?;
        Ok(())
    }
}
