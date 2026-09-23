/**
 * The keeper's price history store and the endpoint that serves it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { PriceHistory } from "./price-history";
import { newHealth, startHealthServer } from "./health";

describe("PriceHistory", () => {
  it("keeps prints sorted and one per second", () => {
    const h = new PriceHistory(10);
    h.record("AAPL", 200_000_000n, 100);
    h.merge("AAPL", [
      { t: 50, price: 190_000_000n },
      { t: 100, price: 201_000_000n },
    ]);
    const s = h.get("AAPL");
    expect(s.map((p) => p.t)).toEqual([50, 100]);
    // A backfilled print at the same second replaces, rather than doubles.
    expect(s[1].price).toBe(201_000_000n);
  });

  it("is counted, not timed, so a closed market keeps its last session", () => {
    const h = new PriceHistory(3);
    for (let t = 1; t <= 5; t++) h.record("AAPL", BigInt(t) * 1_000_000n, t);
    expect(h.get("AAPL").map((p) => p.t)).toEqual([3, 4, 5]);
  });

  it("serves dollars, which is what a chart consumes", () => {
    const h = new PriceHistory();
    h.record("AAPL", 228_500_000n, 1);
    expect(h.toJson("AAPL").points).toEqual([{ t: 1, p: 228.5 }]);
  });
});

describe("GET /history", () => {
  const abort = new AbortController();
  const port = 18000 + Math.floor(Math.random() * 1000);
  const history = new PriceHistory();
  history.record("AAPL", 228_500_000n, 1);
  startHealthServer(
    newHealth({ rpc: "x", programId: "x", keeper: "x", symbols: ["AAPL"], feed: "test" }),
    port,
    abort.signal,
    () => {},
    history,
  );
  afterAll(() => abort.abort());

  it("serves a market's series with CORS, for a browser on another origin", async () => {
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`http://127.0.0.1:${port}/history?symbol=aapl`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await res.json()).points).toHaveLength(1);
  });

  it("answers an empty series, not a 404, before a market's backfill lands", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/history?symbol=NVDA`);
    expect(res.status).toBe(200);
    expect((await res.json()).points).toEqual([]);
  });
});
