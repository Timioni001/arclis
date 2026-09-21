/**
 * Price history, read back out of the transactions that published it.
 *
 * # Why this is not read from an event
 *
 * The obvious source would be a `PriceUpdated` event and a log scan. The
 * program does not emit one: `update_price_oracle` writes the account and
 * returns, and the only price-bearing event is `SessionChanged`, which fires
 * on a session transition rather than on a print. Adding the event is the
 * right long-term fix and it costs a program redeploy, which is not a thing
 * to do the week of a demo.
 *
 * So the history is reconstructed from the instruction data instead. Every
 * publish is an `update_price_oracle(price, confidence)` against the oracle
 * PDA, the arguments are on-chain in the transaction, and `blockTime` is the
 * cluster's own timestamp for it. That is the same information an event would
 * have carried, taken from the record that already exists.
 *
 * # Why it costs two requests rather than two hundred
 *
 * `getSignaturesForAddress` is one call, and `getParsedTransactions` takes
 * the whole list and issues a batched JSON-RPC request rather than one per
 * signature. On a shared devnet endpoint being polled by every visitor, the
 * difference between 2 requests and 200 is the difference between working and
 * being rate limited.
 *
 * It is still not free, so `source.ts` backfills once per session and extends
 * the series from the prices it is already polling.
 */

import type { Connection, PublicKey } from "@solana/web3.js";
import { coder } from "./decode";
import type { Candle } from "../types";

/** One published print. */
export interface PricePoint {
  /** Unix seconds, from the cluster. */
  t: number;
  price: bigint;
}

/**
 * The IDL spells this `update_price_oracle`, and a raw `BorshCoder` returns
 * names exactly as the IDL spells them - it does not camelCase the way
 * `Program` does. Getting this wrong is silent: every instruction fails the
 * comparison, the history comes back empty, and the chart renders its "no
 * data" state as though the chain had nothing to say.
 */
const PUBLISH_IX = "update_price_oracle";

/** Cap the scan. Enough for a chart, small enough to stay one batch. */
export const DEFAULT_HISTORY_LIMIT = 200;

export async function fetchPriceHistory(
  connection: Connection,
  oracle: PublicKey,
  programId: PublicKey,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<PricePoint[]> {
  const signatures = await connection.getSignaturesForAddress(oracle, {
    limit,
  });
  const usable = signatures.filter((s) => !s.err).map((s) => s.signature);
  if (usable.length === 0) return [];

  const transactions = await connection.getParsedTransactions(usable, {
    maxSupportedTransactionVersion: 0,
  });

  const points: PricePoint[] = [];
  for (const tx of transactions) {
    if (!tx || tx.meta?.err || tx.blockTime == null) continue;
    for (const ix of tx.transaction.message.instructions) {
      // A parsed instruction (system, SPL token) has `parsed` and no `data`.
      // Ours is never parsed, because the cluster has no parser for it.
      if (!("data" in ix)) continue;
      if (!ix.programId.equals(programId)) continue;

      let decoded: { name: string; data: unknown } | null = null;
      try {
        decoded = coder.instruction.decode(ix.data, "base58");
      } catch {
        // Another instruction of ours, or one from a version of the program
        // this IDL predates. Neither is an error worth surfacing.
        continue;
      }
      if (!decoded || decoded.name !== PUBLISH_IX) continue;

      const price = (decoded.data as { price?: { toString(): string } }).price;
      if (price == null) continue;
      points.push({ t: tx.blockTime, price: BigInt(price.toString()) });
    }
  }

  // Signatures come back newest first; a chart reads left to right.
  points.sort((a, b) => a.t - b.t);
  return points;
}

/** How many candles a chart wants, regardless of how much history exists. */
const TARGET_CANDLES = 96;
/** Never bucket finer than this: the keeper publishes about every 10s. */
const MIN_BUCKET_SECS = 30;

/**
 * Bucket prints into OHLC candles.
 *
 * The bucket width is derived from the span rather than fixed, because the
 * span is whatever the keeper has had time to publish: a chart of ten minutes
 * of history and a chart of three weeks both have to look like a chart. A
 * fixed 1h bucket would draw the first as a single bar.
 *
 * Volume is zero and stays zero. It is not in this data - a price publish
 * carries no size - and drawing a volume bar from something else would be
 * inventing it. The chart handles an all-zero series.
 */
export function candlesFrom(points: PricePoint[]): Candle[] {
  if (points.length === 0) return [];
  if (points.length === 1) {
    const { t, price } = points[0];
    return [{ t, o: price, h: price, l: price, c: price, v: 0n }];
  }

  const span = points[points.length - 1].t - points[0].t;
  const bucket = Math.max(MIN_BUCKET_SECS, Math.ceil(span / TARGET_CANDLES));

  const candles: Candle[] = [];
  let current: Candle | null = null;
  let currentKey = -1;

  for (const { t, price } of points) {
    const key = Math.floor(t / bucket);
    if (current === null || key !== currentKey) {
      if (current) candles.push(current);
      current = {
        t: key * bucket,
        o: price,
        h: price,
        l: price,
        c: price,
        v: 0n,
      };
      currentKey = key;
      continue;
    }
    current.c = price;
    if (price > current.h) current.h = price;
    if (price < current.l) current.l = price;
  }
  if (current) candles.push(current);
  return candles;
}

/**
 * Add a freshly polled price to a series.
 *
 * The backfill is one request and runs once; after that the interface is
 * already reading the oracle every refresh, so extending the series costs
 * nothing. Duplicate timestamps are dropped - the oracle's `updated_ts` does
 * not move between publishes, and appending the same print repeatedly would
 * draw a flat line out of a still market.
 */
export function appendPoint(
  points: PricePoint[],
  point: PricePoint,
  cap = 4000,
): PricePoint[] {
  const last = points[points.length - 1];
  if (last && last.t >= point.t) return points;
  const next = points.concat(point);
  return next.length > cap ? next.slice(next.length - cap) : next;
}
