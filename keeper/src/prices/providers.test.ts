/**
 * The stock feeds' parsing. Every provider returns only what it could price,
 * at the protocol's 1e6 scale, stamped with the venue's own time, and a bad
 * row is skipped rather than published as zero.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { alpacaFeed, finnhubFeed, polygonFeed, simulatedFeed } from "./providers";
import { withFallback } from "./fallback";
import type { PriceFeed, Quote } from "./types";

afterEach(() => vi.unstubAllGlobals());

const respond = (body: unknown, ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, statusText: ok ? "OK" : "Too Many Requests", json: async () => body }));

describe("alpacaFeed", () => {
  it("prices every symbol from one request, at the venue's time", async () => {
    const urls: string[] = [];
    const feed = alpacaFeed("id", "secret", "iex", async (url, headers) => {
      urls.push(url);
      expect(headers).toMatchObject({ "APCA-API-KEY-ID": "id", "APCA-API-SECRET-KEY": "secret" });
      return {
        trades: {
          AAPL: { p: 254.2, t: "2026-09-25T19:59:58Z", c: ["@"] },
          NVDA: { p: 0, t: "2026-09-25T19:59:58Z" }, // unusable: skipped
          "BRK.B": { p: 480.5, t: "2026-09-25T19:59:59Z" },
        },
      };
    });
    const quotes = await feed.quote(["AAPL", "NVDA", "BRK.B"]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("symbols=AAPL,NVDA,BRK.B");
    expect(urls[0]).toContain("feed=iex");
    expect(quotes.map((q) => q.symbol)).toEqual(["AAPL", "BRK.B"]);
    expect(quotes[0].price).toBe(254_200_000n);
    expect(quotes[0].printedAt).toBe(Date.parse("2026-09-25T19:59:58Z") / 1000);
    expect(quotes[0].halted).toBe(false);
  });

  it("fails loudly on an HTTP error, so the fallback can take over", async () => {
    vi.stubGlobal("fetch", respond({}, false, 401));
    await expect(alpacaFeed("id", "bad").quote(["AAPL"])).rejects.toThrow(/401/);
  });
});

describe("finnhubFeed", () => {
  it("prices each symbol, keeps the previous close, and drops a failed one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("symbol=BAD")) return { ok: false, status: 429, statusText: "Too Many Requests", json: async () => ({}) };
        if (url.includes("symbol=ZERO")) return { ok: true, status: 200, json: async () => ({ c: 0 }) };
        return { ok: true, status: 200, json: async () => ({ c: 335.92, pc: 330, t: 1_790_000_000 }) };
      }),
    );
    const quotes = await finnhubFeed("key").quote(["MSFT", "BAD", "ZERO"]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ symbol: "MSFT", price: 335_920_000n, printedAt: 1_790_000_000, previousClose: 330 });
  });
});

describe("polygonFeed", () => {
  it("reads nanosecond trade times and marks a halted ticker", async () => {
    vi.stubGlobal(
      "fetch",
      respond({
        tickers: [
          { ticker: "aapl", lastTrade: { p: 254.2, t: 1_790_000_000_123_456_789 }, lastQuote: { p: 254.1, P: 254.3 }, status: "halted" },
          { ticker: "NONE", lastTrade: {} },
        ],
      }),
    );
    const [q, ...rest] = await polygonFeed("key").quote(["AAPL", "NONE"]);
    expect(rest).toHaveLength(0);
    expect(q.symbol).toBe("AAPL");
    expect(q.printedAt).toBe(1_790_000_000);
    expect(q.halted).toBe(true);
    // Half the quoted spread is the confidence.
    expect(Number(q.confidence) / 1e6).toBeCloseTo(0.1);
  });
});

describe("simulatedFeed", () => {
  it("is deterministic for a seed and prices only what it was seeded with", async () => {
    const a = await simulatedFeed({ AAPL: 100 }, { seed: 7 }).quote(["AAPL", "NVDA"]);
    const b = await simulatedFeed({ AAPL: 100 }, { seed: 7 }).quote(["AAPL", "NVDA"]);
    expect(a.map((q) => q.price)).toEqual(b.map((q) => q.price));
    expect(a.map((q) => q.symbol)).toEqual(["AAPL"]);
  });
});

describe("withFallback", () => {
  const quote = (symbol: string): Quote => ({ symbol, price: 1n, confidence: 0n, printedAt: 1, halted: false });
  const feed = (name: string, impl: (s: string[]) => Promise<Quote[]>): PriceFeed & { asked: string[][] } => {
    const asked: string[][] = [];
    return { name, asked, quote: async (s) => (asked.push(s), impl(s)) };
  };

  it("asks the second feed only for what the first could not price", async () => {
    const log = vi.fn();
    const primary = feed("alpaca", async (s) => s.filter((x) => x !== "B").map(quote));
    const secondary = feed("finnhub", async (s) => s.map(quote));
    const out = await withFallback(primary, secondary, log).quote(["A", "B", "C"]);
    expect(out.map((q) => q.symbol).sort()).toEqual(["A", "B", "C"]);
    expect(secondary.asked).toEqual([["B"]]);
    expect(log).toHaveBeenCalledWith("warn", "priced from finnhub instead of alpaca", { symbols: "B" });
  });

  it("says so once per change, not every tick", async () => {
    const log = vi.fn();
    const f = withFallback(feed("p", async () => []), feed("s", async (s) => s.map(quote)), log);
    await f.quote(["A"]);
    await f.quote(["A"]);
    expect(log.mock.calls.filter((c) => String(c[1]).startsWith("priced from"))).toHaveLength(1);
  });

  it("survives the first feed being down, within the second feed's cap", async () => {
    const log = vi.fn();
    const secondary = feed("s", async (s) => s.map(quote));
    const out = await withFallback(feed("p", async () => { throw new Error("401 Unauthorized"); }), secondary, log, 2).quote(["A", "B", "C"]);
    expect(out.map((q) => q.symbol)).toEqual(["A", "B"]);
    expect(log).toHaveBeenCalledWith("warn", "p unavailable", { message: "401 Unauthorized" });
  });

  it("returns nothing, rather than throwing, when both are down", async () => {
    const down = async () => { throw new Error("down"); };
    await expect(withFallback(feed("p", down), feed("s", down), vi.fn()).quote(["A"])).resolves.toEqual([]);
  });
});
