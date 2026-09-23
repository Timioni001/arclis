/**
 * The chart's vertical scale, and the case that broke it: a still market.
 *
 * Prices are integers at 1e6 scale. The old guard was
 * `priceMax - priceMin || 1`, which for a series where nothing moved produced
 * a domain **one millionth of a dollar** tall. Every axis label formatted to
 * the same number, the series collapsed onto one line, and a market that was
 * simply closed for the night looked like a broken chart.
 */
import { describe, expect, it } from "vitest";

import { priceDomain } from "./PriceChart";
import type { Candle } from "../../lib/protocol/types";

/** $338.98, the price the devnet oracle sat at overnight. */
const PX = 338_980_000;

const flat = (px: number, n = 8): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    t: 1_790_000_000 + i * 60,
    o: BigInt(px),
    h: BigInt(px),
    l: BigInt(px),
    c: BigInt(px),
    v: 0n,
  }));

describe("a market that has not moved", () => {
  it("still gets a domain worth drawing an axis against", () => {
    const { min, max } = priceDomain(flat(PX));
    // 0.4% of price, plus padding: comfortably more than a dollar either way,
    // so the axis labels differ from each other.
    expect(max - min).toBeGreaterThan(1_000_000);
  });

  it("centres the flat line rather than pinning it to an edge", () => {
    const { min, max } = priceDomain(flat(PX));
    const mid = (min + max) / 2;
    expect(Math.abs(mid - PX) / PX).toBeLessThan(0.001);
    expect(min).toBeLessThan(PX);
    expect(max).toBeGreaterThan(PX);
  });

  it("scales the floor to the price, not to a fixed number of cents", () => {
    // A $10 stock and a $500 stock should both look still, not one of them
    // look violent.
    const cheap = priceDomain(flat(10_000_000));
    const dear = priceDomain(flat(500_000_000));
    const frac = (d: { min: number; max: number }, px: number) =>
      (d.max - d.min) / px;
    expect(frac(cheap, 10_000_000)).toBeCloseTo(frac(dear, 500_000_000), 6);
  });

  it("does not let a marker take over the scale of a still market", () => {
    // The failure this prevents: with a zero-width domain, any marker becomes
    // infinitely far away and owns the whole axis.
    const { min, max } = priceDomain(flat(PX), [
      { price: BigInt(PX / 2), label: "Liquidation", tone: "liquidation" },
    ]);
    expect(min).toBeGreaterThan(PX * 0.99);
    expect(max).toBeGreaterThan(PX);
  });
});

describe("a market that has moved", () => {
  const moving: Candle[] = [
    {
      t: 1,
      o: 100_000_000n,
      h: 106_000_000n,
      l: 99_000_000n,
      c: 105_000_000n,
      v: 0n,
    },
    {
      t: 2,
      o: 105_000_000n,
      h: 112_000_000n,
      l: 104_000_000n,
      c: 110_000_000n,
      v: 0n,
    },
  ];

  it("takes its domain from the candles", () => {
    const { min, max } = priceDomain(moving);
    expect(min).toBeLessThan(99_000_000);
    expect(max).toBeGreaterThan(112_000_000);
    // Padding only, not the still-market floor taking over.
    expect(max - min).toBeLessThan(13_000_000 * 1.4);
  });

  it("lets a nearby marker widen the domain", () => {
    const withMarker = priceDomain(moving, [
      { price: 95_000_000n, label: "Liquidation", tone: "liquidation" },
    ]);
    expect(withMarker.min).toBeLessThan(priceDomain(moving).min);
  });

  it("refuses to let a distant marker flatten the series", () => {
    // A liquidation far below spot must not compress the candles into a strip
    // at the top of the plot.
    const far = priceDomain(moving, [
      { price: 1_000_000n, label: "Liquidation", tone: "liquidation" },
    ]);
    expect(far.min).toBeGreaterThan(90_000_000);
  });
});

import { TickMarkType } from "lightweight-charts";
import { tickLabel } from "./PriceChart";

describe("tickLabel", () => {
  // 2021-03-15, 14:30 UTC: a daily bar's open time.
  const t = Date.UTC(2021, 2, 15, 14, 30) / 1000;

  it("labels year ticks with the year, not the bar's open time", () => {
    // The bug: every tick on a five-year chart read "06:00 AM".
    expect(tickLabel(t as never, TickMarkType.Year)).toBe("2021");
  });

  it("labels day ticks with a date", () => {
    expect(tickLabel(t as never, TickMarkType.DayOfMonth)).toMatch(/15/);
    expect(tickLabel(t as never, TickMarkType.DayOfMonth)).not.toMatch(/:/);
  });

  it("labels time ticks with a time", () => {
    expect(tickLabel(t as never, TickMarkType.Time)).toMatch(/:/);
  });
});
