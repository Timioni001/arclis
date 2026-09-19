use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::ArclisError;
use crate::math::treasury::{self, TreasuryExposure};

/// An AI agent's balance sheet, denominated in a tokenized stock.
///
/// # Where this sits
///
/// The agent launches its token on a Meteora DBC curve whose quote asset is a
/// tokenized stock. Contributors pay in AAPLx; at graduation the raise lands
/// here. This account is what happens *after* the launch — the part every
/// bonding-curve launchpad leaves as an exercise for the founder.
///
/// It holds three things: the stock the agent raised, a perp position that
/// offsets the beta of that stock, and enough accounting to publish an honest
/// NAV per agent token.
///
/// # Why an agent needs it
///
/// An agent that raised the equivalent of $100k in AAPLx has a runway that
/// swings with Apple's earnings. It did not ask for that exposure and has no
/// view on it — it just wanted to be funded in the asset it trades. Shorting
/// the matching perp turns a levered bet on one company back into a stable
/// operating budget, and while the perp book is skewed long the short is on
/// the receiving side of funding, so the hedge can carry positively.
#[account]
#[derive(InitSpace)]
pub struct AgentTreasury {
    /// The agent's authority. Can set policy, withdraw to operations, and
    /// close the treasury. Cannot touch another treasury.
    pub authority: Pubkey,
    /// The agent's own SPL token, as launched on the bonding curve. Recorded so
    /// NAV per token means something.
    pub agent_mint: Pubkey,
    /// The tokenized stock this treasury is denominated in, e.g. AAPLx.
    pub stock_mint: Pubkey,
    /// The perp market used to hedge. Its oracle must price `stock_mint`.
    pub market: Pubkey,
    /// PDA token account holding the raised stock.
    pub stock_vault: Pubkey,

    /// Base units of stock held outright, at [`BASE_SCALE`].
    pub stock_qty: u64,
    /// Agent tokens outstanding, used as the NAV denominator. Maintained by
    /// the authority, because supply lives on the bonding curve and DBC has no
    /// CPI this program can trust for it.
    pub tokens_outstanding: u64,

    /// How much of the stock exposure to hedge away, in bps.
    /// 10_000 is fully delta-neutral; 0 leaves the treasury long.
    pub hedge_ratio_bps: u16,
    /// Drift band before a rebalance is allowed, in bps of the holding.
    /// Stops a permissionless crank being farmed for taker fees.
    pub rebalance_tolerance_bps: u16,
    /// When false, `rebalance` refuses. Lets an agent step out of the hedge
    /// without unwinding the treasury.
    pub hedging_enabled: bool,

    /// Last published NAV per agent token, at [`QUOTE_SCALE`]. A cache for
    /// readers; recomputed on every rebalance.
    pub last_nav_per_token: u64,
    pub last_nav_ts: i64,

    pub bump: u8,
    pub stock_vault_bump: u8,
    pub _reserved: [u8; 64],
}

impl AgentTreasury {
    pub const SEED: &'static [u8] = b"treasury";
    pub const STOCK_VAULT_SEED: &'static [u8] = b"treasury_stock";
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    pub fn signer_seeds<'a>(agent_mint: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
        [Self::SEED, agent_mint.as_ref(), bump]
    }

    pub fn validate_policy(hedge_ratio_bps: u16, rebalance_tolerance_bps: u16) -> Result<()> {
        require!(
            i128::from(hedge_ratio_bps) <= BPS_SCALE,
            ArclisError::InvalidHedgeRatio
        );
        require!(
            rebalance_tolerance_bps <= MAX_REBALANCE_TOLERANCE_BPS,
            ArclisError::InvalidRebalanceTolerance
        );
        Ok(())
    }

    /// Value the treasury against the current mark.
    ///
    /// `position` is the treasury's own perp position in `market`; a treasury
    /// that has never hedged passes a flat one and gets its raw stock value
    /// back.
    pub fn exposure(
        &self,
        perp_size: i64,
        perp_collateral: u64,
        perp_entry_price: u64,
        perp_entry_funding_index: i128,
        market_funding_index: i128,
        mark_price: u64,
    ) -> Result<TreasuryExposure> {
        Ok(treasury::exposure(
            self.stock_qty,
            perp_size,
            perp_collateral,
            perp_entry_price,
            perp_entry_funding_index,
            market_funding_index,
            mark_price,
        )?)
    }

    /// The perp size change that would return the treasury to its target
    /// hedge, or zero if it is inside the tolerance band.
    pub fn rebalance_size_delta(&self, current_delta: i64) -> Result<i64> {
        Ok(treasury::rebalance_size_delta(
            self.stock_qty,
            current_delta,
            self.hedge_ratio_bps,
            self.rebalance_tolerance_bps,
        )?)
    }

    pub fn record_nav(&mut self, nav: i128, now: i64) -> Result<u64> {
        let per_token = treasury::nav_per_token(nav, self.tokens_outstanding)?;
        self.last_nav_per_token = per_token;
        self.last_nav_ts = now;
        Ok(per_token)
    }
}
