/**
 * Live monitoring for a stock-quoted DBC pool.
 *
 * A USDC-quoted pool needs one number: how full is the curve. A stock-quoted
 * pool needs three, because its denominator moves:
 *
 * 1. Progress toward graduation, in **quote tokens** — what DBC actually
 *    measures, and the only one that decides when migration fires.
 * 2. The same progress in **dollars** — what the issuer promised, and what has
 *    drifted since launch.
 * 3. The **session state of the underlying**, because a pool whose quote asset
 *    is shut is a pool trading on a stale price.
 *
 * A monitor that reports only (1) will tell an issuer they are 80% of the way
 * to a $50,000 raise on the day that raise silently became $41,000.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";

import { MarketSession, StockQuote } from "./types";
import { toUsd } from "./plan";

export interface PoolHealth {
  pool: string;
  /** 0–1, as DBC measures it: quote tokens raised over the threshold. */
  progress: number;
  /** Quote tokens (shares) raised so far. */
  raisedQuoteTokens: number;
  /** Quote tokens still required. */
  remainingQuoteTokens: number;
  /** What has been raised, in dollars at today's price. */
  raisedUsd: number;
  /** What the graduation threshold is worth in dollars *today*. */
  currentTargetUsd: number;
  /** What it was worth at launch, if known. */
  originalTargetUsd?: number;
  /** Signed drift of the dollar target since launch, as a fraction. */
  targetDriftPct?: number;
  session: MarketSession;
  /** True when the pool is trading against a frozen quote price. */
  quotePriceStale: boolean;
  warnings: string[];
}

/**
 * Fetch a pool and assess it against its underlying.
 *
 * `originalTargetUsd` is what the issuer signed up for. Passing it is what
 * turns the report from a progress bar into the answer to "is this still the
 * raise we planned?".
 */
export async function assessPool(
  connection: Connection,
  poolAddress: PublicKey | string,
  stock: StockQuote,
  originalTargetUsd?: number,
): Promise<PoolHealth> {
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const key =
    typeof poolAddress === "string" ? new PublicKey(poolAddress) : poolAddress;

  const pool = await client.state.getPool(key);
  if (!pool) throw new Error(`no DBC pool at ${key.toBase58()}`);

  const [progress, thresholdRaw] = await Promise.all([
    client.state.getPoolQuoteTokenCurveProgress(key),
    client.state.getPoolMigrationQuoteThreshold(key),
  ]);

  const unit = 10 ** stock.decimals;
  const thresholdQuoteTokens = Number(thresholdRaw.toString()) / unit;
  const raisedQuoteTokens = thresholdQuoteTokens * progress;

  const currentTargetUsd = toUsd(thresholdQuoteTokens, stock);
  const raisedUsd = toUsd(raisedQuoteTokens, stock);

  const targetDriftPct =
    originalTargetUsd && originalTargetUsd > 0
      ? (currentTargetUsd - originalTargetUsd) / originalTargetUsd
      : undefined;

  const quotePriceStale = stock.session !== MarketSession.Open;
  const warnings: string[] = [];

  if (quotePriceStale) {
    warnings.push(
      `${stock.symbol} is ${stock.session.toLowerCase()}: this pool is filling against a ` +
        `quote price that has not moved since the last print. Fills here carry the ` +
        `unpriced gap to the next open.`,
    );
  }

  if (targetDriftPct !== undefined && Math.abs(targetDriftPct) > 0.1) {
    const dir = targetDriftPct > 0 ? "risen" : "fallen";
    warnings.push(
      `Graduation target has ${dir} ${Math.abs(targetDriftPct * 100).toFixed(1)}% since ` +
        `launch: $${Math.round(originalTargetUsd!).toLocaleString()} → ` +
        `$${Math.round(currentTargetUsd).toLocaleString()}. The threshold is fixed in ` +
        `${stock.symbol} shares, so the dollar goal moved with the stock, not with demand.`,
    );
  }

  if (progress >= 1) {
    warnings.push(
      `Curve is full and will migrate on the next trigger. Migration is permissionless ` +
        `and has no oracle gate, so it can fire while ${stock.symbol} is shut — the ` +
        `initial DAMM v2 price would then be set from a stale quote. Prefer triggering ` +
        `it yourself during a live session.`,
    );
  } else if (progress > 0.9 && quotePriceStale) {
    warnings.push(
      `Curve is ${(progress * 100).toFixed(1)}% full while ${stock.symbol} is shut. ` +
        `It may graduate before the next open — watch it, or the migration price is set ` +
        `off a frozen quote.`,
    );
  }

  return {
    pool: key.toBase58(),
    progress,
    raisedQuoteTokens,
    remainingQuoteTokens: Math.max(thresholdQuoteTokens - raisedQuoteTokens, 0),
    raisedUsd,
    currentTargetUsd,
    originalTargetUsd,
    targetDriftPct,
    session: stock.session,
    quotePriceStale,
    warnings,
  };
}
