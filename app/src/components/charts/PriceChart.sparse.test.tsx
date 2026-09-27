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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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

    // The canvas chart mounts into this box; jsdom has no canvas, so the
    // library itself is exercised in the browser pass, not here.
    const chart = container.querySelector(".chart-live");
    expect(chart).toBeTruthy();
    expect(chart!.getAttribute("aria-label")).toMatch(/12 bars, last \$338\.11/);
    expect(screen.queryByText(/published so far/)).toBeNull();
  });
});

describe("the chart's tools", () => {
  const candles = Array.from({ length: 12 }, (_, i) =>
    candle(1_790_000_000 + i * 60, 338_000_000 + i * 10_000),
  );

  it("reads out the latest bar before anything is hovered", () => {
    const { container } = render(<PriceChart candles={candles} />);
    expect(container.querySelector(".chart-legend")!.textContent).toMatch(/C \$338\.11/);
  });

  it("expands to the full screen with the page's controls, and Escape comes back", () => {
    const { container } = render(
      <PriceChart candles={candles} title="AAPL · Apple Inc." controls={<button>1D</button>} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand the chart to full screen" }));
    expect(container.querySelector(".chart-frame[data-full]")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toMatch(/AAPL · Apple Inc\./);
    expect(screen.getByRole("button", { name: "1D" })).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".chart-frame[data-full]")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("takes its height from the screen unless given one", () => {
    const fluid = render(<PriceChart candles={candles} />);
    expect(fluid.container.querySelector(".chart-live")!.className).toContain("chart-fluid");
    cleanup();
    const fixed = render(<PriceChart candles={candles} height={240} />);
    const box = fixed.container.querySelector(".chart-live") as HTMLElement;
    expect(box.className).not.toContain("chart-fluid");
    expect(box.style.height).toBe("240px");
  });
});

