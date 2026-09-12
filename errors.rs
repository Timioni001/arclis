use anchor_lang::prelude::*;

#[error_code]
pub enum PerpError {
    #[msg("Only the global authority can perform this action")]
    Unauthorized,

    #[msg("The protocol is currently paused")]
    ProtocolPaused,

    #[msg("This market is currently paused")]
    MarketPaused,

    #[msg("Oracle price is stale, refuse to trade or liquidate")]
    StaleOracle,

    #[msg("Oracle price must be a positive value")]
    InvalidOraclePrice,

    #[msg("Position size cannot be zero")]
    ZeroSize,

    #[msg("Requested leverage exceeds the market's max leverage")]
    ExceedsMaxLeverage,

    #[msg("Not enough collateral for this action")]
    InsufficientCollateral,

    #[msg("Withdrawal would push the position below the minimum margin ratio")]
    WithdrawalBreaksMargin,

    #[msg("Position does not have enough size to close this amount")]
    InsufficientPositionSize,

    #[msg("Position is still above the maintenance margin ratio, cannot be liquidated")]
    PositionHealthy,

    #[msg("Arithmetic overflow or underflow")]
    MathOverflow,

    #[msg("Funding interval has not elapsed yet")]
    FundingNotDue,

    #[msg("Max leverage must be between 1x and 20x")]
    InvalidLeverageParam,

    #[msg("Min margin ratio must be between 1% and 50%")]
    InvalidMarginParam,

    #[msg("Provided oracle account does not match the market's configured oracle")]
    OracleMismatch,

    #[msg("Provided vault account does not match the market's configured vault")]
    VaultMismatch,
}
