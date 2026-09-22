// @vitest-environment jsdom
/**
 * What the chart shows when there is almost nothing to show.
 *
 * The overnight case, and the one that looked broken: the keeper refuses to
 * republish a price that has not moved - doing so would launder a stale print
 * into a fresh one - so while the venue is closed the series stops growing. At
 * one point the chart drew a single dot at the far left with the oracle marker
 * running across the plot beside it, which reads as a fault rather than as a
 * market that has not traded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.hoisted(() => {
  const g = globalThis as unknown as { matchMedia: unknown };
  g.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
});

import { PriceChart } from "./PriceChart";
import type { Candle } from "../../lib/protocol/types";

// Without this the DOM accumulates across renders and every query finds
// matches from the previous test.
afterEach(cleanup);

const candle = (t: number, px: number): Candle => ({
  t,
  o: BigInt(px),
  h: BigInt(px),
  l: BigInt(px),
  c: BigInt(px),
  v: 0n,
});

describe("with too little history", () => {
  it("says so, and shows the price it does have", () => {
    render(<PriceChart candles={[candle(1_790_000_000, 338_980_000)]} />);

    expect(screen.getByText(/One price published so far/)).toBeTruthy();
    expect(screen.getByText("$338.98")).toBeTruthy();
    // Not a skeleton: a skeleton promises something is loading, and nothing
    // is - the venue is shut.
    expect(document.querySelector(".skeleton")).toBeNull();
  });

  it("explains why the series stopped growing", () => {
    render(<PriceChart candles={[candle(1_790_000_000, 338_980_000)]} />);
    expect(
      screen.getByText(/refuses to republish an unchanged price/),
    ).toBeTruthy();
  });

  it("counts what it has", () => {
    render(
      <PriceChart
        candles={[
          candle(1_790_000_000, 338_980_000),
          candle(1_790_000_060, 338_990_000),
        ]}
      />,
    );
    expect(screen.getByText(/2 prices published so far/)).toBeTruthy();
  });
});

describe("with enough history", () => {
  it("draws the chart instead", () => {
    const candles = Array.from({ length: 12 }, (_, i) =>
      candle(1_790_000_000 + i * 60, 338_000_000 + i * 10_000),
    );
    const { container } = render(<PriceChart candles={candles} />);

    expect(container.querySelector("svg.chart")).toBeTruthy();
    expect(screen.queryByText(/published so far/)).toBeNull();
    // The last price sits on the axis, as a terminal draws it.
    expect(container.querySelector(".chart-last")).toBeTruthy();
  });
});
