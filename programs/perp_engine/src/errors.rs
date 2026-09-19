use anchor_lang::prelude::*;

/// Program error surface.
///
/// `PartialEq`/`Eq` are derived explicitly - `#[error_code]` does not add them -
/// because the unit tests in [`crate::math`] assert on the exact variant rather
/// than just "it failed". Asserting the variant is what turns a test from
/// "this rejected something" into "this rejected it for the right reason".
#[error_code]
#[derive(PartialEq, Eq)]
pub enum PerpError {
    // --- authority and lifecycle -------------------------------------------
    #[msg("Only the global authority can perform this action")]
    Unauthorized,

    #[msg("The protocol is currently paused")]
    ProtocolPaused,

    #[msg("This market is currently paused")]
    MarketPaused,

    // --- oracle -------------------------------------------------------------
    #[msg("Oracle price is stale, refusing to trade or liquidate")]
    StaleOracle,

    #[msg("Oracle price must be a positive value")]
    InvalidOraclePrice,

    #[msg("Oracle confidence interval is too wide to trade against")]
    OracleConfidenceTooWide,

    #[msg("Oracle price moved more than the per-update deviation limit")]
    OracleDeviationTooLarge,

    #[msg("Provided oracle account does not match the market's configured oracle")]
    OracleMismatch,

    // --- position lifecycle -------------------------------------------------
    #[msg("Position size cannot be zero")]
    ZeroSize,

    #[msg("Cannot flip direction in one instruction: close the position first")]
    DirectionFlip,

    #[msg("Requested leverage exceeds the market's max leverage")]
    ExceedsMaxLeverage,

    #[msg("Resulting position would be below the initial margin requirement")]
    BelowInitialMargin,

    #[msg("Not enough collateral for this action")]
    InsufficientCollateral,

    #[msg("Withdrawal would push the position below the minimum margin ratio")]
    WithdrawalBreaksMargin,

    #[msg("Position does not have enough size to close this amount")]
    InsufficientPositionSize,

    #[msg("Resulting position notional is below the protocol minimum")]
    PositionTooSmall,

    #[msg("Position is still above the maintenance margin ratio, cannot be liquidated")]
    PositionHealthy,

    #[msg("Position must be flat before its account can be closed")]
    PositionNotFlat,

    // --- market limits ------------------------------------------------------
    #[msg("Trade would exceed the market's open interest cap")]
    OpenInterestCapExceeded,

    #[msg("Trade would push open interest imbalance beyond the market's skew cap")]
    SkewCapExceeded,

    #[msg("Provided vault account does not match the market's configured vault")]
    VaultMismatch,

    #[msg("Vault does not hold enough to cover this payout")]
    VaultInsolvent,

    // --- parameter validation ----------------------------------------------
    #[msg("Max leverage must be between 1x and 20x")]
    InvalidLeverageParam,

    #[msg("Min margin ratio must be between 1% and 50%")]
    InvalidMarginParam,

    #[msg("Funding interval is outside the permitted range")]
    InvalidFundingInterval,

    #[msg("Funding sensitivity is outside the permitted range")]
    InvalidFundingSensitivity,

    #[msg("Fee exceeds the protocol maximum")]
    InvalidFeeParam,

    #[msg("Liquidation penalty exceeds the protocol maximum")]
    InvalidPenaltyParam,

    #[msg("Funding interval has not elapsed yet")]
    FundingNotDue,

    // --- arithmetic ---------------------------------------------------------
    #[msg("Arithmetic overflow or underflow")]
    MathOverflow,

    #[msg("Division by zero")]
    DivideByZero,

    #[msg("Expected a non-negative amount")]
    NegativeAmount,
}
