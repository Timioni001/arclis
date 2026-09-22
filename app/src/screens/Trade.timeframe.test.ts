/**
 * The timeframe tabs.
 *
 * They were bar counts wearing duration labels: "1H" meant the last twelve
 * bars, whatever those bars happened to be. Bar width is chosen once for the
 * whole series, so the same twelve bars could span ten minutes or ten hours,
 * and every tab showed the same picture at a different zoom. Nothing about
 * that is visible from a screenshot, which is why it survived.
 */

import { describe, expect, it } from "vitest";
import { candlesForTimeframe } from "./Trade";
import type { MarketView, PricePoint } from "../lib/protocol/types";

const HOUR = 3_600;
const NOW = 1_800_000_000;

/** A day of prints, one a minute, ending at NOW. */
function dayOfPrints(): PricePoint[] {
  const count = (24 * HOUR) / 60;
  return Array.from({ length: count }, (_, i) => ({
    t: NOW - (count - 1 - i) * 60,
    price: 200_000_000n + BigInt(i * 10_000),
  }));
}

function view(points: PricePoint[] | undefined): MarketView {
  return {
    market: {} as MarketView["market"],
    oracle: {} as MarketView["oracle"],
    pool: {} as MarketView["pool"],
    candles: [],
    points,
    volume24h: 0n,
    changePct24h: 0,
  };
}

const span = (v: { candles: { t: number }[] }) =>
  v.candles.length < 2
    ? 0
    : v.candles[v.candles.length - 1].t - v.candles[0].t;

describe("candlesForTimeframe", () => {
  it("shows an hour on the 1H tab, not the whole series", () => {
    const v = candlesForTimeframe(view(dayOfPrints()), "1H");
    // Within one bucket of an hour. The old code returned twelve bars of
    // whatever width the day's bucketing had chosen.
    expect(span(v)).toBeLessThanOrEqual(HOUR);
    expect(span(v)).toBeGreaterThan(HOUR * 0.8);
  });

  it("shows a day on the 1D tab", () => {
    const v = candlesForTimeframe(view(dayOfPrints()), "1D");
    expect(span(v)).toBeGreaterThan(20 * HOUR);
  });

  it("gives different tabs different bar widths, not just different counts", () => {
    const points = dayOfPrints();
    const hourly = candlesForTimeframe(view(points), "1H");
    const daily = candlesForTimeframe(view(points), "1D");

    const barWidth = (v: typeof hourly) =>
      v.candles.length < 2 ? 0 : v.candles[1].t - v.candles[0].t;

    // This is the whole fix. Before it, both were the same number.
    expect(barWidth(daily)).toBeGreaterThan(barWidth(hourly));
  });

  it("measures the window from the last print, not the wall clock", () => {
    // A market that closed on Friday must still draw its last hour of trading
    // on Sunday, rather than an empty window with the prints just outside it.
    const stale = dayOfPrints().map((p) => ({ ...p, t: p.t - 3 * 24 * HOUR }));
    const v = candlesForTimeframe(view(stale), "1H");
    expect(v.candles.length).toBeGreaterThan(1);
  });

  it("reports how much of a month it actually has", () => {
    const v = candlesForTimeframe(view(dayOfPrints()), "1M");
    // A day out of thirty. The screen says so rather than drawing a day
    // stretched across a month's width and letting it read as flat trading.
    expect(v.coverage).not.toBeNull();
    expect(v.coverage!).toBeLessThan(0.1);
  });

  it("asks no coverage question of the ALL tab", () => {
    expect(candlesForTimeframe(view(dayOfPrints()), "ALL").coverage).toBeNull();
  });

  it("filters ready-made candles by the window when a source has no prints", () => {
    const v = view(undefined);
    // Hourly bars over four days, as the modelled source produces.
    v.candles = Array.from({ length: 96 }, (_, i) => ({
      t: NOW - (95 - i) * HOUR,
      o: 1n,
      h: 2n,
      l: 1n,
      c: 2n,
      v: 0n,
    }));
    // Kept as bars rather than re-bucketed, which would discard their wicks.
    expect(candlesForTimeframe(v, "1D").candles).toHaveLength(25);
    expect(candlesForTimeframe(v, "ALL").candles).toHaveLength(96);
  });

  it("returns an empty series rather than throwing on no prints at all", () => {
    expect(candlesForTimeframe(view([]), "1H").candles).toEqual([]);
  });
});
