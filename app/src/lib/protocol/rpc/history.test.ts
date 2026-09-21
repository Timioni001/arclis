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
import BN from "bn.js";

import { coder } from "./decode";
import { appendPoint, candlesFrom, type PricePoint } from "./history";

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
