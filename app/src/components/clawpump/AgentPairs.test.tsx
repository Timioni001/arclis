// @vitest-environment jsdom
/**
 * The launch-pair list: that it shows real stocks, marks the ones Arclis can
 * hedge, and never pretends to launch from the browser.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentPairs } from "./AgentPairs";
import { STOCK_PAIRS, hedgeable } from "../../lib/clawpump/pairs";
import { MARKETS } from "../../lib/markets";

afterEach(cleanup);

// 24/7 markets trade an xStock whose ClawPump pair is its underlying's, so
// they add no pair of their own.
const LISTED = MARKETS.filter((m) => m.schedule !== "24/7");

describe("AgentPairs", () => {
  it("every Arclis market is a stock ClawPump can launch against", () => {
    // If this fails, a market was added that no agent could raise in.
    const pairs = new Set(STOCK_PAIRS.map((p) => p.symbol));
    for (const m of LISTED) expect(pairs.has(m.symbol)).toBe(true);
    for (const m of MARKETS) expect(pairs.has(m.underlying ?? m.symbol)).toBe(true);
    expect(STOCK_PAIRS.filter(hedgeable)).toHaveLength(LISTED.length);
  });

  it("opens on the hedgeable stocks and widens to all of them", () => {
    render(<AgentPairs />);
    expect(screen.getAllByText("Hedgeable")).toHaveLength(LISTED.length);

    fireEvent.click(screen.getByRole("tab", { name: "All stocks" }));
    expect(screen.getByText("Krispy Kreme")).toBeTruthy();
  });

  it("searches by ticker or company", () => {
    render(<AgentPairs />);
    fireEvent.click(screen.getByRole("tab", { name: "All stocks" }));
    fireEvent.change(screen.getByLabelText("Search tokenized stocks"), {
      target: { value: "boeing" },
    });
    expect(screen.getByText("BA")).toBeTruthy();
    expect(screen.queryByText("AAPL")).toBeNull();
  });

  it("offers no launch button, because a launch needs a key this page must not hold", () => {
    render(<AgentPairs />);
    expect(screen.queryByRole("button", { name: /launch/i })).toBeNull();
  });
});
