/**
 * 24/7 markets: perps on an xStock that never close.
 *
 * Every other Arclis market follows the NYSE calendar, because a perp on a
 * stock that keeps selling leverage against a price nobody can know is the
 * failure this protocol was built to prevent. These markets keep that rule by
 * changing the answer to "is there a price?", not by ignoring the question:
 *
 *   - **US market open:** priced from the listed stock, exactly like the
 *     hours-bound market on the same underlying.
 *   - **US market closed:** priced from the xStock itself, which trades around
 *     the clock on Solana, using live executable Jupiter quotes (see
 *     `prices/jupiter.ts`).
 *   - **No trustworthy price either way:** the market behaves like a closed
 *     stock. The keeper publishes `Closed`, so exits still work against the
 *     last price and nobody can add risk until a real price returns.
 *
 * The program needs no special case for any of this. A market's session is
 * whatever its oracle says, so an always-open market is a keeper schedule,
 * and the lower leverage these carry is set when each market is created.
 */

import { sessionAt, type MarketSession } from "./calendar";
import type { PriceFeed, Quote } from "./prices/types";

export interface RoundTheClockMarket {
  /** The market's symbol on chain, e.g. `NVDAx`. */
  symbol: string;
  /** The listed stock it tracks while the US market is open. */
  underlying: string;
  /** The xStock's mainnet mint, priced through Jupiter otherwise. */
  mint: string;
  decimals: number;
}

/**
 * The 24/7 markets. Kept equal to the `"schedule": "24/7"` entries in
 * `app/src/lib/markets.json` by a test, because the keeper image does not
 * carry the app's files.
 */
export const ROUND_THE_CLOCK: RoundTheClockMarket[] = [
  { symbol: "AAPLx", underlying: "AAPL", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8 },
  { symbol: "NVDAx", underlying: "NVDA", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", decimals: 8 },
  { symbol: "TSLAx", underlying: "TSLA", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", decimals: 8 },
  { symbol: "SPYx", underlying: "SPY", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", decimals: 8 },
  { symbol: "QQQx", underlying: "QQQ", mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", decimals: 8 },
  { symbol: "MSTRx", underlying: "MSTR", mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", decimals: 8 },
  { symbol: "COINx", underlying: "COIN", mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu", decimals: 8 },
  { symbol: "HOODx", underlying: "HOOD", mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg", decimals: 8 },
  { symbol: "PLTRx", underlying: "PLTR", mint: "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4", decimals: 8 },
  { symbol: "MSFTx", underlying: "MSFT", mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", decimals: 8 },
  { symbol: "GOOGLx", underlying: "GOOGL", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", decimals: 8 },
  { symbol: "METAx", underlying: "META", mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", decimals: 8 },
  { symbol: "AMZNx", underlying: "AMZN", mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", decimals: 8 },
  { symbol: "AVGOx", underlying: "AVGO", mint: "XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo", decimals: 8 },
  { symbol: "CRCLx", underlying: "CRCL", mint: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1", decimals: 8 },
  { symbol: "GLDx", underlying: "GLD", mint: "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re", decimals: 8 },
  { symbol: "MCDx", underlying: "MCD", mint: "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2", decimals: 8 },
  { symbol: "KOx", underlying: "KO", mint: "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ", decimals: 8 },
  { symbol: "GMEx", underlying: "GME", mint: "Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc", decimals: 8 },
  { symbol: "DFDVx", underlying: "DFDV", mint: "Xs2yquAgsHByNzx68WJC55WHjHBvG9JsMB7CWjTLyPy", decimals: 8 },
];

/**
 * Symbols are matched case-insensitively everywhere a person or a URL can
 * supply one, and resolved to the configured spelling: `nvdax` in a query
 * string is `NVDAx`, never a second market.
 */
export function canonicalSymbol(symbol: string, known: string[]): string | null {
  const upper = symbol.trim().toUpperCase();
  return known.find((k) => k.toUpperCase() === upper) ?? null;
}

/**
 * One feed for every market, choosing each 24/7 market's source by the clock.
 *
 * Hours-bound symbols go to `stocks` as always. A 24/7 symbol asks `stocks`
 * for its underlying while the exchange is open and `xstocks` otherwise, and
 * the quote comes back under the 24/7 symbol. Each 24/7 market has exactly
 * one source at any instant; this is a schedule, not a fallback.
 */
export function roundTheClockFeed(
  stocks: PriceFeed,
  xstocks: PriceFeed,
  markets: RoundTheClockMarket[],
  options: { now?: () => number; session?: (t: number) => MarketSession } = {},
): PriceFeed {
  const bySymbol = new Map(markets.map((m) => [m.symbol.toUpperCase(), m]));
  const session = options.session ?? sessionAt;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    name: `${stocks.name}+${xstocks.name}`,
    async quote(symbols) {
      const exchangeOpen = session(now()) === "Open";
      const plain: string[] = [];
      const twins: RoundTheClockMarket[] = [];
      for (const s of symbols) {
        const m = bySymbol.get(s.toUpperCase());
        if (m) twins.push(m);
        else plain.push(s);
      }

      const fromStocks = [
        ...new Set([
          ...plain,
          ...(exchangeOpen ? twins.map((m) => m.underlying) : []),
        ]),
      ];
      const fromXStocks = exchangeOpen ? [] : twins.map((m) => m.symbol);

      const [a, b] = await Promise.allSettled([
        fromStocks.length ? stocks.quote(fromStocks) : Promise.resolve([]),
        fromXStocks.length ? xstocks.quote(fromXStocks) : Promise.resolve([]),
      ]);
      if (a.status === "rejected" && (b.status === "rejected" || !fromXStocks.length)) {
        throw a.reason;
      }
      const stockQuotes = a.status === "fulfilled" ? a.value : [];
      const xQuotes = b.status === "fulfilled" ? b.value : [];

      const byUnderlying = new Map(stockQuotes.map((q) => [q.symbol.toUpperCase(), q]));
      const wantedPlain = new Set(plain.map((s) => s.toUpperCase()));
      const out: Quote[] = stockQuotes.filter((q) =>
        wantedPlain.has(q.symbol.toUpperCase()),
      );
      if (exchangeOpen) {
        for (const m of twins) {
          const q = byUnderlying.get(m.underlying.toUpperCase());
          if (q) out.push({ ...q, symbol: m.symbol });
        }
      } else {
        out.push(...xQuotes);
      }
      return out;
    },
  };
}
