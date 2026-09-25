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
  it("prices every symbol in one request on the free IEX feed", async () => {
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
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("symbols=AAPL,NVDA,MSFT");
    expect(urls[0]).toContain("feed=iex");
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
    // Every 24/7 market's underlying is itself listed, so it has a price and
    // a chart history to borrow.
    for (const m of ROUND_THE_CLOCK) {
      expect(file.markets.some((x) => x.symbol === m.underlying)).toBe(true);
    }
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
