use anchor_lang::prelude::*;
use std::cmp::Ordering;

use crate::errors::ArclisError;
use crate::math::{corporate_actions, funding, liquidity};

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
    /// Running sum of `|size| * entry_price` across every open long, at
    /// [`PRICE_SCALE`]. Paired with `open_interest_long`, this is enough to
    /// value every long in the market at once.
    ///
    /// It exists because the liquidity pool's liability is the aggregate
    /// unrealised PnL of all traders, and Solana cannot iterate position
    /// accounts. Maintaining the sum as positions move makes that an O(1)
    /// read - see [`crate::math::liquidity::net_trader_pnl`].
    ///
    /// Adding `|delta| * fill_price` on an increase is exactly correct, because
    /// that is how the weighted entry price is defined; removing
    /// `reduce_size * entry_price` on a decrease is correct for the same
    /// reason, since a partial close leaves the entry price untouched.
    pub long_entry_notional: u128,
    pub short_entry_notional: u128,
    /// Per-side cap. Bounds how large the vault's directional exposure can get.
    pub max_open_interest: u64,
    /// Cap on |skew|, in bps of total open interest.
    pub max_skew_bps: u16,
    /// Cap on pool utilisation - the pool's directional exposure over its own
    /// NAV - in bps. This is the real solvency lever: it bounds how much risk
    /// the liquidity pool can be made to carry relative to the capital standing
    /// behind it. `max_skew_bps` limits the *shape* of the book; this limits
    /// the *size* of the bet the pool is taking.
    pub max_utilization_bps: u16,

    // --- solvency accounting ------------------------------------------------
    /// The market's liquidity pool, or `Pubkey::default()` until one exists.
    /// Markets created before a pool can still be opened and closed; they just
    /// have no counterparty, which is the state the pool exists to end.
    pub liquidity_pool: Pubkey,

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
            .ok_or(ArclisError::MathOverflow.into())
    }

    /// Refuse a payout the vault cannot actually fund.
    ///
    /// `vault_balance` is read from the live token account, not from our own
    /// bookkeeping, so this catches drift between the two rather than trusting
    /// the accounting to be right.
    pub fn require_payable(&self, vault_balance: u64, amount: u64) -> Result<()> {
        require!(vault_balance >= amount, ArclisError::VaultInsolvent);
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
                    .ok_or(ArclisError::MathOverflow)?;
            } else {
                self.open_interest_short = self
                    .open_interest_short
                    .checked_add(abs)
                    .ok_or(ArclisError::MathOverflow)?;
            }
        } else if is_long {
            self.open_interest_long = self
                .open_interest_long
                .checked_sub(abs)
                .ok_or(ArclisError::MathOverflow)?;
        } else {
            self.open_interest_short = self
                .open_interest_short
                .checked_sub(abs)
                .ok_or(ArclisError::MathOverflow)?;
        }

        // Caps are only enforced on the way up. A reduction that still leaves
        // the market over a cap lowered by governance must remain possible, or
        // traders would be trapped in positions they cannot exit.
        if increase {
            require!(
                self.open_interest_long <= self.max_open_interest
                    && self.open_interest_short <= self.max_open_interest,
                ArclisError::OpenInterestCapExceeded
            );
            let skew = self.skew_bps()?;
            require!(
                skew.abs() <= i128::from(self.max_skew_bps),
                ArclisError::SkewCapExceeded
            );
        }
        Ok(())
    }

    /// Record an increase in a position's entry notional.
    ///
    /// Called with the notional actually added - `|size_delta| * fill_price` -
    /// so the running sum tracks the weighted entry price rather than
    /// approximating it.
    pub fn add_entry_notional(&mut self, size_delta: i64, fill_price: u64) -> Result<()> {
        let notional = u128::from(size_delta.unsigned_abs())
            .checked_mul(u128::from(fill_price))
            .ok_or(ArclisError::MathOverflow)?;
        if size_delta > 0 {
            self.long_entry_notional = self
                .long_entry_notional
                .checked_add(notional)
                .ok_or(ArclisError::MathOverflow)?;
        } else {
            self.short_entry_notional = self
                .short_entry_notional
                .checked_add(notional)
                .ok_or(ArclisError::MathOverflow)?;
        }
        Ok(())
    }

    /// Record a decrease, at the position's own entry price.
    ///
    /// Saturating rather than checked: rounding across many partial closes can
    /// leave the running sum a few units short of what a final close removes,
    /// and failing the close would trap the trader over dust.
    pub fn remove_entry_notional(
        &mut self,
        reduce_size: u64,
        entry_price: u64,
        is_long: bool,
    ) -> Result<()> {
        let notional = u128::from(reduce_size)
            .checked_mul(u128::from(entry_price))
            .ok_or(ArclisError::MathOverflow)?;
        if is_long {
            self.long_entry_notional = self.long_entry_notional.saturating_sub(notional);
        } else {
            self.short_entry_notional = self.short_entry_notional.saturating_sub(notional);
        }
        Ok(())
    }

    /// Aggregate unrealised PnL of every trader in this market.
    ///
    /// Positive means the pool owes them.
    pub fn net_trader_pnl(&self, mark_price: u64) -> Result<i128> {
        Ok(liquidity::net_trader_pnl(
            self.open_interest_long,
            self.long_entry_notional,
            self.open_interest_short,
            self.short_entry_notional,
            mark_price,
        )?)
    }

    /// Quote value of the imbalance the pool is carrying.
    pub fn net_exposure_notional(&self, mark_price: u64) -> Result<i128> {
        Ok(liquidity::net_exposure_notional(
            self.open_interest_long,
            self.open_interest_short,
            mark_price,
        )?)
    }

    /// Credit collateral to a trader and to the liability total together, so
    /// the two cannot drift apart.
    pub fn credit_collateral(&mut self, amount: u64) -> Result<()> {
        self.total_collateral = self
            .total_collateral
            .checked_add(amount)
            .ok_or(ArclisError::MathOverflow)?;
        Ok(())
    }

    pub fn debit_collateral(&mut self, amount: u64) -> Result<()> {
        self.total_collateral = self
            .total_collateral
            .checked_sub(amount)
            .ok_or(ArclisError::MathOverflow)?;
        Ok(())
    }

    pub fn credit_insurance(&mut self, amount: u64) -> Result<()> {
        self.insurance_balance = self
            .insurance_balance
            .checked_add(amount)
            .ok_or(ArclisError::MathOverflow)?;
        Ok(())
    }

    pub fn debit_insurance(&mut self, amount: u64) -> Result<()> {
        self.insurance_balance = self
            .insurance_balance
            .checked_sub(amount)
            .ok_or(ArclisError::MathOverflow)?;
        Ok(())
    }

    /// Rescale the market's aggregate state for a corporate action.
    ///
    /// Open interest and the funding index are sums over positions, so unlike
    /// the positions themselves they cannot be normalised lazily - there is
    /// nothing to normalise them *against* later. They are rewritten here, in
    /// the same instruction that moves the oracle, so the aggregates and the
    /// price never disagree.
    pub fn apply_split(&mut self, from_factor: u64, to_factor: u64) -> Result<()> {
        self.open_interest_long = corporate_actions::rescale_base_amount(
            self.open_interest_long,
            from_factor,
            to_factor,
        )?;
        self.open_interest_short = corporate_actions::rescale_base_amount(
            self.open_interest_short,
            from_factor,
            to_factor,
        )?;
        self.max_open_interest =
            corporate_actions::rescale_base_amount(self.max_open_interest, from_factor, to_factor)?;
        self.cumulative_funding_index = corporate_actions::rescale_funding_index(
            self.cumulative_funding_index,
            from_factor,
            to_factor,
        )?;
        // `long_entry_notional` and `short_entry_notional` are deliberately not
        // rescaled: they are sums of `size * price`, and a split multiplies size
        // by exactly the factor it divides price by. The product is invariant,
        // which is the same reason a split does not move anyone's PnL.
        Ok(())
    }

    /// Reconcile the liability total with a position's realised PnL, and
    /// report what the pool actually has to settle.
    ///
    /// The return value is the realised amount **after clamping for bad debt**,
    /// signed from the trader's side. Callers hand it straight to
    /// `guards::settle_with_pool`, which moves that much between the two
    /// vaults. Any shortfall beyond what the market had booked is recorded here
    /// rather than transferred, because there is nothing there to transfer.
    ///
    /// Note what changed when the liquidity pool arrived: a trader's realised
    /// loss used to be credited to insurance, because there was nobody else for
    /// it to belong to. It now belongs to the pool - LPs take the other side, so
    /// they earn the losses and fund the profits. Insurance is capitalised by
    /// fees and liquidation penalties instead, which is the right separation:
    /// insurance is a backstop, not a counterparty.
    pub fn settle_realized_pnl(&mut self, realized: i128) -> Result<i128> {
        match realized.cmp(&0) {
            Ordering::Greater => {
                self.credit_collateral(crate::math::fixed::to_u64(realized)?)?;
                Ok(realized)
            }
            Ordering::Less => {
                let loss = crate::math::fixed::to_u64(
                    realized.checked_neg().ok_or(ArclisError::MathOverflow)?,
                )?;
                let bookable = loss.min(self.total_collateral);
                self.debit_collateral(bookable)?;
                if loss > bookable {
                    self.record_bad_debt(loss - bookable)?;
                }
                Ok(-i128::from(bookable))
            }
            Ordering::Equal => Ok(0),
        }
    }

    pub fn record_bad_debt(&mut self, amount: u64) -> Result<()> {
        self.bad_debt = self
            .bad_debt
            .checked_add(amount)
            .ok_or(ArclisError::MathOverflow)?;
        Ok(())
    }
}
