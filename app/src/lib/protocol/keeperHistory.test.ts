/**
 * Reading the keeper's price history, and merging it with the chain's.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchKeeperHistory, mergePoints } from "./keeperHistory";

describe("fetchKeeperHistory", () => {
  it("reads dollars off the wire into the protocol's 1e6 scale", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ points: [{ t: 1, p: 228.5 }] })),
    );
    const points = await fetchKeeperHistory("AAPL", "https://k", fetchImpl as never);
    expect(points).toEqual([{ t: 1, price: 228_500_000n }]);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe("https://k/history?symbol=AAPL");
  });

  it("drops malformed prints rather than charting them", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ points: [{ t: 1, p: 0 }, { t: 2, p: null }, { t: 3, p: 10 }] })),
    );
    const points = await fetchKeeperHistory("AAPL", "https://k", fetchImpl as never);
    expect(points.map((p) => p.t)).toEqual([3]);
  });

  it("is a no-op with no keeper configured, so the chain series still draws", async () => {
    expect(await fetchKeeperHistory("AAPL", "")).toEqual([]);
  });

  it("treats an error response as no history, not as a failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    expect(await fetchKeeperHistory("AAPL", "https://k", fetchImpl as never)).toEqual([]);
  });
});

describe("mergePoints", () => {
  it("lets the chain's print win where both have the same second", () => {
    const merged = mergePoints(
      [{ t: 1, price: 1n }, { t: 2, price: 2n }],
      [{ t: 2, price: 20n }, { t: 3, price: 3n }],
    );
    expect(merged).toEqual([
      { t: 1, price: 1n },
      { t: 2, price: 20n },
      { t: 3, price: 3n },
    ]);
  });
});

import { withSummary } from "./keeperHistory";

describe("withSummary", () => {
  const view = {
    oracle: { symbol: "AAPL", price: 231_000_000n, lastUpdateTs: 1 },
    changePct24h: 0,
    candles: [],
  };

  it("measures today's change against the previous session's close", () => {
    // $231 against a $220 close is +5%. It read 0.00% before, because the
    // oracle had not yet been running for a day.
    const out = withSummary(view, { previousClose: 220_000_000n, closes: [] });
    expect(out.changePct24h).toBeCloseTo(5, 6);
  });

  it("builds a sparkline from the month's closes and ends it on the live price", () => {
    const out = withSummary(view, { previousClose: null, closes: [200_000_000n, 210_000_000n] });
    expect(out.spark?.map((c) => c.c)).toEqual([200_000_000n, 210_000_000n, 231_000_000n]);
  });

  it("leaves the view alone when the keeper has no summary for it", () => {
    expect(withSummary(view, undefined)).toBe(view);
  });
});
