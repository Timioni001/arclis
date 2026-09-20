/**
 * The Arclis read-model maths, ported from `programs/arclis/src/math/`.
 *
 * Every function here has a Rust counterpart, and `math.test.ts` asserts they
 * agree on the same worked examples the Rust tests use. That matters more than
 * it sounds: a frontend that computes margin slightly differently from the
 * program will show a position as healthy right up until it is liquidated.
 *
 * `bigint` throughout, because a notional in raw protocol units passes
 * `Number.MAX_SAFE_INTEGER` at around $9m and silently loses precision after.
 */

export const BASE_SCALE = 1_000_000n;
export const PRICE_SCALE = 1_000_000n;
export const QUOTE_SCALE = 1_000_000n;
export const FUNDING_INDEX_SCALE = 1_000_000_000n;
export const SPLIT_FACTOR_SCALE = 1_000_000_000n;
export const BPS_SCALE = 10_000n;

/** Division truncating toward zero, matching Rust's integer `/`. */
function divTrunc(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("divide by zero");
  return a / b;
}

/** Division rounding toward negative infinity. Mirrors `fixed::mul_div_floor`. */
function divFloor(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("divide by zero");
  const q = a / b;
  const r = a % b;
  return r !== 0n && r < 0n !== b < 0n ? q - 1n : q;
}

export function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

// ---------------------------------------------------------------------------
// Position valuation: math/pnl.rs
// ---------------------------------------------------------------------------

/** Quote value of a position: `|size| * price / PRICE_SCALE`. Never negative. */
export function notional(size: bigint, price: bigint): bigint {
  return divTrunc(abs(size) * price, PRICE_SCALE);
}

/**
 * Unrealised PnL in quote units. The sign of `size` handles both directions:
 * a short profits when the mark falls because both factors are negative.
 */
export function unrealizedPnl(
  size: bigint,
  entryPrice: bigint,
  markPrice: bigint,
): bigint {
  return divTrunc(size * (markPrice - entryPrice), PRICE_SCALE);
}

/**
 * Funding owed since the position last settled. Positive means the trader pays.
 * Floors, so a charge is never rounded down in the payer's favour.
 */
export function fundingOwed(
  size: bigint,
  entryFundingIndex: bigint,
  marketFundingIndex: bigint,
): bigint {
  return divFloor(
    size * (marketFundingIndex - entryFundingIndex),
    FUNDING_INDEX_SCALE,
  );
}

/**
 * Collateral, marked to market, net of unsettled funding.
 *
 * Forgetting the funding term is the single easiest way for a frontend to show
 * a position as healthier than the program considers it.
 */
export function equity(
  collateral: bigint,
  size: bigint,
  entryPrice: bigint,
  markPrice: bigint,
  entryFundingIndex: bigint,
  marketFundingIndex: bigint,
): bigint {
  return (
    collateral +
    unrealizedPnl(size, entryPrice, markPrice) -
    fundingOwed(size, entryFundingIndex, marketFundingIndex)
  );
}

/** Margin ratio in bps. A flat position has infinite margin, not an error. */
export function marginRatioBps(
  equityValue: bigint,
  notionalValue: bigint,
): bigint | null {
  if (notionalValue === 0n) return null;
  return divTrunc(equityValue * BPS_SCALE, notionalValue);
}

/** Fee on a notional, rounded up so the protocol never under-charges. */
export function feeOnNotional(notionalValue: bigint, feeBps: number): bigint {
  if (feeBps === 0) return 0n;
  const num = notionalValue * BigInt(feeBps);
  return divTrunc(num + BPS_SCALE - 1n, BPS_SCALE);
}

/**
 * The mark price at which this position hits maintenance margin.
 *
 * Solving `equity(P) / notional(P) == mm` for P, with
 * `equity(P) = collateral + size*(P - entry)/S - funding` and
 * `notional(P) = |size|*P/S`:
 *
 *     P = (funding - collateral + size*entry/S) / (size/S - mm*|size|/S)
 *
 * Returns null when the position cannot be liquidated by price alone - a flat
 * position, or a short so over-collateralised that no finite price reaches the
 * threshold.
 */
export function liquidationPrice(
  collateral: bigint,
  size: bigint,
  entryPrice: bigint,
  entryFundingIndex: bigint,
  marketFundingIndex: bigint,
  maintenanceMarginBps: number,
): bigint | null {
  if (size === 0n) return null;
  const mm = BigInt(maintenanceMarginBps);
  const funding = fundingOwed(size, entryFundingIndex, marketFundingIndex);

  // Work in bps-scaled numerators to keep everything integral.
  const numerator =
    (funding - collateral) * BPS_SCALE +
    (size * entryPrice * BPS_SCALE) / PRICE_SCALE;
  const denominator = (size * BPS_SCALE - mm * abs(size)) / PRICE_SCALE;
  if (denominator === 0n) return null;

  const price = numerator / denominator;
  return price > 0n ? price : null;
}

// ---------------------------------------------------------------------------
// Funding: math/funding.rs
// ---------------------------------------------------------------------------

/** Open-interest skew in bps, positive when longs dominate. Bounded to ±10000. */
export function skewBps(oiLong: bigint, oiShort: bigint): bigint {
  const total = oiLong + oiShort;
  if (total === 0n) return 0n;
  return divTrunc((oiLong - oiShort) * BPS_SCALE, total);
}

export const MAX_FUNDING_RATE_BPS_PER_INTERVAL = 50n;
const UTILIZATION_FUNDING_MULTIPLIER_BPS = 10_000n;

/**
 * Per-interval funding rate, positive when longs pay shorts.
 *
 * Amplified by pool utilisation before the clamp: the same skew matters more
 * when it is consuming more of the pool's capital.
 */
export function fundingRateBps(
  skew: bigint,
  sensitivityBps: number,
  utilizationBps: bigint,
): bigint {
  const base = divTrunc(skew * BigInt(sensitivityBps), BPS_SCALE);
  const util =
    utilizationBps < 0n
      ? 0n
      : utilizationBps > UTILIZATION_FUNDING_MULTIPLIER_BPS
        ? UTILIZATION_FUNDING_MULTIPLIER_BPS
        : utilizationBps;
  const amplified = divTrunc(base * (BPS_SCALE + util), BPS_SCALE);
  const cap = MAX_FUNDING_RATE_BPS_PER_INTERVAL;
  return amplified > cap ? cap : amplified < -cap ? -cap : amplified;
}

// ---------------------------------------------------------------------------
// Liquidity pool: math/liquidity.rs
// ---------------------------------------------------------------------------

/**
 * Aggregate unrealised PnL across every open position. Positive means the pool
 * owes traders. This is the pool's mark-to-market liability.
 */
export function netTraderPnl(
  oiLong: bigint,
  longEntryNotional: bigint,
  oiShort: bigint,
  shortEntryNotional: bigint,
  markPrice: bigint,
): bigint {
  const longValue = divTrunc(oiLong * markPrice, PRICE_SCALE);
  const longCost = divTrunc(longEntryNotional, PRICE_SCALE);
  const shortValue = divTrunc(oiShort * markPrice, PRICE_SCALE);
  const shortCost = divTrunc(shortEntryNotional, PRICE_SCALE);
  return longValue - longCost + (shortCost - shortValue);
}

/** What the LP vault holds, less what it owes traders. May be negative. */
export function poolNav(vaultBalance: bigint, traderPnl: bigint): bigint {
  return vaultBalance - traderPnl;
}

/** Quote value of the imbalance the pool carries. Signed. */
export function netExposureNotional(
  oiLong: bigint,
  oiShort: bigint,
  markPrice: bigint,
): bigint {
  return divTrunc((oiLong - oiShort) * markPrice, PRICE_SCALE);
}

/** Exposure over NAV, in bps. `null` means exposure with no capital behind it. */
export function utilizationBps(exposure: bigint, nav: bigint): bigint | null {
  const e = abs(exposure);
  if (e === 0n) return 0n;
  if (nav <= 0n) return null;
  return divTrunc(e * BPS_SCALE, nav);
}

export function sharesForDeposit(
  amount: bigint,
  totalShares: bigint,
  nav: bigint,
): bigint {
  if (totalShares === 0n) return amount;
  if (nav <= 0n)
    throw new Error("pool NAV is not positive; shares cannot be priced");
  return divTrunc(amount * totalShares, nav);
}

export function amountForShares(
  shares: bigint,
  totalShares: bigint,
  nav: bigint,
): bigint {
  if (totalShares === 0n || shares === 0n) return 0n;
  if (nav <= 0n)
    throw new Error("pool NAV is not positive; shares cannot be priced");
  return divTrunc(nav * shares, totalShares);
}

/**
 * The most an LP may redeem without pushing utilisation past the cap.
 *
 * A matured request can still be capped by this: the pool keeps its promise to
 * traders before its promise to LPs, and the UI has to say so before someone
 * queues a withdrawal they cannot complete.
 */
export function maxWithdrawable(
  nav: bigint,
  exposure: bigint,
  maxUtilizationBps: number,
): bigint {
  if (nav <= 0n) return 0n;
  const e = abs(exposure);
  if (e === 0n) return nav;
  if (maxUtilizationBps === 0) return 0n;
  const required = divTrunc(e * BPS_SCALE, BigInt(maxUtilizationBps));
  const free = nav - required;
  return free > 0n ? free : 0n;
}

// ---------------------------------------------------------------------------
// Treasury: math/treasury.rs
// ---------------------------------------------------------------------------

export interface TreasuryExposure {
  stockValue: bigint;
  perpEquity: bigint;
  netDelta: bigint;
  nav: bigint;
}

export function treasuryExposure(
  stockQty: bigint,
  perpSize: bigint,
  perpCollateral: bigint,
  perpEntryPrice: bigint,
  perpEntryFundingIndex: bigint,
  marketFundingIndex: bigint,
  markPrice: bigint,
): TreasuryExposure {
  const stockValue = divTrunc(stockQty * markPrice, PRICE_SCALE);
  const perpEquity = equity(
    perpCollateral,
    perpSize,
    perpEntryPrice,
    markPrice,
    perpEntryFundingIndex,
    marketFundingIndex,
  );
  return {
    stockValue,
    perpEquity,
    netDelta: stockQty + perpSize,
    nav: stockValue + perpEquity,
  };
}

export function targetDelta(stockQty: bigint, hedgeRatioBps: number): bigint {
  return divTrunc(stockQty * (BPS_SCALE - BigInt(hedgeRatioBps)), BPS_SCALE);
}

export function navPerToken(nav: bigint, tokensOutstanding: bigint): bigint {
  if (tokensOutstanding === 0n || nav <= 0n) return 0n;
  return divTrunc(nav * QUOTE_SCALE, tokensOutstanding);
}

// ---------------------------------------------------------------------------
// Corporate actions: math/corporate_actions.rs
// ---------------------------------------------------------------------------

/**
 * Normalise a position that slept through one or more splits.
 *
 * Positions rescale lazily on-chain, so a freshly read account can still hold
 * pre-split numbers. A UI that renders them raw shows the wrong share count and
 * the wrong entry price until the next time the trader touches the position.
 */
export function normalizeForSplits(
  size: bigint,
  entryPrice: bigint,
  entryFundingIndex: bigint,
  positionSplitFactor: bigint,
  oracleSplitFactor: bigint,
): { size: bigint; entryPrice: bigint; entryFundingIndex: bigint } {
  if (positionSplitFactor === oracleSplitFactor || positionSplitFactor === 0n) {
    return { size, entryPrice, entryFundingIndex };
  }
  const from = positionSplitFactor;
  const to = oracleSplitFactor;
  return {
    size: divTrunc(size * to, from),
    entryPrice: divTrunc(entryPrice * from, to),
    entryFundingIndex: divTrunc(entryFundingIndex * from, to),
  };
}

/** Rescale a historical price into today's post-split terms, for charting. */
export function rescaleHistoricalPrice(
  price: bigint,
  factorThen: bigint,
  factorNow: bigint,
): bigint {
  if (factorNow === 0n) return price;
  return divTrunc(price * factorThen, factorNow);
}
