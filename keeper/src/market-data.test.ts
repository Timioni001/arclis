/**
 * Market data: the providers' formats, the cache, and the overview summary.
 *
 * Fixtures follow each provider's documented response shape, including the
 * awkward parts: Yahoo's nulls for untraded intervals, and Stooq answering
 * with a text message instead of CSV when it will not serve a request.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MarketData,
  parseStooqCsv,
  parseYahooChart,
  yahooPreviousClose,
} from "./market-data";

const yahoo = (closes: (number | null)[], start = 1_700_000_000, step = 86_400, meta = {}) => ({
  chart: {
    result: [
      {
        meta,
        timestamp: closes.map((_, i) => start + i * step),
        indicators: {
          quote: [
            {
              open: closes.map((c) => (c == null ? null : c - 1)),
              high: closes.map((c) => (c == null ? null : c + 2)),
              low: closes.map((c) => (c == null ? null : c - 2)),
              close: closes,
              volume: closes.map((c) => (c == null ? null : 1000)),
            },
          ],
        },
      },
    ],
    error: null,
  },
});

describe("parseYahooChart", () => {
  it("reads bars and drops the null rows Yahoo leaves for untraded intervals", () => {
    const bars = parseYahooChart(yahoo([100, null, 102]));
    expect(bars.map((b) => b.c)).toEqual([100, 102]);
    expect(bars[0]).toMatchObject({ o: 99, h: 102, l: 98, v: 1000 });
  });

  it("returns nothing, not a throw, for an error payload", () => {
    expect(parseYahooChart({ chart: { result: null, error: { code: "Not Found" } } })).toEqual([]);
  });

  it("reads the previous close from the response meta", () => {
    expect(yahooPreviousClose(yahoo([1], 0, 1, { regularMarketPreviousClose: 227.5 }))).toBe(227.5);
    expect(yahooPreviousClose(yahoo([1]))).toBeNull();
  });
});

describe("parseStooqCsv", () => {
  it("reads daily bars", () => {
    const bars = parseStooqCsv(
      "Date,Open,High,Low,Close,Volume\n1980-12-12,0.1,0.11,0.09,0.1,1000\n2026-09-22,228,231,227,230.5,50000000\n",
    );
    expect(bars).toHaveLength(2);
    expect(bars[1].c).toBe(230.5);
    expect(new Date(bars[0].t * 1000).toISOString().slice(0, 10)).toBe("1980-12-12");
  });

  it("treats Stooq's plain-text refusals as no data", () => {
    expect(parseStooqCsv("No data")).toEqual([]);
    expect(parseStooqCsv("Exceeded the daily hits limit")).toEqual([]);
  });
});

describe("MarketData", () => {
  function fetchFrom(routes: Record<string, () => Response>) {
    return vi.fn(async (url: string) => {
      for (const [k, f] of Object.entries(routes)) if (url.includes(k)) return f();
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("serves years of daily bars from Yahoo", async () => {
    const md = new MarketData(
      fetchFrom({ "interval=1d": () => new Response(JSON.stringify(yahoo([101, 102, 103]))) }),
    );
    await md.refresh(["AAPL"], "1d", 0);
    const c = md.candles("AAPL", "1d");
    expect(c.source).toBe("yahoo");
    expect(c.bars).toHaveLength(3);
  });

  it("falls back to Stooq when Yahoo fails", async () => {
    const md = new MarketData(
      fetchFrom({
        "yahoo.com": () => new Response("rate limited", { status: 429 }),
        "stooq.com": () => new Response("Date,Open,High,Low,Close,Volume\n2026-09-22,1,2,0.5,1.5,10\n"),
      }),
    );
    await md.refresh(["AAPL"], "1d", 0);
    expect(md.candles("AAPL", "1d").source).toBe("stooq");
  });

  it("keeps the last good copy when a refresh fails", async () => {
    let fail = false;
    const md = new MarketData(
      vi.fn(async () =>
        fail ? new Response("down", { status: 503 }) : new Response(JSON.stringify(yahoo([101, 102]))),
      ) as unknown as typeof fetch,
    );
    await md.refresh(["AAPL"], "15m", 0);
    fail = true;
    await md.refresh(["AAPL"], "15m", 0);
    expect(md.candles("AAPL", "15m").bars).toHaveLength(2);
  });

  it("prefers the live feed's previous close, then Yahoo's, then the bars", async () => {
    const md = new MarketData(
      fetchFrom({
        "interval=1d": () =>
          new Response(JSON.stringify(yahoo([10, 11, 12], 1_700_000_000, 86_400, { regularMarketPreviousClose: 11.5 }))),
      }),
    );
    await md.refresh(["AAPL"], "1d", 0);

    expect(md.summary(["AAPL"], new Map([["AAPL", 11.9]])).symbols.AAPL.previousClose).toBe(11.9);
    expect(md.summary(["AAPL"], new Map()).symbols.AAPL.previousClose).toBe(11.5);
    expect(md.summary(["AAPL"], new Map()).symbols.AAPL.closes).toEqual([10, 11, 12]);
  });
});

import { fetchYahoo, looksDaily } from "./market-data";

describe("daily granularity", () => {
  it("asks Yahoo by explicit dates, because range=max returns quarterly bars", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(yahoo([101]))));
    await fetchYahoo("AAPL", "1d", fetchImpl as unknown as typeof fetch);
    const url = (fetchImpl.mock.calls[0] as unknown[])[0] as string;
    expect(url).toContain("period1=0");
    expect(url).not.toContain("range=max");
  });

  it("tells daily bars from coarsened ones", () => {
    const at = (step: number) => Array.from({ length: 30 }, (_, i) => ({ t: i * step, o: 1, h: 1, l: 1, c: 1, v: 0 }));
    expect(looksDaily(at(86_400))).toBe(true);
    expect(looksDaily(at(7 * 86_400))).toBe(false);
    expect(looksDaily(at(91 * 86_400))).toBe(false);
  });

  it("replaces coarsened Yahoo bars with Stooq's daily series", async () => {
    const quarterly = yahoo(Array.from({ length: 30 }, (_, i) => 100 + i), 1_000_000_000, 91 * 86_400);
    const csv = ["Date,Open,High,Low,Close,Volume", ...Array.from({ length: 30 }, (_, i) =>
      `2026-08-${String(i + 1).padStart(2, "0")},100,101,99,100.5,10`)].join("\n");
    const md = new MarketData(
      vi.fn(async (url: string) =>
        url.includes("yahoo") ? new Response(JSON.stringify(quarterly)) : new Response(csv),
      ) as unknown as typeof fetch,
    );
    await md.refresh(["AAPL"], "1d", 0);
    expect(md.candles("AAPL", "1d").source).toBe("stooq");
  });
});
