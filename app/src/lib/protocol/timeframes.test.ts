/**
 * Chart timeframes: which data each tab draws, and that the live oracle price
 * lands on the newest bar.
 */
import { describe, expect, it } from "vitest";
import { buildTimeframe, resample, withLive, type ChartInputs } from "./timeframes";
import type { Candle } from "./types";

const DAY = 86_400;
const NOW = 1_790_000_000;
const u = (d: number) => BigInt(Math.round(d * 1e6));
const bar = (t: number, c: number): Candle => ({ t, o: u(c), h: u(c + 1), l: u(c - 1), c: u(c), v: 0n });

/** Twenty years of daily bars ending yesterday. */
const daily = Array.from({ length: 20 * 365 }, (_, i) => bar(NOW - (20 * 365 - i) * DAY, 50 + i * 0.03));
/** A month of 15-minute bars. */
const intraday = Array.from({ length: 30 * 26 }, (_, i) => bar(NOW - (30 * 26 - i) * 900, 200 + (i % 7)));

const inputs = (over: Partial<ChartInputs> = {}): ChartInputs => ({
  points: [],
  intraday,
  daily,
  fallback: [],
  live: { price: u(260), t: NOW },
  ...over,
});

describe("buildTimeframe", () => {
  it("draws years of history on ALL, not just the oracle's days", () => {
    const v = buildTimeframe("ALL", inputs());
    const span = v.candles[v.candles.length - 1].t - v.candles[0].t;
    expect(v.source).toBe("daily");
    expect(span).toBeGreaterThan(19 * 365 * DAY);
  });

  it("keeps ALL to a readable bar count by resampling", () => {
    // Twenty years is monthly bars: a few hundred, not seven thousand.
    expect(buildTimeframe("ALL", inputs()).candles.length).toBeLessThan(300);
  });

  it("covers a year of daily bars on 1Y and five of weekly bars on 5Y", () => {
    const y = buildTimeframe("1Y", inputs()).candles;
    expect(y.length).toBeGreaterThan(300);
    const five = buildTimeframe("5Y", inputs()).candles;
    expect(five.length).toBeGreaterThan(250);
    expect(five.length).toBeLessThan(270);
  });

  it("uses intraday bars for 1D, 1W and 1M", () => {
    for (const tf of ["1D", "1W", "1M"] as const) {
      expect(buildTimeframe(tf, inputs()).source).toBe("intraday");
    }
  });

  it("puts the live oracle price on the newest bar of every long timeframe", () => {
    for (const tf of ["1D", "1W", "1M", "1Y", "5Y", "ALL"] as const) {
      const c = buildTimeframe(tf, inputs()).candles;
      expect(c[c.length - 1].c).toBe(u(260));
    }
  });

  it("falls back to the oracle's prints when there is no market data", () => {
    const points = Array.from({ length: 120 }, (_, i) => ({ t: NOW - (120 - i) * 20, price: u(200 + (i % 5)) }));
    const v = buildTimeframe("1Y", inputs({ intraday: [], daily: [], points }));
    expect(v.source).toBe("oracle");
    expect(v.candles.length).toBeGreaterThan(2);
  });

  it("prefers the oracle's own prints for 1H when it has them", () => {
    const points = Array.from({ length: 180 }, (_, i) => ({ t: NOW - (180 - i) * 20, price: u(200 + (i % 9)) }));
    expect(buildTimeframe("1H", inputs({ points })).source).toBe("oracle");
  });
});

describe("resample", () => {
  it("builds a week from its days: first open, extreme high and low, last close", () => {
    // Monday 2026-09-21 through Friday.
    const mon = Date.UTC(2026, 8, 21) / 1000;
    const days = [100, 105, 95, 102, 101].map((c, i) => bar(mon + i * DAY, c));
    const [week] = resample(days, 7 * DAY);
    expect(resample(days, 7 * DAY)).toHaveLength(1);
    expect(week.o).toBe(u(100));
    expect(week.h).toBe(u(106));
    expect(week.l).toBe(u(94));
    expect(week.c).toBe(u(101));
  });
});

describe("withLive", () => {
  it("moves today's bar with the live price", () => {
    const bars = [bar(NOW - DAY, 100), bar(NOW - 60, 101)];
    const out = withLive(bars, { price: u(110), t: NOW }, DAY);
    expect(out).toHaveLength(2);
    expect(out[1].c).toBe(u(110));
    expect(out[1].h).toBe(u(110));
  });

  it("opens a new bar when the live price is in a new period", () => {
    const bars = [bar(NOW - 3 * DAY, 100)];
    const out = withLive(bars, { price: u(90), t: NOW }, DAY);
    expect(out).toHaveLength(2);
    expect(out[1].o).toBe(u(100));
    expect(out[1].c).toBe(u(90));
  });
});
