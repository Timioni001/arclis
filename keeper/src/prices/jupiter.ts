/**
 * An xStock's own price on Solana, from Jupiter: the price of a 24/7 market
 * while the US exchange is shut.
 *
 * xStocks trade around the clock on Solana DEXs. At 3 a.m. on a Sunday there
 * is no NYSE print, but there is a pool someone can actually buy and sell the
 * token against, and that is a real price in the only sense that matters to a
 * perp: an executable one.
 *
 * So this does not read a "last traded price", which can be hours old at that
 * hour. It asks Jupiter for two live quotes, buying and selling a fixed dollar
 * clip, and publishes the midpoint:
 *
 *   - **The price** is the mid of the two executable rates.
 *   - **The confidence** is half the round-trip spread, which is the honest
 *     width of that market right now.
 *   - **The timestamp** is the moment of the quote. For an executable quote
 *     that is the truth, not laundering: it is the price available now.
 *
 * And it refuses when the market is too thin to be a price. A spread wider
 * than `maxSpreadBps` publishes nothing; the keeper then treats the market as
 * closed (exits only) until a real two-sided market returns. Thin overnight
 * liquidity is the obvious attack on a 24/7 perp, and the answer is to stop
 * pretending there is a price, not to publish a bad one carefully.
 */

import { toFixed, type PriceFeed, type Quote } from "./types";

const TIMEOUT_MS = 8_000;
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;

export interface XStockSource {
  /** Our market symbol, e.g. `NVDAx`. */
  symbol: string;
  /** The xStock's mainnet mint. */
  mint: string;
  /**
   * Token decimals (xStocks use 8). A wrong value scales the price by a power
   * of ten, which the program's 10% per-update cap rejects rather than
   * publishes.
   */
  decimals: number;
}

export interface JupiterOptions {
  /** Default: the keyless lite endpoint. */
  baseUrl?: string;
  apiKey?: string;
  /** Size of each probe, in whole USDC. */
  clipUsd?: number;
  /** Refuse to price a market whose round trip costs more than this. */
  maxSpreadBps?: number;
  now?: () => number;
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown>;
}

async function getJson(url: string, headers: Record<string, string>) {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/** `outAmount` from a `/swap/v1/quote` response, or null. */
export function parseOutAmount(payload: unknown): bigint | null {
  const out = String((payload as { outAmount?: unknown })?.outAmount ?? "");
  return /^\d+$/.test(out) && out !== "0" ? BigInt(out) : null;
}

/**
 * Mid and half-spread from a buy and a sell quote, in dollars per share.
 *
 * `buyShares` is what `clipUsd` bought; `sellUsd` is what selling
 * `sellShares` returned. Both in whole units.
 */
export function midFromQuotes(
  clipUsd: number,
  buyShares: number,
  sellShares: number,
  sellUsd: number,
): { mid: number; halfSpread: number; spreadBps: number } | null {
  if (!(buyShares > 0 && sellShares > 0 && sellUsd > 0)) return null;
  const ask = clipUsd / buyShares;
  const bid = sellUsd / sellShares;
  if (!(ask > 0 && bid > 0) || bid > ask * 1.001) return null;
  const mid = (ask + bid) / 2;
  const halfSpread = Math.max(0, (ask - bid) / 2);
  return { mid, halfSpread, spreadBps: (2 * halfSpread * 10_000) / mid };
}

export function jupiterXStockFeed(
  sources: XStockSource[],
  options: JupiterOptions = {},
): PriceFeed {
  const baseUrl =
    options.baseUrl ??
    (options.apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag");
  const headers: Record<string, string> = options.apiKey
    ? { "x-api-key": options.apiKey }
    : {};
  const clipUsd = options.clipUsd ?? 1_000;
  const maxSpreadBps = options.maxSpreadBps ?? 300;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const fetchJson = options.fetchJson ?? getJson;
  const bySymbol = new Map(sources.map((s) => [s.symbol.toUpperCase(), s]));

  const quoteUrl = (inputMint: string, outputMint: string, amount: bigint) =>
    `${baseUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amount}&slippageBps=50&restrictIntermediateTokens=true`;

  async function priceOne(source: XStockSource): Promise<Quote | null> {
    const unit = 10 ** source.decimals;
    const buy = parseOutAmount(
      await fetchJson(
        quoteUrl(USDC_MINT, source.mint, BigInt(clipUsd * 10 ** USDC_DECIMALS)),
        headers,
      ),
    );
    if (!buy) return null;
    const buyShares = Number(buy) / unit;
    // Sell back the same number of shares, so both legs are the same size.
    const sell = parseOutAmount(
      await fetchJson(quoteUrl(source.mint, USDC_MINT, buy), headers),
    );
    if (!sell) return null;
    const m = midFromQuotes(
      clipUsd,
      buyShares,
      buyShares,
      Number(sell) / 10 ** USDC_DECIMALS,
    );
    if (!m || m.spreadBps > maxSpreadBps) return null;
    return {
      symbol: source.symbol,
      price: toFixed(m.mid),
      confidence: toFixed(m.halfSpread),
      printedAt: now(),
      halted: false,
    };
  }

  return {
    name: "jupiter",
    async quote(symbols) {
      const wanted = symbols
        .map((s) => bySymbol.get(s.toUpperCase()))
        .filter((s): s is XStockSource => Boolean(s));
      const results = await Promise.allSettled(wanted.map(priceOne));
      return results.flatMap((r) =>
        r.status === "fulfilled" && r.value ? [r.value] : [],
      );
    },
  };
}
