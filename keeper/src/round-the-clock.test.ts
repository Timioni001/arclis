/**
 * 24/7 markets: the feeds that price them and the schedule that opens them.
 *
 * None of the providers can be reached from where this was written, so the
 * parsers are checked against the documented response shapes, and the keeper
 * is driven with a fake chain that records what it was asked to send.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import idl from "../../idl/arclis.json";

const sent: string[] = [];
let reject: Record<string, string> = {};
vi.mock("./chain", () => ({
  send: vi.fn(async (_config: unknown, _ixs: unknown, label: string) => {
    sent.push(label);
    const hit = Object.keys(reject).find((k) => label.startsWith(k));
    return hit ? { ok: false, error: reject[hit], rejected: true } : { ok: true, signature: "sig" };
  }),
}));

import { withFallback } from "./prices/fallback";
import { alpacaFeed } from "./prices/providers";
import { jupiterXStockFeed, midFromQuotes, parseOutAmount, USDC_MINT } from "./prices/jupiter";
import {
  ROUND_THE_CLOCK,
  canonicalSymbol,
  roundTheClockFeed,
} from "./round-the-clock";
import { keeperTick, newKeeperState, NO_PRICE_GRACE_SECS } from "./oracle-keeper";
import type { PriceFeed, Quote } from "./prices/types";

describe("Alpaca", () => {
  it("prices every symbol in one batched pair of requests on the free IEX feed", async () => {
    const urls: string[] = [];
    const feed = alpacaFeed("key", "secret", "iex", async (url, headers) => {
      urls.push(url);
      expect(headers["APCA-API-KEY-ID"]).toBe("key");
      return {
        trades: {
          AAPL: { t: "2026-09-25T14:30:00Z", p: 228.5, c: ["@"] },
          NVDA: { t: "2026-09-25T14:30:01Z", p: 181.25, c: ["@"] },
          MSFT: { t: "2026-09-25T14:30:01Z", p: 0 },
        },
      };
    });
    const quotes = await feed.quote(["AAPL", "NVDA", "MSFT"]);
    // Latest trades and latest quotes, each for every symbol at once.
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => u.includes("/trades/latest"))).toBe(true);
    expect(urls.some((u) => u.includes("/quotes/latest"))).toBe(true);
    for (const u of urls) {
      expect(u).toContain("symbols=AAPL,NVDA,MSFT");
      expect(u).toContain("feed=iex");
    }
    expect(quotes.map((q) => q.symbol)).toEqual(["AAPL", "NVDA"]);
    expect(quotes[0].price).toBe(228_500_000n);
    // The venue's timestamp, never the fetch time.
    expect(quotes[0].printedAt).toBe(Date.UTC(2026, 8, 25, 14, 30, 0) / 1000);
  });
  it("falls back only for what the primary missed, and says so", async () => {
    const primary: PriceFeed = { name: "alpaca", quote: async () => [quote("AAPL", 1)] };
    const asked: string[][] = [];
    const secondary: PriceFeed = {
      name: "finnhub",
      quote: async (s) => {
        asked.push(s);
        return s.map((x) => quote(x, 2));
      },
    };
    const log = vi.fn();
    const out = await withFallback(primary, secondary, log).quote(["AAPL", "HOOD"]);
    expect(asked).toEqual([["HOOD"]]);
    expect(out.map((q) => q.symbol)).toEqual(["AAPL", "HOOD"]);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("finnhub"), {
      symbols: "HOOD",
    });
  });

  it("asks the fallback for no more than it can serve in one pass", async () => {
    const down: PriceFeed = {
      name: "alpaca",
      quote: async () => {
        throw new Error("503");
      },
    };
    const asked: string[][] = [];
    const secondary: PriceFeed = {
      name: "finnhub",
      quote: async (s) => {
        asked.push(s);
        return [];
      },
    };
    await withFallback(down, secondary, () => {}, 2).quote(["AAPL", "NVDA", "MSFT"]);
    expect(asked).toEqual([["AAPL", "NVDA"]]);
  });
});

describe("Jupiter", () => {
  it("reads outAmount and nothing else", () => {
    expect(parseOutAmount({ outAmount: "123" })).toBe(123n);
    expect(parseOutAmount({ outAmount: "0" })).toBeNull();
    expect(parseOutAmount({ error: "no route" })).toBeNull();
  });

  it("takes the mid of the two executable rates, with half the spread as confidence", () => {
    // $1,000 buys 5 shares (ask $200); selling 5 returns $990 (bid $198).
    const m = midFromQuotes(1000, 5, 5, 990)!;
    expect(m.mid).toBeCloseTo(199);
    expect(m.halfSpread).toBeCloseTo(1);
    expect(m.spreadBps).toBeCloseTo(100.5, 0);
  });

  it("prices an xStock from two quotes and stamps the quote time", async () => {
    const feed = jupiterXStockFeed(
      [{ symbol: "NVDAx", mint: "MINT", decimals: 8 }],
      {
        now: () => 42,
        fetchJson: async (url) =>
          url.includes(`inputMint=${USDC_MINT}`)
            ? { outAmount: String(5 * 1e8) } // $1,000 buys 5 shares
            : { outAmount: String(995 * 1e6) }, // 5 shares sell for $995
      },
    );
    const [q] = await feed.quote(["NVDAX"]);
    expect(q.symbol).toBe("NVDAx");
    expect(Number(q.price) / 1e6).toBeCloseTo(199.5);
    expect(Number(q.confidence) / 1e6).toBeCloseTo(0.5);
    expect(q.printedAt).toBe(42);
  });

  it("refuses a market too thin to be a price", async () => {
    const feed = jupiterXStockFeed(
      [{ symbol: "NVDAx", mint: "MINT", decimals: 8 }],
      {
        fetchJson: async (url) =>
          url.includes(`inputMint=${USDC_MINT}`)
            ? { outAmount: String(5 * 1e8) }
            : { outAmount: String(900 * 1e6) }, // a 10% round trip
      },
    );
    expect(await feed.quote(["NVDAx"])).toEqual([]);
  });
});

describe("Jupiter at twenty markets", () => {
  const sources = Array.from({ length: 20 }, (_, i) => ({
    symbol: `S${i}x`,
    mint: `MINT${i}`,
    decimals: 8,
  }));
  // Every market: $1,000 buys 5 shares, 5 shares sell for $995 (mid $199.50).
  const quoteJson = (url: string) =>
    url.includes(`inputMint=${USDC_MINT}`)
      ? { outAmount: String(5 * 1e8) }
      : { outAmount: String(995 * 1e6) };

  it("prices every market in one request and re-proves only a few per tick", async () => {
    let t = 1_000;
    const urls: string[] = [];
    const feed = jupiterXStockFeed(sources, {
      now: () => t,
      fetchJson: async (url) => {
        urls.push(url);
        if (url.includes("/price/v3")) {
          return Object.fromEntries(sources.map((s) => [s.mint, { usdPrice: 199.4 }]));
        }
        return quoteJson(url);
      },
    });
    const first = await feed.quote(sources.map((s) => s.symbol));
    expect(urls.filter((u) => u.includes("/price/v3"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("/swap/v1/quote"))).toHaveLength(6); // 3 markets x 2
    expect(first).toHaveLength(3); // only markets proved so far are priced
    expect(Number(first[0].price) / 1e6).toBeCloseTo(199.4);

    // Seven ticks later every market has been proved once.
    for (let i = 0; i < 6; i++) {
      t += 20;
      await feed.quote(sources.map((s) => s.symbol));
    }
    t += 20;
    expect(await feed.quote(sources.map((s) => s.symbol))).toHaveLength(20);
  });

  it("trades at the executable market when the price API disagrees with it", async () => {
    let t = 5;
    const quoted: number[] = [];
    const feed = jupiterXStockFeed([sources[0]], {
      now: () => t,
      fetchJson: async (url) => {
        if (url.includes("/price/v3")) return { MINT0: { usdPrice: 150 } }; // a stale print
        quoted.push(t);
        return quoteJson(url);
      },
    });
    // A check was taken this tick, so its executable mid is the price.
    const [first] = await feed.quote(["S0x"]);
    expect(Number(first.price) / 1e6).toBeCloseTo(199.5);
    // And it is re-proved every tick while the disagreement lasts, rather
    // than trading on a mid that is minutes old.
    t += 20;
    const [second] = await feed.quote(["S0x"]);
    expect(Number(second.price) / 1e6).toBeCloseTo(199.5);
    expect(quoted.filter((q) => q === 25)).toHaveLength(2);
  });

  it("keeps a market priced through one failed quote, and retries it next tick", async () => {
    let t = 0;
    let fail = false;
    const quoted: number[] = [];
    const feed = jupiterXStockFeed([sources[0]], {
      now: () => t,
      fetchJson: async (url) => {
        if (url.includes("/price/v3")) return { MINT0: { usdPrice: 199.4 } };
        quoted.push(t);
        if (fail) throw new Error("500 Internal Server Error");
        return quoteJson(url);
      },
    });
    expect(await feed.quote(["S0x"])).toHaveLength(1);
    // The scheduled re-check fails: the check from 180 s ago still stands.
    t = 180;
    fail = true;
    expect(await feed.quote(["S0x"])).toHaveLength(1);
    // Retried on the very next tick, not three minutes later.
    t = 200;
    fail = false;
    await feed.quote(["S0x"]);
    expect(quoted).toContain(200);
  });

  it("accepts a deep book's price that drifted a little since its check", async () => {
    // $1,000 buys 5 shares and 5 shares sell for $999.90: a 1 bp round trip.
    // The price API reads 0.3% higher, well inside how far a stock moves
    // between checks, and a band as narrow as the spread would refuse it.
    const feed = jupiterXStockFeed([sources[0]], {
      now: () => 5,
      fetchJson: async (url) =>
        url.includes("/price/v3")
          ? { MINT0: { usdPrice: 200.6 } }
          : url.includes(`inputMint=${USDC_MINT}`)
            ? { outAmount: String(5 * 1e8) }
            : { outAmount: String(999.9 * 1e6) },
    });
    const [q] = await feed.quote(["S0x"]);
    expect(Number(q.price) / 1e6).toBeCloseTo(200.6);
    // Confidence stays the measured half-spread, not the tolerance.
    expect(Number(q.confidence) / 1e6).toBeLessThan(0.02);
    expect(feed.unpriced().markets).toEqual({});
  });

  it("says why each market it could not price is closed", async () => {
    const thin = { symbol: "THINx", mint: "THIN", decimals: 8 };
    const noRoute = { symbol: "NOROUTEx", mint: "NOROUTE", decimals: 8 };
    const unlisted = { symbol: "UNLISTEDx", mint: "UNLISTED", decimals: 8 };
    let t = 5;
    const feed = jupiterXStockFeed([thin, noRoute, unlisted, sources[0]], {
      now: () => t,
      fetchJson: async (url) => {
        if (url.includes("/price/v3")) return { THIN: { usdPrice: 190 } };
        if (url.includes("NOROUTE")) return { error: "no route" };
        if (url.includes("outputMint=THIN") || url.includes("inputMint=THIN")) {
          return url.includes(`inputMint=${USDC_MINT}`)
            ? { outAmount: String(5 * 1e8) }
            : { outAmount: String(900 * 1e6) }; // a 10% round trip
        }
        return quoteJson(url);
      },
    });
    const all = ["THINx", "NOROUTEx", "UNLISTEDx", "S0x"];
    // Three checks a tick, so the fourth market has not been looked at yet.
    // A market the price API does not list is priced from its own check on
    // the tick that check is taken.
    await feed.quote(all);
    expect(feed.unpriced().markets).toEqual({
      THINx: expect.stringMatching(/over the 300 bps limit/),
      NOROUTEx: "no Jupiter route to buy",
      S0x: "waiting for its first spread check",
    });
    // It is re-checked every tick, so it stays priced. The market with no
    // route is retried, and says so until a route appears.
    t += 20;
    await feed.quote(all);
    expect(feed.unpriced().markets).toEqual({
      THINx: expect.stringMatching(/over the 300 bps limit/),
      NOROUTEx: "no Jupiter route to buy",
    });
  });
});

describe("the 24/7 schedule", () => {
  const twins = [ROUND_THE_CLOCK.find((m) => m.symbol === "NVDAx")!];
  const stockAsked: string[][] = [];
  const xAsked: string[][] = [];
  const stocks: PriceFeed = {
    name: "stocks",
    quote: async (s) => {
      stockAsked.push(s);
      return s.map((x) => quote(x, 100));
    },
  };
  const xstocks: PriceFeed = {
    name: "xstocks",
    quote: async (s) => {
      xAsked.push(s);
      return s.map((x) => quote(x, 101));
    },
  };
  beforeEach(() => {
    stockAsked.length = 0;
    xAsked.length = 0;
  });

  it("prices a 24/7 market from its underlying while the exchange is open", async () => {
    const feed = roundTheClockFeed(stocks, xstocks, twins, {
      session: () => "Open",
    });
    const out = await feed.quote(["NVDA", "NVDAx", "AAPL"]);
    expect(stockAsked).toEqual([["NVDA", "AAPL"]]);
    expect(xAsked).toEqual([]);
    expect(out.find((q) => q.symbol === "NVDAx")?.price).toBe(100_000_000n);
    expect(out.map((q) => q.symbol).sort()).toEqual(["AAPL", "NVDA", "NVDAx"]);
  });

  it("prices it from the xStock while the exchange is shut", async () => {
    const feed = roundTheClockFeed(stocks, xstocks, twins, {
      session: () => "Closed",
    });
    const out = await feed.quote(["NVDA", "NVDAx"]);
    expect(stockAsked).toEqual([["NVDA"]]);
    expect(xAsked).toEqual([["NVDAx"]]);
    expect(out.find((q) => q.symbol === "NVDAx")?.price).toBe(101_000_000n);
  });

  it("resolves any casing to the configured spelling", () => {
    expect(canonicalSymbol("nvdax", ["AAPL", "NVDAx"])).toBe("NVDAx");
    expect(canonicalSymbol("MSFT", ["AAPL", "NVDAx"])).toBeNull();
  });

  it("matches the app's list of 24/7 markets", () => {
    const file = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../app/src/lib/markets.json"), "utf8"),
    ) as { markets: { symbol: string; schedule?: string; underlying?: string; mint?: string }[] };
    const app = file.markets
      .filter((m) => m.schedule === "24/7")
      .map((m) => ({ symbol: m.symbol, underlying: m.underlying, mint: m.mint }));
    expect(app).toEqual(
      ROUND_THE_CLOCK.map((m) => ({ symbol: m.symbol, underlying: m.underlying, mint: m.mint })),
    );
    // Every 24/7 market names a real underlying ticker the stock feed can
    // price in US hours; most are also listed as hours-bound markets.
    for (const m of ROUND_THE_CLOCK) {
      expect(m.underlying).toMatch(/^[A-Z.]{1,6}$/);
      expect(m.symbol).toBe(`${m.underlying}x`);
      expect(m.mint).toMatch(/^Xs/);
    }
    expect(ROUND_THE_CLOCK.length).toBeGreaterThanOrEqual(20);
  });
});

describe("the keeper opening and closing a 24/7 market", () => {
  const config = {
    connection: {} as never,
    payer: Keypair.generate(),
    programId: new PublicKey((idl as { address: string }).address),
    log: () => {},
  };
  const feedOf = (quotes: Quote[]): PriceFeed => ({ name: "t", quote: async () => quotes });
  // A Sunday, 3 a.m. New York: the exchange is shut.
  const SUNDAY = Math.floor(Date.UTC(2026, 8, 27, 7, 0, 0) / 1000);

  beforeEach(() => {
    sent.length = 0;
    reject = {};
  });

  it("opens on a fresh price at 3 a.m. on a Sunday, price first", async () => {
    const state = newKeeperState();
    const r = await keeperTick({
      config,
      feed: feedOf([quote("NVDAx", 180, SUNDAY)]),
      symbols: ["NVDA", "NVDAx"],
      state,
      alwaysOpen: new Set(["NVDAX"]),
      now: () => SUNDAY,
    });
    expect(r.published).toEqual(["NVDAx"]);
    const nvdax = sent.filter((l) => l.includes("NVDAx"));
    expect(nvdax).toEqual([
      "update_price_oracle NVDAx",
      "set_market_session NVDAx -> Open",
    ]);
    // The hours-bound market on the same stock stays closed.
    expect(sent).toContain("set_market_session NVDA -> Closed");
  });

  it("closes once no price has landed for the grace period, and not before", async () => {
    const state = newKeeperState();
    const tick = (t: number, quotes: Quote[]) =>
      keeperTick({
        config,
        feed: feedOf(quotes),
        symbols: ["NVDAx"],
        state,
        alwaysOpen: new Set(["NVDAX"]),
        now: () => t,
      });
    await tick(SUNDAY, [quote("NVDAx", 180, SUNDAY)]);
    sent.length = 0;

    await tick(SUNDAY + 20, []);
    expect(sent).toEqual([]);

    await tick(SUNDAY + NO_PRICE_GRACE_SECS + 1, []);
    expect(sent).toEqual(["set_market_session NVDAx -> Closed"]);

    // A refused price counts as no price: it never reached the chain.
    sent.length = 0;
    reject = { "update_price_oracle NVDAx": "OracleDeviationTooLarge" };
    await tick(SUNDAY + 120, [quote("NVDAx", 400, SUNDAY + 120)]);
    expect(sent).toEqual(["update_price_oracle NVDAx"]);

    // And a good one reopens it.
    sent.length = 0;
    reject = {};
    await tick(SUNDAY + 140, [quote("NVDAx", 181, SUNDAY + 140)]);
    expect(sent).toEqual([
      "update_price_oracle NVDAx",
      "set_market_session NVDAx -> Open",
    ]);
  });
});

describe("batched price updates", () => {
  const config = {
    connection: {} as never,
    payer: Keypair.generate(),
    programId: new PublicKey((idl as { address: string }).address),
    log: () => {},
  };
  // A Wednesday, 11 a.m. New York: the exchange is open.
  const OPEN = Math.floor(Date.UTC(2026, 8, 23, 15, 0, 0) / 1000);
  const syms = ["AAPL", "NVDA", "MSFT", "TSLA", "GOOGL", "AMZN", "META", "AVGO", "PLTR", "AMD"];

  beforeEach(() => {
    sent.length = 0;
    reject = {};
  });

  it("sends ten markets' prices in two transactions, not ten", async () => {
    const state = newKeeperState();
    for (const s of syms) state.sessions.set(s, "Open");
    const r = await keeperTick({
      config,
      feed: { name: "t", quote: async () => syms.map((s) => quote(s, 100, OPEN)) },
      symbols: syms,
      state,
      now: () => OPEN,
    });
    const prices = sent.filter((l) => l.startsWith("update_price_oracle"));
    expect(prices).toHaveLength(2);
    expect(prices[0].split(" ")[1].split(",")).toHaveLength(8);
    expect(r.published.sort()).toEqual([...syms].sort());
  });

  it("keeps a market that jumped past the cap out of the batch, and handles it last", async () => {
    const state = newKeeperState();
    for (const s of syms.slice(0, 3)) state.sessions.set(s, "Open");
    const r = await keeperTick({
      config,
      feed: { name: "t", quote: async () => syms.slice(0, 3).map((s) => quote(s, 100, OPEN)) },
      symbols: syms.slice(0, 3),
      state,
      catchUp: true,
      now: () => OPEN,
      // On chain: AAPL and MSFT near $100, NVDA still at a $60 seed.
      readPrices: async (oracles) =>
        oracles.map((_, i) => [99_000_000n, 60_000_000n, 101_000_000n][i] ?? null),
    });
    expect(sent).toEqual([
      "update_price_oracle AAPL,MSFT",
      "update_price_oracle NVDA (catching up)",
    ]);
    expect(r.published.sort()).toEqual(["AAPL", "MSFT"]);
  });

  it("falls back to one market at a time when the program rejects a batch", async () => {
    const state = newKeeperState();
    for (const s of syms.slice(0, 3)) state.sessions.set(s, "Open");
    reject = { "update_price_oracle AAPL,NVDA,MSFT": "OracleDeviationTooLarge", "update_price_oracle NVDA": "OracleDeviationTooLarge" };
    const r = await keeperTick({
      config,
      feed: { name: "t", quote: async () => syms.slice(0, 3).map((s) => quote(s, 100, OPEN)) },
      symbols: syms.slice(0, 3),
      state,
      now: () => OPEN,
    });
    expect(sent).toEqual([
      "update_price_oracle AAPL,NVDA,MSFT",
      "update_price_oracle AAPL",
      "update_price_oracle NVDA",
      "update_price_oracle MSFT",
    ]);
    expect(r.published).toEqual(["AAPL", "MSFT"]);
    expect(r.skipped).toContain("NVDA");
  });
});

function quote(symbol: string, dollars: number, printedAt = 1): Quote {
  return {
    symbol,
    price: BigInt(dollars * 1_000_000),
    confidence: 0n,
    printedAt,
    halted: false,
  };
}
