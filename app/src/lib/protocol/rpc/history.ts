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
import type { Candle, PricePoint } from "../types";

// Re-exported so every caller keeps importing it from here, where the code
// that produces prints lives, while the single definition sits with the rest
// of the read model in `types.ts`.
export type { PricePoint } from "../types";

/**
 * The IDL spells this `update_price_oracle`, and a raw `BorshCoder` returns
 * names exactly as the IDL spells them - it does not camelCase the way
 * `Program` does. Getting this wrong is silent: every instruction fails the
 * comparison, the history comes back empty, and the chart renders its "no
 * data" state as though the chain had nothing to say.
 */
const PUBLISH_IX = "update_price_oracle";

/** Signatures per request. The RPC maximum, and one batched fetch each. */
export const PAGE_SIZE = 200;
/**
 * Stop once the chart has this much to draw.
 *
 * Not a hard limit on history, a floor on usefulness: paging continues only
 * while the series is still too short to be a chart.
 */
export const TARGET_POINTS = 60;
/** A ceiling on effort, so a busy oracle cannot turn this into a crawl. */
export const MAX_PAGES = 5;

export interface HistoryOptions {
  targetPoints?: number;
  maxPages?: number;
  pageSize?: number;
}

/**
 * # Why this pages instead of taking the most recent 200 signatures
 *
 * `getSignaturesForAddress` returns every transaction that *mentions* the
 * oracle, and publishing prices is a small minority of those. `crank_funding`
 * names the oracle as a read-only account and runs once a minute per symbol,
 * so the stream is mostly funding cranks; a single page of 200 covers roughly
 * three hours and can contain no price change whatsoever.
 *
 * That is exactly what happened: overnight, with the market closed and the
 * keeper correctly publishing nothing new, every publish inside the window
 * carried the same price and the chart drew one flat line across the screen.
 * The prices before it - a real 48% move - were three pages back.
 *
 * So it pages until the series is long enough to be worth drawing, and stops
 * early the moment it is. A quiet oracle needs one page; a busy one pays for
 * a few more, once per session.
 */
export async function fetchPriceHistory(
  connection: Connection,
  oracle: PublicKey,
  programId: PublicKey,
  options: HistoryOptions = {},
): Promise<PricePoint[]> {
  const targetPoints = options.targetPoints ?? TARGET_POINTS;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const pageSize = options.pageSize ?? PAGE_SIZE;

  const points: PricePoint[] = [];
  let before: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const signatures = await connection.getSignaturesForAddress(oracle, {
      limit: pageSize,
      before,
    });
    if (signatures.length === 0) break;
    // Page from the oldest signature returned, error or not: skipping a failed
    // one here would make the next page start in the wrong place and silently
    // re-read ground already covered.
    before = signatures[signatures.length - 1].signature;

    const usable = signatures.filter((s) => !s.err).map((s) => s.signature);
    if (usable.length > 0) {
      const transactions = await connection.getParsedTransactions(usable, {
        maxSupportedTransactionVersion: 0,
      });
      for (const tx of transactions) {
        if (!tx || tx.meta?.err || tx.blockTime == null) continue;
        for (const ix of tx.transaction.message.instructions) {
          // A parsed instruction (system, SPL token) has `parsed` and no
          // `data`. Ours is never parsed: the cluster has no parser for it.
          if (!("data" in ix)) continue;
          if (!ix.programId.equals(programId)) continue;

          let decoded: { name: string; data: unknown } | null = null;
          try {
            decoded = coder.instruction.decode(ix.data, "base58");
          } catch {
            // Another instruction of ours, or one from a version of the
            // program this IDL predates. Neither is worth surfacing.
            continue;
          }
          if (!decoded || decoded.name !== PUBLISH_IX) continue;

          const price = (decoded.data as { price?: { toString(): string } })
            .price;
          if (price == null) continue;
          points.push({ t: tx.blockTime, price: BigInt(price.toString()) });
        }
      }
    }

    if (points.length >= targetPoints) break;
    // A short page is the end of the account's history, not a quiet patch.
    if (signatures.length < pageSize) break;
  }

  // Signatures come back newest first; a chart reads left to right.
  points.sort((a, b) => a.t - b.t);
  return points;
}

/** How many candles a chart wants, regardless of how much history exists. */
export const TARGET_CANDLES = 96;
/** Never bucket finer than this, whatever the arithmetic below says. */
export const MIN_BUCKET_SECS = 30;

/**
 * How many prints a bar needs before it is a bar.
 *
 * This is the constant the chart was missing, and the reason it drew as a row
 * of disconnected dashes at different heights rather than as candles.
 *
 * A candlestick is four numbers, and all four come from the prints that fall
 * inside its bucket. Give a bucket one print and open, high, low and close are
 * that one price: a doji with no wicks, drawn as a two-pixel horizontal line.
 * A whole series of those is not a broken renderer, it is a correct rendering
 * of buckets that each hold a single price.
 *
 * The old bucket width came only from the span: an hour of history over 96
 * target candles is a 37-second bucket, against a keeper publishing every 60
 * seconds. Every bucket got exactly one print, so every candle was a doji,
 * every time, and no amount of restyling would have changed it.
 *
 * So the bucket is also held to a multiple of the observed publish cadence.
 * Four prints a bar gives a body and wicks that mean something, at the cost of
 * a quarter as many bars, which is the right side of that trade: fifteen real
 * candles beat sixty dashes.
 */
export const MIN_PRINTS_PER_CANDLE = 4;

/**
 * The typical gap between prints, in seconds.
 *
 * The median rather than the mean, because the series has outliers by
 * construction: a market closes and the next print is fifteen hours later.
 * One overnight gap would drag a mean wide enough to bucket a whole session
 * into one bar.
 */
export function printCadence(points: PricePoint[]): number {
  if (points.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].t - points[i - 1].t;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Bucket prints into OHLC candles.
 *
 * The bucket width is derived rather than fixed, because the span is whatever
 * the keeper has had time to publish: a chart of ten minutes of history and a
 * chart of three weeks both have to look like a chart. A fixed 1h bucket would
 * draw the first as a single bar.
 *
 * It is derived from two things, not one. The span sets an upper bound on how
 * many bars are useful; the publish cadence sets a lower bound on how wide a
 * bar has to be to hold enough prints to have a shape. See
 * `MIN_PRINTS_PER_CANDLE`.
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
  const bucket = Math.max(
    MIN_BUCKET_SECS,
    printCadence(points) * MIN_PRINTS_PER_CANDLE,
    Math.ceil(span / TARGET_CANDLES),
  );

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
