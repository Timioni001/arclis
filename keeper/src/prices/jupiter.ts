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

/** usdPrice by mint, from a Price API v3 response. */
export function parsePriceV3(payload: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!payload || typeof payload !== "object") return out;
  for (const [mint, raw] of Object.entries(payload as Record<string, unknown>)) {
    const p = Number((raw as { usdPrice?: unknown })?.usdPrice);
    if (Number.isFinite(p) && p > 0) out.set(mint, p);
  }
  return out;
}

interface SpreadCheck {
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  /** Unix seconds. */
  at: number;
  /** Why the check has no spread, when it has none. */
  error?: string;
}

/** A 24/7 feed that can say why a market it was asked for is not priced. */
export interface ExplainedFeed extends PriceFeed {
  /**
   * Why each market the last off-hours quote left unpriced, and when that
   * was (unix seconds; 0 before the first). While the US market is open the
   * 24/7 markets follow their stock and this is not consulted.
   */
  unpriced(): { at: number; markets: Record<string, string> };
}

/**
 * Prices every xStock in one request, and proves each market is real on a
 * rotation.
 *
 * Two live quotes per market per tick priced each one honestly, but at twenty
 * markets that was a hundred and twenty requests a minute, past the keyless
 * endpoint's limit. So the work is split by how fast each answer changes:
 *
 *   - **Price:** one Price API request for every mint, every tick.
 *   - **Is there a market:** a buy and a sell quote for a few markets per
 *     tick, oldest first, so each is re-proved every few minutes.
 *
 * A market is priced only while its last check is recent and its round trip
 * was under `maxSpreadBps`. The price is the price API's number while it sits
 * inside the two-sided market that check measured (widened by one spread, and
 * at least `minBandBps`); when it does not, the executable mid from a check
 * taken the same tick. A thin or stale book publishes nothing, and the keeper
 * closes the market to new risk, exactly as before.
 */
export function jupiterXStockFeed(
  sources: XStockSource[],
  options: JupiterOptions & {
    /** Markets whose spread is re-proved each tick. */
    checksPerTick?: number;
    /**
     * Extra checks each tick for markets the last tick could not settle: a
     * quote request that failed, or a price API number the executable market
     * disagreed with. Those are priced from a check taken that same tick.
     */
    urgentPerTick?: number;
    /** Seconds before a market's spread is due for a re-check. */
    recheckSecs?: number;
    /** A check older than this no longer counts. */
    maxCheckAgeSecs?: number;
    /**
     * The least the price may sit outside the checked bid and ask, in basis
     * points of the mid. A deep book quotes a spread of a few basis points,
     * and a band that narrow refuses the price API's number for drifting
     * less than the market moves between checks.
     */
    minBandBps?: number;
  } = {},
): ExplainedFeed {
  const baseUrl =
    options.baseUrl ??
    (options.apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag");
  const headers: Record<string, string> = options.apiKey
    ? { "x-api-key": options.apiKey }
    : {};
  const clipUsd = options.clipUsd ?? 1_000;
  const maxSpreadBps = options.maxSpreadBps ?? 300;
  const checksPerTick = options.checksPerTick ?? 3;
  const urgentPerTick = options.urgentPerTick ?? 2;
  const recheckSecs = options.recheckSecs ?? 180;
  const maxCheckAgeSecs = options.maxCheckAgeSecs ?? 600;
  const minBandBps = options.minBandBps ?? 100;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const fetchJson = options.fetchJson ?? getJson;
  const bySymbol = new Map(sources.map((s) => [s.symbol.toUpperCase(), s]));
  // The last check that measured a market, kept through a failed one.
  const checks = new Map<string, SpreadCheck>();
  // The most recent failure since then, for the reason a market is closed.
  const failures = new Map<string, { at: number; error: string }>();
  // Markets to re-prove next tick, ahead of the rotation.
  const urgent = new Set<string>();
  let reasons: { at: number; markets: Record<string, string> } = { at: 0, markets: {} };

  const quoteUrl = (inputMint: string, outputMint: string, amount: bigint) =>
    `${baseUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amount}&slippageBps=50&restrictIntermediateTokens=true`;

  async function checkSpread(source: XStockSource, at: number): Promise<SpreadCheck> {
    const failed = (error: string): SpreadCheck =>
      ({ bid: 0, ask: 0, mid: 0, spreadBps: Infinity, at, error });
    const unit = 10 ** source.decimals;
    const buy = parseOutAmount(
      await fetchJson(
        quoteUrl(USDC_MINT, source.mint, BigInt(clipUsd * 10 ** USDC_DECIMALS)),
        headers,
      ),
    );
    if (!buy) return failed("no Jupiter route to buy");
    const shares = Number(buy) / unit;
    // Sell back the same number of shares, so both legs are the same size.
    const sell = parseOutAmount(await fetchJson(quoteUrl(source.mint, USDC_MINT, buy), headers));
    if (!sell) return failed("no Jupiter route to sell");
    const m = midFromQuotes(clipUsd, shares, shares, Number(sell) / 10 ** USDC_DECIMALS);
    if (!m) return failed("quotes gave no usable mid");
    return {
      bid: m.mid - m.halfSpread,
      ask: m.mid + m.halfSpread,
      mid: m.mid,
      spreadBps: m.spreadBps,
      at,
    };
  }

  return {
    name: "jupiter",
    unpriced: () => reasons,
    async quote(symbols) {
      const wanted = symbols
        .map((s) => bySymbol.get(s.toUpperCase()))
        .filter((s): s is XStockSource => Boolean(s));
      if (wanted.length === 0) return [];
      const t = now();

      const lastTry = (sym: string) =>
        Math.max(checks.get(sym)?.at ?? 0, failures.get(sym)?.at ?? 0);
      // Markets the last tick could not settle go first, longest waiting
      // first; then the rotation re-proves the rest, never-checked and oldest
      // first.
      const priority = wanted
        .filter((s) => urgent.has(s.symbol))
        .sort((a, b) => lastTry(a.symbol) - lastTry(b.symbol))
        .slice(0, urgentPerTick);
      const rotation = wanted
        .filter(
          (s) =>
            !urgent.has(s.symbol) &&
            t - (checks.get(s.symbol)?.at ?? -Infinity) >= recheckSecs,
        )
        .sort((a, b) => (checks.get(a.symbol)?.at ?? 0) - (checks.get(b.symbol)?.at ?? 0))
        .slice(0, checksPerTick);

      const check = async (s: XStockSource) => {
        let c: SpreadCheck;
        try {
          c = await checkSpread(s, t);
        } catch (e) {
          const error = `quote request failed: ${String(e).slice(0, 120)}`;
          c = { bid: 0, ask: 0, mid: 0, spreadBps: Infinity, at: t, error };
        }
        if (c.error) {
          // One failed request says little about the market; the last good
          // check still stands until it ages out, and this one is retried.
          failures.set(s.symbol, { at: t, error: c.error });
          urgent.add(s.symbol);
        } else {
          checks.set(s.symbol, c);
          failures.delete(s.symbol);
          urgent.delete(s.symbol);
        }
      };

      const [priced] = await Promise.all([
        fetchJson(`${baseUrl}/price/v3?ids=${wanted.map((s) => s.mint).join(",")}`, headers)
          .then(parsePriceV3)
          .catch(() => new Map<string, number>()),
        Promise.allSettled([...priority, ...rotation].map(check)),
      ]);

      const out: Quote[] = [];
      const why: Record<string, string> = {};
      for (const s of wanted) {
        const c = checks.get(s.symbol);
        const failed = failures.get(s.symbol)?.error;
        if (!c) {
          why[s.symbol] = failed ?? "waiting for its first spread check";
          continue;
        }
        if (t - c.at > maxCheckAgeSecs) {
          why[s.symbol] = failed ?? `last spread check is ${t - c.at}s old`;
          continue;
        }
        if (!(c.spreadBps <= maxSpreadBps)) {
          why[s.symbol] =
            `round trip costs ${Math.round(c.spreadBps)} bps, over the ${maxSpreadBps} bps limit`;
          continue;
        }
        // The price API's number while it agrees with the executable market.
        // When it does not (on a thin weekend book it can lag the pools by a
        // few percent) or has nothing, the price is the executable mid, but
        // only from a check taken this tick; otherwise the market is
        // re-proved next tick, ahead of the rotation.
        const api = priced.get(s.mint);
        const width = Math.max(c.ask - c.bid, (c.mid * minBandBps) / 10_000);
        const agrees = api !== undefined && api >= c.bid - width && api <= c.ask + width;
        if (!agrees) urgent.add(s.symbol);
        const price = agrees ? api : c.at === t ? c.mid : undefined;
        if (price === undefined) {
          why[s.symbol] =
            api === undefined
              ? "no price from the Jupiter price API; re-checking the executable market"
              : `price API reads ${api.toFixed(2)}, outside the executable market ` +
                `${c.bid.toFixed(2)}-${c.ask.toFixed(2)}; re-checking`;
          continue;
        }
        try {
          out.push({
            symbol: s.symbol,
            price: toFixed(price),
            confidence: toFixed((c.ask - c.bid) / 2),
            printedAt: t,
            halted: false,
          });
        } catch {
          why[s.symbol] = "unusable number from Jupiter";
        }
      }
      reasons = { at: t, markets: why };
      return out;
    },
  };
}
