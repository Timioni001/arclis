/**
 * The Arclis read model.
 *
 * Mirrors the on-chain accounts in `docs/ARCHITECTURE.md`. Every field keeps the
 * protocol's own scale - sizes at 1e6, prices at 1e6, quote at 1e6 - and is a
 * `bigint`, because a position's notional in raw units overflows a JS `number`
 * long before it overflows the `u64` on-chain.
 *
 * Conversion to shares and dollars happens once, at the display boundary, in
 * `format.ts`. DESIGN.md §36: raw protocol integer scales are never the primary
 * user-facing representation.
 */

/** Trading state of the underlying venue. Mirrors `math::session::MarketSession`. */
export type MarketSession = "Open" | "Closed" | "PreOpen" | "Halted";

/** What the caller intends to do with a price. Mirrors `math::session::PriceUse`. */
export type PriceUse = "IncreaseRisk" | "ReduceRisk";

export interface Oracle {
  address: string;
  symbol: string;
  /** Company name, resolved off-chain from the symbol. */
  name: string;
  /** Price at PRICE_SCALE (1e6). */
  price: bigint;
  /** Half-width of the confidence interval, at PRICE_SCALE. */
  confidence: bigint;
  lastUpdateTs: number;
  session: MarketSession;
  sessionUpdatedTs: number;
  /** Cumulative shares per original share, at 1e9. 1e9 == never split. */
  splitFactor: bigint;
  corporateActionSeq: number;
  /** Next regular-session open, unix seconds. Off-chain calendar data. */
  nextOpenTs: number;
  nextCloseTs: number;
}

export interface Market {
  address: string;
  oracle: string;
  vault: string;
  liquidityPool: string;
  paused: boolean;

  maxLeverage: number;
  maintenanceMarginBps: number;
  initialMarginBps: number;
  takerFeeBps: number;
  liquidationPenaltyBps: number;
  fundingSensitivityBps: number;

  fundingIntervalSecs: number;
  lastFundingTs: number;
  /** Cumulative quote owed per base unit, at 1e9. */
  cumulativeFundingIndex: bigint;

  /** Base units at 1e6. */
  openInterestLong: bigint;
  openInterestShort: bigint;
  /** Running sum of |size| * entry_price. Raw product, not pre-divided. */
  longEntryNotional: bigint;
  shortEntryNotional: bigint;
  maxOpenInterest: bigint;
  maxSkewBps: number;
  maxUtilizationBps: number;

  totalCollateral: bigint;
  insuranceBalance: bigint;
  badDebt: bigint;
}

export interface Position {
  address: string;
  owner: string;
  market: string;
  /** Signed base size at 1e6. Positive long, negative short. */
  size: bigint;
  entryPrice: bigint;
  collateral: bigint;
  entryFundingIndex: bigint;
  /** Split factor when last touched. Differs from the oracle's if stale. */
  entrySplitFactor: bigint;
  lastUpdateTs: number;
}

export interface LiquidityPool {
  address: string;
  market: string;
  vault: string;
  /** Live token balance of the LP vault. NAV is derived from this, not from principal. */
  vaultBalance: bigint;
  totalShares: bigint;
  principal: bigint;
  realizedPnl: bigint;
  absorbedBadDebt: bigint;
  cooldownSecs: number;
  pendingShares: bigint;
  depositsPaused: boolean;
}

export interface LpPosition {
  address: string;
  owner: string;
  pool: string;
  shares: bigint;
  pendingShares: bigint;
  cooldownEndsTs: number;
  lastDepositTs: number;
}

export interface Treasury {
  address: string;
  authority: string;
  agentMint: string;
  agentName: string;
  stockMint: string;
  market: string;
  /** Base units of stock held outright, at 1e6. */
  stockQty: bigint;
  tokensOutstanding: bigint;
  hedgeRatioBps: number;
  rebalanceToleranceBps: number;
  hedgingEnabled: boolean;
  lastNavPerToken: bigint;
  lastNavTs: number;
}

export interface CorporateAction {
  ts: number;
  symbol: string;
  numerator: number;
  denominator: number;
  priceBefore: bigint;
  priceAfter: bigint;
  sequence: number;
}

export type ActivityKind =
  | "PositionOpened"
  | "PositionClosed"
  | "CollateralDeposited"
  | "CollateralWithdrawn"
  | "FundingAccrued"
  | "PositionLiquidated"
  | "LiquidityDeposited"
  | "LiquidityWithdrawn"
  | "SessionChanged"
  | "CorporateActionApplied"
  | "TreasuryHedgeRebalanced";

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  ts: number;
  symbol?: string;
  summary: string;
  detail?: string;
  signature?: string;
}

/** A single OHLC bar, in protocol price scale. */
export interface Candle {
  t: number;
  o: bigint;
  h: bigint;
  l: bigint;
  c: bigint;
  v: bigint;
}

/** Everything one market screen needs, joined. */
export interface MarketView {
  market: Market;
  oracle: Oracle;
  pool: LiquidityPool;
  candles: Candle[];
  /**
   * The prints the candles were bucketed from, when the source has them.
   *
   * A chart with timeframe tabs cannot work from candles alone. Bucket width
   * is chosen for the whole series, so slicing the last N of those bars gives
   * a 1H tab and a 1W tab the same bar width and a different bar count, which
   * is not what either label claims. Re-bucketing the prints inside the chosen
   * window is the only way the tabs mean what they say.
   */
  points?: PricePoint[];
  /** 24h stats, derived off-chain from the event stream. */
  volume24h: bigint;
  changePct24h: number;
}

/** One published price, as the oracle stamped it. */
export interface PricePoint {
  /** Unix seconds, from the cluster. */
  t: number;
  price: bigint;
}

/** The transaction lifecycle every on-chain action moves through. DESIGN.md §27. */
export type TxStage =
  | "idle"
  | "review"
  | "walletConfirm"
  | "submitting"
  | "confirming"
  | "confirmed"
  | "failed";
