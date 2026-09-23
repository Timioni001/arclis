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

describe("AgentPairs", () => {
  it("every Arclis market is a stock ClawPump can launch against", () => {
    // If this fails, a market was added that no agent could raise in.
    const pairs = new Set(STOCK_PAIRS.map((p) => p.symbol));
    for (const m of MARKETS) expect(pairs.has(m.symbol)).toBe(true);
    expect(STOCK_PAIRS.filter(hedgeable)).toHaveLength(MARKETS.length);
  });

  it("opens on the hedgeable stocks and widens to all of them", () => {
    render(<AgentPairs />);
    expect(screen.getAllByText("Hedgeable")).toHaveLength(MARKETS.length);

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
    expect(screen.getByText(/never touches this page/i)).toBeTruthy();
  });
});
