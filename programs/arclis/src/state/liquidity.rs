use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::ArclisError;
use crate::math::liquidity;

/// The counterparty pool for one market.
///
/// LPs deposit quote here and the pool takes the other side of whatever
/// imbalance traders leave. It is the answer to "where does a winning trader's
/// money come from", and without it the market vault was paying winners out of
/// other traders' deposits.
///
/// # Design choices, and what each one costs
///
/// **Separate vault, not shared with trader collateral.** LP capital lives in
/// its own token account. Realised PnL therefore moves between the two vaults
/// on every close, which costs an extra CPI per settlement. The benefit is that
/// "how much of this balance is LP capital" is never a question of bookkeeping -
/// it is the balance. During a shortfall, that distinction is the one people
/// will want to audit.
///
/// **Internal share accounting, not an LP mint.** Shares live in
/// [`LpPosition`] accounts rather than as a token. That gives up composability:
/// an Arclis LP share cannot be traded on a DEX or used as collateral
/// elsewhere. In exchange there is no mint authority to secure, no way to
/// accidentally mint supply, and redemption rules can be enforced on the share
/// itself rather than only at the vault. Given the pool is a loss absorber,
/// keeping the accounting in one program is the safer trade for now; a
/// tokenised wrapper can be layered on later without changing this.
///
/// **Cooldown withdrawals.** See [`LpPosition::pending_shares`].
#[account]
#[derive(InitSpace)]
pub struct LiquidityPool {
    pub market: Pubkey,
    /// PDA token account holding LP capital, in the market's quote mint.
    pub vault: Pubkey,
    pub quote_mint: Pubkey,
    /// Set at creation; may pause deposits without affecting redemptions.
    pub authority: Pubkey,

    /// Shares outstanding. Value per share is NAV / this.
    pub total_shares: u64,
    /// Lifetime deposits minus withdrawals. Reporting only - it is *not* the
    /// pool's value, because it ignores trader PnL.
    pub principal: u64,
    /// Cumulative realised PnL transferred between traders and the pool.
    /// Positive means the pool has taken money from traders on net.
    pub realized_pnl: i128,
    /// Shortfall the pool has absorbed from the bad-debt waterfall.
    pub absorbed_bad_debt: u64,

    /// How long a redemption request must wait. Bounded by
    /// [`MIN_LP_COOLDOWN_SECS`] and [`MAX_LP_COOLDOWN_SECS`].
    pub cooldown_secs: i64,
    /// Shares across all LPs currently in cooldown. Reporting only; each
    /// request is enforced against its own [`LpPosition`].
    pub pending_shares: u64,

    /// When true, no new deposits. Redemptions always remain open - trapping
    /// LPs in a losing pool is how a protocol loses them permanently.
    pub deposits_paused: bool,

    pub bump: u8,
    pub vault_bump: u8,
    pub _reserved: [u8; 64],
}

impl LiquidityPool {
    pub const SEED: &'static [u8] = b"lp_pool";
    pub const VAULT_SEED: &'static [u8] = b"lp_vault";
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    pub fn signer_seeds<'a>(market: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
        [Self::SEED, market.as_ref(), bump]
    }

    pub fn validate_cooldown(cooldown_secs: i64) -> Result<()> {
        require!(
            (MIN_LP_COOLDOWN_SECS..=MAX_LP_COOLDOWN_SECS).contains(&cooldown_secs),
            ArclisError::InvalidCooldown
        );
        Ok(())
    }

    /// Net asset value: what the vault holds, less what traders are owed.
    ///
    /// `vault_balance` is read from the live token account rather than from
    /// `principal`, so accounting drift shows up as a wrong NAV instead of
    /// hiding behind it.
    pub fn nav(&self, vault_balance: u64, net_trader_pnl: i128) -> Result<i128> {
        Ok(liquidity::pool_nav(vault_balance, net_trader_pnl)?)
    }

    pub fn shares_for_deposit(&self, amount: u64, nav: i128) -> Result<u64> {
        Ok(liquidity::shares_for_deposit(
            amount,
            self.total_shares,
            nav,
        )?)
    }

    pub fn amount_for_shares(&self, shares: u64, nav: i128) -> Result<u64> {
        Ok(liquidity::amount_for_shares(
            shares,
            self.total_shares,
            nav,
        )?)
    }

    pub fn mint_shares(&mut self, shares: u64, amount: u64) -> Result<()> {
        self.total_shares = self
            .total_shares
            .checked_add(shares)
            .ok_or(ArclisError::MathOverflow)?;
        self.principal = self
            .principal
            .checked_add(amount)
            .ok_or(ArclisError::MathOverflow)?;
        Ok(())
    }

    pub fn burn_shares(&mut self, shares: u64, amount: u64) -> Result<()> {
        self.total_shares = self
            .total_shares
            .checked_sub(shares)
            .ok_or(ArclisError::InsufficientShares)?;
        // Saturating: once the pool has taken losses, redemptions can exceed
        // what was originally put in, and `principal` is a reporting figure
        // rather than a constraint.
        self.principal = self.principal.saturating_sub(amount);
        Ok(())
    }

    pub fn record_realized_pnl(&mut self, delta: i128) -> Result<()> {
        self.realized_pnl = self
            .realized_pnl
            .checked_add(delta)
            .ok_or(ArclisError::MathOverflow)?;
        Ok(())
    }
}

/// One LP's stake in a pool.
///
/// # Why a cooldown
///
/// Instant redemption turns a drawdown into a collapse. The moment the pool is
/// carrying a loss, the rational move for every LP is to exit before the others
/// - so the first out are paid at a NAV the pool cannot sustain, and whoever is
/// slowest holds the entire loss. It is a bank run with the run built in.
///
/// A cooldown means a redemption is priced at the NAV *when it settles*, not
/// when it was requested. An LP who requests on bad news still carries the
/// position through the cooldown, so there is nothing to win by being fast.
/// Shares stay at risk while pending, which is the whole point: a cooldown that
/// froze the redemption value would just be a slower free option.
#[account]
#[derive(InitSpace)]
pub struct LpPosition {
    pub owner: Pubkey,
    pub pool: Pubkey,
    /// Total shares held, including any pending redemption.
    pub shares: u64,
    /// Shares under an active redemption request. Still at risk.
    pub pending_shares: u64,
    /// When the pending request becomes claimable. Zero when none is pending.
    pub cooldown_ends_ts: i64,
    pub last_deposit_ts: i64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl LpPosition {
    pub const SEED: &'static [u8] = b"lp_position";
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    pub fn has_pending(&self) -> bool {
        self.pending_shares > 0
    }

    /// Shares free to be requested for redemption.
    pub fn available_shares(&self) -> u64 {
        self.shares.saturating_sub(self.pending_shares)
    }

    pub fn require_cooldown_elapsed(&self, now: i64) -> Result<()> {
        require!(self.has_pending(), ArclisError::NoPendingWithdrawal);
        require!(
            now >= self.cooldown_ends_ts,
            ArclisError::CooldownNotElapsed
        );
        Ok(())
    }
}
