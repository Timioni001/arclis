/**
 * The history reader, and the one thing about it that fails silently.
 *
 * `coder.instruction.decode` returns the instruction's name exactly as the
 * IDL spells it. A raw `BorshCoder` does not camelCase the way `Program`
 * does - which is how all five account decoders came to be broken, looking
 * for "market" where the IDL says "Market". The same trap is here: compare
 * against "updatePriceOracle" and every instruction fails the check, the
 * history comes back empty, and the chart draws its no-data state as though
 * the chain had nothing to say. Nothing throws.
 *
 * So the first test encodes a real instruction with the real coder and reads
 * the name back, rather than trusting either spelling.
 */
import { describe, expect, it } from "vitest";
// `BN` from Anchor, not from "bn.js" directly. bn.js ships no types of its
// own, so importing it here needs `@types/bn.js` - which this package does
// not depend on. It builds locally anyway because the repository root does,
// and TypeScript walks up out of `app/` to find it. Cloudflare's root
// directory is `app`, so the repo root is never installed there and the same
// build fails with TS7016. Anchor re-exports the same class, is a real
// dependency of this package, and hides the untyped import inside a `.d.ts`
// that `skipLibCheck` skips.
import { BN, utils } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { coder } from "./decode";
import {
  appendPoint,
  candlesFrom,
  fetchPriceHistory,
  printCadence,
  type PricePoint,
} from "./history";

describe("the publish instruction", () => {
  it("round-trips through the coder under the name the reader looks for", () => {
    const encoded = coder.instruction.encode("update_price_oracle", {
      price: new BN("22850000000"),
      confidence: new BN("1000000"),
    });
    const decoded = coder.instruction.decode(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe("update_price_oracle");
    expect((decoded!.data as { price: BN }).price.toString()).toBe(
      "22850000000",
    );
  });

  it("is not spelled the way Program would spell it", () => {
    // Guards the assumption rather than the code: if a future Anchor starts
    // camelCasing here, this fails and the reader needs updating with it.
    expect(() =>
      coder.instruction.encode("updatePriceOracle", {
        price: new BN(1),
        confidence: new BN(1),
      }),
    ).toThrow();
  });
});

const at = (t: number, price: number): PricePoint => ({
  t,
  price: BigInt(price),
});

describe("bucketing prints into candles", () => {
  it("returns nothing for no prints", () => {
    expect(candlesFrom([])).toEqual([]);
  });

  it("draws a single print as a flat candle rather than nothing", () => {
    const [candle] = candlesFrom([at(1000, 500)]);
    expect(candle).toMatchObject({ o: 500n, h: 500n, l: 500n, c: 500n });
  });

  it("takes open, high, low and close from the prints in each bucket", () => {
    // 200 prints over 200 * 60s, which is well past the 30s floor, so the
    // bucket width comes from the span and several prints share a bucket.
    const points = Array.from({ length: 200 }, (_, i) =>
      at(1_000_000 + i * 60, 100 + (i % 7)),
    );
    const candles = candlesFrom(points);

    expect(candles.length).toBeGreaterThan(1);
    expect(candles.length).toBeLessThanOrEqual(100);
    for (const c of candles) {
      expect(c.h).toBeGreaterThanOrEqual(c.l);
      expect(c.h).toBeGreaterThanOrEqual(c.o);
      expect(c.h).toBeGreaterThanOrEqual(c.c);
      expect(c.l).toBeLessThanOrEqual(c.o);
      expect(c.l).toBeLessThanOrEqual(c.c);
    }
    // The series must span the prints it was built from.
    expect(candles[0].o).toBe(points[0].price);
    expect(candles[candles.length - 1].c).toBe(points[points.length - 1].price);
  });

  it("does not collapse ten minutes of history into one bar", () => {
    // The span the demo actually starts with: a keeper that has been up for
    // minutes, not weeks. A fixed hourly bucket would draw this as one candle.
    const points = Array.from({ length: 60 }, (_, i) =>
      at(1_000_000 + i * 10, 100 + i),
    );
    expect(candlesFrom(points).length).toBeGreaterThan(5);
  });

  it("keeps candles in ascending time order", () => {
    const points = Array.from({ length: 50 }, (_, i) =>
      at(1_000_000 + i * 120, 100 + i),
    );
    const times = candlesFrom(points).map((c) => c.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("extending the series from live polls", () => {
  it("appends a newer print", () => {
    const out = appendPoint([at(10, 100)], at(20, 101));
    expect(out).toHaveLength(2);
    expect(out[1].price).toBe(101n);
  });

  it("drops a repeat of the same timestamp", () => {
    // The oracle's `updated_ts` does not move between publishes, so a poll
    // that lands twice on one print must not draw a flat line out of it.
    const points = [at(10, 100)];
    expect(appendPoint(points, at(10, 100))).toBe(points);
    expect(appendPoint(points, at(9, 100))).toBe(points);
  });

  it("appends to an empty series", () => {
    expect(appendPoint([], at(10, 100))).toHaveLength(1);
  });

  it("drops the oldest prints once it is full", () => {
    let points: PricePoint[] = [];
    for (let i = 0; i < 12; i++)
      points = appendPoint(points, at(i, 100 + i), 5);
    expect(points).toHaveLength(5);
    expect(points[0].t).toBe(7);
    expect(points[4].t).toBe(11);
  });
});

/* -------------------------------------------------------------------------
   Paging

   The chart drew one flat horizontal line across the screen, and the data was
   not wrong - it was just too recent. `getSignaturesForAddress` returns every
   transaction that *mentions* the oracle, and `crank_funding` names it as a
   read-only account once a minute per symbol. A single page of 200 is
   therefore mostly funding cranks, covers about three hours, and overnight -
   with the market closed and the keeper correctly publishing nothing new -
   contains no price change at all. The move was three pages further back.
   ------------------------------------------------------------------------- */

const PROGRAM = new PublicKey("BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP");
const ORACLE = new PublicKey("11111111111111111111111111111111");
const OTHER_PROGRAM = new PublicKey(
  "ComputeBudget111111111111111111111111111111",
);

/** A publish, encoded with the real coder and base58'd as an RPC returns it. */
function publishIx(price: number) {
  return {
    programId: PROGRAM,
    data: utils.bytes.bs58.encode(
      coder.instruction.encode("update_price_oracle", {
        price: new BN(price),
        confidence: new BN(1_000_000),
      }),
    ),
  };
}

/** A funding crank: our program, but not a publish. This is the noise. */
function crankIx() {
  return {
    programId: PROGRAM,
    data: utils.bytes.bs58.encode(
      coder.instruction.encode("crank_funding", {}),
    ),
  };
}

let clock = 1_790_000_000;
function tx(instructions: unknown[]) {
  return {
    blockTime: clock++,
    meta: { err: null },
    transaction: { message: { instructions } },
  };
}

/**
 * A connection whose pages are supplied in order. Records how many times it
 * was asked, so "stops early" is an assertion rather than a hope.
 */
function fakeConnection(pages: unknown[][]) {
  const calls = { signatures: 0, transactions: 0 };
  const connection = {
    async getSignaturesForAddress(_a: PublicKey, _opts: { limit: number }) {
      const page = pages[calls.signatures] ?? [];
      calls.signatures++;
      return page.map((_, i) => ({
        signature: `sig-${calls.signatures}-${i}`,
        err: null,
      }));
    },
    async getParsedTransactions(sigs: string[]) {
      const page = pages[calls.transactions] ?? [];
      calls.transactions++;
      return page.slice(0, sigs.length);
    },
  };
  return { connection, calls };
}

/** A page of pure noise: `size` funding cranks and nothing else. */
const noisePage = (size: number) =>
  Array.from({ length: size }, () => tx([crankIx()]));

describe("reading the publish history", () => {
  it("keeps paging past a page that holds no price change", async () => {
    // Page one: the overnight window - cranks, plus publishes all at one
    // price. Page two: the move.
    const flat = [
      ...noisePage(196),
      ...[0, 0, 0, 0].map(() => tx([publishIx(338_980_000)])),
    ];
    const moved = [
      tx([publishIx(228_500_000)]),
      tx([publishIx(250_207_500)]),
      tx([publishIx(273_977_212)]),
      ...noisePage(197),
    ];
    const { connection, calls } = fakeConnection([flat, moved]);

    const points = await fetchPriceHistory(
      connection as never,
      ORACLE,
      PROGRAM,
      { targetPoints: 6, pageSize: 200 },
    );

    expect(calls.signatures).toBe(2);
    const prices = new Set(points.map((p) => p.price));
    expect(prices.size).toBeGreaterThan(1);
    expect(points.length).toBe(7);
  });

  it("stops as soon as it has enough to draw", async () => {
    const rich = Array.from({ length: 200 }, (_, i) =>
      tx([publishIx(100_000_000 + i)]),
    );
    const { connection, calls } = fakeConnection([rich, rich, rich]);

    await fetchPriceHistory(connection as never, ORACLE, PROGRAM, {
      targetPoints: 60,
      pageSize: 200,
    });

    // One page already carries 200 points; asking for more would be waste.
    expect(calls.signatures).toBe(1);
  });

  it("stops at the end of the account's history", async () => {
    // A short page means there is nothing older, so there is no page four.
    const { connection, calls } = fakeConnection([
      noisePage(200),
      noisePage(200),
      noisePage(12),
    ]);

    await fetchPriceHistory(connection as never, ORACLE, PROGRAM, {
      targetPoints: 60,
      pageSize: 200,
      maxPages: 9,
    });

    expect(calls.signatures).toBe(3);
  });

  it("gives up rather than crawling a busy oracle forever", async () => {
    const { connection, calls } = fakeConnection(
      Array.from({ length: 20 }, () => noisePage(200)),
    );

    await fetchPriceHistory(connection as never, ORACLE, PROGRAM, {
      targetPoints: 60,
      pageSize: 200,
      maxPages: 5,
    });

    expect(calls.signatures).toBe(5);
  });

  it("ignores instructions belonging to another program", async () => {
    const { connection } = fakeConnection([
      [
        tx([{ programId: OTHER_PROGRAM, data: "whatever" }]),
        tx([publishIx(338_980_000)]),
      ],
    ]);

    const points = await fetchPriceHistory(
      connection as never,
      ORACLE,
      PROGRAM,
      { pageSize: 200 },
    );
    expect(points).toHaveLength(1);
  });

  it("returns the series oldest first", async () => {
    const { connection } = fakeConnection([
      [tx([publishIx(300_000_000)]), tx([publishIx(200_000_000)])],
    ]);
    const points = await fetchPriceHistory(
      connection as never,
      ORACLE,
      PROGRAM,
      { pageSize: 200 },
    );
    const times = points.map((p) => p.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

/*
 * The chart drew a row of disconnected dashes at different heights, and the
 * bug was here rather than in the renderer.
 *
 * A candlestick's four numbers all come from the prints inside its bucket.
 * The bucket width used to come only from the span, so an hour of history
 * over 96 target candles was a 37-second bucket against a keeper publishing
 * every 60 seconds: one print per bucket, every bucket, so open equalled high
 * equalled low equalled close and every candle was a flat two-pixel line at
 * its own price. The renderer was correct. The buckets were wrong.
 */
describe("candles have bodies", () => {
  /** An hour of prints, one a minute, walking upward. */
  const minutely = (count: number, stepCents = 25): PricePoint[] =>
    Array.from({ length: count }, (_, i) => ({
      t: 1_800_000_000 + i * 60,
      price: 200_000_000n + BigInt(i * stepCents * 10_000),
    }));

  const isDoji = (c: { o: bigint; h: bigint; l: bigint; c: bigint }) =>
    c.o === c.h && c.h === c.l && c.l === c.c;

  it("reads the publish cadence off the prints", () => {
    expect(printCadence(minutely(60))).toBe(60);
  });

  it("takes the median gap, so one overnight close does not set the bucket", () => {
    const points = minutely(30);
    // A weekend: fifteen hours with no print, then trading resumes.
    points.push({ t: points[points.length - 1].t + 54_000, price: 210_000_000n });
    for (let i = 1; i <= 30; i++) {
      points.push({
        t: points[points.length - 1].t + 60,
        price: 210_000_000n + BigInt(i * 250_000),
      });
    }
    // The mean gap here is over 900s. The median is the cadence that matters.
    expect(printCadence(points)).toBe(60);
  });

  it("gives an hour of minutely prints candles that are not all dojis", () => {
    const candles = candlesFrom(minutely(60));

    // The assertion that matters. Before the cadence floor this was 60 dojis.
    expect(candles.length).toBeGreaterThan(2);
    expect(candles.every(isDoji)).toBe(false);
  });

  it("puts several prints in each bucket rather than one", () => {
    const points = minutely(60);
    const candles = candlesFrom(points);
    // Four prints a bar, so roughly a quarter as many bars as prints. Fewer
    // bars is the point: fifteen real candles beat sixty dashes.
    expect(candles.length).toBeLessThanOrEqual(points.length / 3);
  });

  it("still draws a flat series flat, rather than inventing a body", () => {
    // A market that genuinely has not moved must not be dressed up. This is
    // the case the old code handled correctly and the fix must not break.
    const flat: PricePoint[] = Array.from({ length: 60 }, (_, i) => ({
      t: 1_800_000_000 + i * 60,
      price: 200_000_000n,
    }));
    expect(candlesFrom(flat).every(isDoji)).toBe(true);
  });

  it("does not widen the bucket when prints are already dense", () => {
    // Ten-second prints over ten minutes: the span rule already gives buckets
    // holding several prints, and the cadence floor must not coarsen it past
    // what the history can support.
    const dense: PricePoint[] = Array.from({ length: 60 }, (_, i) => ({
      t: 1_800_000_000 + i * 10,
      price: 200_000_000n + BigInt(i * 100_000),
    }));
    const candles = candlesFrom(dense);
    expect(candles.length).toBeGreaterThan(5);
    expect(candles.every(isDoji)).toBe(false);
  });

  it("returns no cadence for a series too short to have one", () => {
    expect(printCadence([])).toBe(0);
    expect(printCadence([{ t: 1, price: 1n }])).toBe(0);
  });
});
