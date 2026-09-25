/**
 * Concrete price feeds.
 *
 * Three real providers and one simulator. None of the three could be reached
 * from the environment this was written in, so each `parse` function is
 * isolated and written defensively: the request shape comes from each
 * provider's documented REST API, and the parse coerces every field and drops
 * anything it cannot read rather than producing a `NaN` price.
 *
 * A `NaN` reaching `toFixed` throws, which is the intended outcome: the keeper
 * skips that symbol and leaves the last good on-chain price in place. Nothing
 * here ever invents a number.
 */

import {
  confidenceFromPct,
  toFixed,
  type PriceFeed,
  type Quote,
} from "./types";

const TIMEOUT_MS = 8_000;

async function getJson(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Polygon.io
// ---------------------------------------------------------------------------

/**
 * Polygon's snapshot endpoint returns every ticker in one call, which matters:
 * quoting five symbols individually is five chances to get five prices from
 * five different instants, and the book would be marked against a blend.
 */
export function polygonFeed(apiKey: string): PriceFeed {
  return {
    name: "polygon",
    async quote(symbols) {
      const list = symbols.join(",");
      const payload = (await getJson(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${list}&apiKey=${apiKey}`,
      )) as { tickers?: unknown[] };

      const out: Quote[] = [];
      for (const raw of payload.tickers ?? []) {
        const t = raw as Record<string, any>;
        const last = t.lastTrade ?? {};
        const price = Number(last.p);
        if (!Number.isFinite(price) || price <= 0) continue;

        out.push({
          symbol: String(t.ticker ?? "").toUpperCase(),
          price: toFixed(price),
          // Half the bid-ask spread where a quote is present, which is the
          // honest confidence interval: it is the width of the market.
          confidence: spreadConfidence(t.lastQuote, price),
          // Polygon reports trade time in nanoseconds.
          printedAt:
            Math.floor(Number(last.t ?? 0) / 1e9) ||
            Math.floor(Date.now() / 1000),
          halted: String(t.status ?? "").toLowerCase() === "halted",
        });
      }
      return out;
    },
  };
}

function spreadConfidence(quote: unknown, price: number): bigint {
  const q = quote as Record<string, any> | undefined;
  const bid = Number(q?.p);
  const ask = Number(q?.P);
  if (Number.isFinite(bid) && Number.isFinite(ask) && ask > bid && bid > 0) {
    return toFixed((ask - bid) / 2);
  }
  // No quote available: 5 bps of price as a floor rather than claiming
  // certainty the feed did not give.
  return confidenceFromPct(price, 0.05);
}

// ---------------------------------------------------------------------------
// Finnhub
// ---------------------------------------------------------------------------

/**
 * Finnhub quotes one symbol per call, so this fans out and tolerates partial
 * failure: one symbol erroring must not cost the other four their update.
 */
export function finnhubFeed(apiKey: string): PriceFeed {
  return {
    name: "finnhub",
    async quote(symbols) {
      const results = await Promise.allSettled(
        symbols.map(async (symbol) => {
          const q = (await getJson(
            `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`,
          )) as Record<string, any>;
          const price = Number(q.c);
          if (!Number.isFinite(price) || price <= 0) return null;
          return {
            symbol,
            price: toFixed(price),
            confidence: confidenceFromPct(price, 0.05),
            printedAt: Number(q.t) || Math.floor(Date.now() / 1000),
            halted: false, // Finnhub's free quote endpoint does not report it.
            // `pc`: the previous session's close, on the free tier.
            previousClose: Number(q.pc) > 0 ? Number(q.pc) : undefined,
          } satisfies Quote;
        }),
      );

      return results.flatMap((r) =>
        r.status === "fulfilled" && r.value ? [r.value] : [],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Alpaca
// ---------------------------------------------------------------------------

/**
 * Alpaca's latest-trade endpoint prices every symbol in one request, which is
 * what lets the market count grow past Finnhub's sixty calls a minute.
 *
 * `feed=iex` is what a free Alpaca account may read in real time: trades on
 * the IEX exchange, a slice of consolidated volume but real prints with real
 * timestamps. A paid account can pass `sip` for the full tape.
 */
export function alpacaFeed(
  keyId: string,
  secret: string,
  dataFeed: "iex" | "sip" = "iex",
  fetchJson: (url: string, headers: Record<string, string>) => Promise<unknown> = getJson,
): PriceFeed {
  return {
    name: "alpaca",
    async quote(symbols) {
      const payload = (await fetchJson(
        `https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${symbols
          .map(encodeURIComponent)
          .join(",")}&feed=${dataFeed}`,
        { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret },
      )) as { trades?: Record<string, any> };

      const out: Quote[] = [];
      for (const [symbol, trade] of Object.entries(payload.trades ?? {})) {
        const price = Number(trade?.p);
        if (!Number.isFinite(price) || price <= 0) continue;
        out.push({
          symbol: symbol.toUpperCase(),
          price: toFixed(price),
          confidence: confidenceFromPct(price, 0.05),
          printedAt:
            Math.floor(Date.parse(String(trade?.t ?? "")) / 1000) ||
            Math.floor(Date.now() / 1000),
          // Alpaca encodes halts in the trade condition codes.
          halted: Array.isArray(trade?.c) && trade.c.includes("H"),
        });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Simulated
// ---------------------------------------------------------------------------

/**
 * A deterministic feed for a local validator.
 *
 * Exists so the whole keeper, crank and liquidator stack can be run end to end
 * with no market data subscription and no network. It is a seeded random walk,
 * so the same seed produces the same prices and a failing scenario can be
 * replayed exactly.
 *
 * It is deliberately volatile: a 1% per-step standard deviation gets a
 * position to its liquidation price in minutes rather than days, which is what
 * makes it useful for exercising the liquidator.
 */
export function simulatedFeed(
  seeds: Record<string, number>,
  options: { seed?: number; volatilityPct?: number } = {},
): PriceFeed {
  const state = new Map(Object.entries(seeds));
  // Mulberry32: a small, fast PRNG with a well-distributed output. The point
  // is reproducibility, not cryptographic quality.
  let s = options.seed ?? 0x9e3779b9;
  const random = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vol = (options.volatilityPct ?? 1) / 100;

  return {
    name: "simulated",
    async quote(symbols) {
      const now = Math.floor(Date.now() / 1000);
      return symbols.flatMap((symbol) => {
        const current = state.get(symbol);
        if (current === undefined) return [];
        // Box-Muller for a normal step, so the walk has realistic tails rather
        // than the uniform steps a bare `random()` would give.
        const u1 = Math.max(random(), 1e-9);
        const u2 = random();
        const normal =
          Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const next = Math.max(0.01, current * (1 + normal * vol));
        state.set(symbol, next);
        return [
          {
            symbol,
            price: toFixed(next),
            confidence: confidenceFromPct(next, 0.05),
            printedAt: now,
            halted: false,
          },
        ];
      });
    },
  };
}
