/**
 * Types for configuring a Meteora DBC pool whose **quote token is a tokenized
 * stock**.
 *
 * DBC was built for launches quoted in SOL or USDC — assets that trade 24/7 and
 * whose price the issuer treats as the unit of account. A stock-quoted launch
 * breaks both assumptions, and every type in this file exists because of one of
 * them.
 */

/** Market session of the underlying venue. Mirrors the on-chain enum in `math::session`. */
export enum MarketSession {
  Closed = "Closed",
  PreOpen = "PreOpen",
  Open = "Open",
  Halted = "Halted",
}

/**
 * The tokenized stock a pool is quoted in, and what it is currently worth.
 *
 * `priceUsd` is the whole problem in one field. Every threshold DBC stores is
 * denominated in quote tokens, so when the quote token is a share, the issuer's
 * dollar targets are only as stable as the share price.
 */
export interface StockQuote {
  /** Ticker of the underlying, e.g. "AAPL". */
  symbol: string;
  /** Mint of the tokenized stock used as the DBC quote token. */
  mint: string;
  /** Decimals of that mint. xStocks-style tokens are typically 8; USDC is 6. */
  decimals: number;
  /** Spot price of one share in USD. */
  priceUsd: number;
  /** Annualised volatility as a decimal, e.g. 0.28 for 28%. */
  annualVolatility: number;
  /** Current trading state of the underlying venue. */
  session: MarketSession;
  /** Unix seconds of the next regular-session open. */
  nextOpenUnix: number;
  /** Unix seconds of the next regular-session close. */
  nextCloseUnix: number;
}

/** What the issuer actually wants, expressed the way an issuer thinks: in dollars. */
export interface LaunchTargets {
  /** Fully-diluted valuation at the start of the curve, in USD. */
  initialMarketCapUsd: number;
  /** FDV at which the curve graduates into DAMM v2, in USD. */
  migrationMarketCapUsd: number;
  /** Total supply of the agent token. */
  totalTokenSupply: number;
  /** Base-token decimals for the launched token. */
  tokenDecimals: 6 | 7 | 8 | 9;
}

/** Knobs an issuer may want to override; every one has a defensible default. */
export interface StockCurveOptions {
  /**
   * Fee floor once price discovery is live, in bps. The schedule decays to
   * this; it never goes below.
   */
  baseFeeBps?: number;
  /**
   * Multiple of `baseFeeBps` to charge while the underlying venue is shut.
   * Defaults to 4x. See `planFeeSchedule` for why a premium is charged at all.
   */
  closedSessionFeeMultiple?: number;
  /** Hard ceiling on the starting fee, in bps. DBC's own maximum is 9900. */
  maxStartingFeeBps?: number;
  /** Share of trading fees routed to the token creator, 0–100. */
  creatorTradingFeePercentage?: number;
  /** Percentage of supply locked and vested after migration. */
  lockedVestingPercentage?: number;
}

/** A fee schedule, with the reasoning attached. */
export interface FeeSchedulePlan {
  startingFeeBps: number;
  endingFeeBps: number;
  numberOfPeriod: number;
  /** Seconds over which the starting fee decays to the ending fee. */
  totalDuration: number;
  /** Why these numbers, in one line, for the issuer to sanity-check. */
  rationale: string;
  /** True when the schedule is pricing an unpriced overnight gap. */
  pricesGapRisk: boolean;
}

/** How a fixed share-denominated threshold drifts in dollar terms. */
export interface GraduationDrift {
  /** Graduation threshold, in quote tokens (shares). Fixed once configured. */
  thresholdQuoteTokens: number;
  /** What that is worth in USD at today's price. */
  targetUsd: number;
  /** USD value of the same threshold if the stock moves down one sigma. */
  lowUsd: number;
  /** USD value if the stock moves up one sigma. */
  highUsd: number;
  /** The sigma horizon used, in days. */
  horizonDays: number;
  /** Width of the band as a fraction of the target. */
  bandWidthPct: number;
}
