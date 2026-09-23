/**
 * Historical market data for the interface's charts and daily change.
 *
 * # Why this exists
 *
 * The oracle has a price history only as long as the deployment has been
 * publishing: days, not years. A chart of a listed stock is expected to go
 * back years, and a "today" percentage is expected to be measured against the
 * previous session's close. Neither can come from the chain, so both come from
 * market data, fetched here and served to the browser.
 *
 * # Sources
 *
 * - Yahoo Finance's chart endpoint, for daily bars over the full listing
 *   history and 15-minute bars over the last month. Free and keyless, but
 *   unofficial: it can change shape or rate limit without notice, so every
 *   read is defensive and the last good copy is kept.
 * - Stooq's daily CSV, as the fallback for daily bars.
 *
 * Neither can be called from a browser: both refuse cross-origin requests.
 * The keeper fetches them server-side, caches the result, and refreshes on a
 * slow schedule, so visitors never touch either provider.
 *
 * These bars describe the underlying listed stock. The perpetual's own price
 * is the oracle's, which the keeper publishes from the same stock's quotes;
 * the interface draws the history from here and the live bar from the chain.
 */

export interface Bar {
  /** Bar open, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Interval = "1d" | "15m";

const TIMEOUT_MS = 15_000;

/**
 * Yahoo rejects requests without a browser-like User-Agent. This is the
 * documented behaviour of the endpoint, not an attempt to disguise the caller.
 */
const HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; arclis-keeper/1.0)",
  accept: "application/json,text/csv,*/*",
};

// ---------------------------------------------------------------------------
// Parsers: pure, and tested against the providers' documented formats.
// ---------------------------------------------------------------------------

/**
 * Bars out of a Yahoo `/v8/finance/chart` response.
 *
 * Shape: `chart.result[0].timestamp[]` alongside
 * `indicators.quote[0].{open,high,low,close,volume}[]`. Entries are null for
 * intervals with no trading (a halt, a holiday row), and those are dropped
 * rather than drawn as zeros. `close` is split-adjusted, which is what a
 * price chart should show: a 4:1 split is not a 75% crash.
 */
export function parseYahooChart(json: unknown): Bar[] {
  const result = (json as any)?.chart?.result?.[0];
  const ts: unknown[] = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0] ?? {};
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = Number(ts[i]);
    const o = Number(q.open?.[i]);
    const h = Number(q.high?.[i]);
    const l = Number(q.low?.[i]);
    const c = Number(q.close?.[i]);
    if (![t, o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
    if (q.close?.[i] == null) continue;
    bars.push({ t, o, h, l, c, v: Number(q.volume?.[i]) || 0 });
  }
  return bars.sort((a, b) => a.t - b.t);
}

/** Yahoo's reported previous close, when the response carries one. */
export function yahooPreviousClose(json: unknown): number | null {
  const meta = (json as any)?.chart?.result?.[0]?.meta;
  const pc = Number(meta?.regularMarketPreviousClose ?? meta?.previousClose);
  return Number.isFinite(pc) && pc > 0 ? pc : null;
}

/**
 * Bars out of a Stooq daily CSV: `Date,Open,High,Low,Close,Volume`.
 *
 * Stooq answers an unknown symbol, or a rate-limited caller, with a short
 * plain-text message instead of CSV; anything without the header is treated
 * as no data rather than parsed.
 */
export function parseStooqCsv(text: string): Bar[] {
  const lines = text.trim().split(/\r?\n/);
  if (!/^Date,Open,High,Low,Close/i.test(lines[0] ?? "")) return [];
  const bars: Bar[] = [];
  for (const line of lines.slice(1)) {
    const [date, o, h, l, c, v] = line.split(",");
    const t = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
    const bar = { t, o: +o, h: +h, l: +l, c: +c, v: +v || 0 };
    if ([bar.t, bar.o, bar.h, bar.l, bar.c].every((x) => Number.isFinite(x) && x > 0)) {
      bars.push(bar);
    }
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function get(url: string, fetchImpl: typeof fetch): Promise<Response> {
  const res = await fetchImpl(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res;
}

export async function fetchYahoo(
  symbol: string,
  interval: Interval,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bars: Bar[]; previousClose: number | null }> {
  // 15-minute bars are available for the last 60 days; a month is plenty for
  // the 1D, 1W and 1M views and keeps the payload small.
  const range = interval === "1d" ? "max" : "1mo";
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}&includePrePost=false&events=split`;
  const json = await (await get(url, fetchImpl)).json();
  return { bars: parseYahooChart(json), previousClose: yahooPreviousClose(json) };
}

export async function fetchStooqDaily(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Bar[]> {
  const s = `${symbol.toLowerCase().replace(".", "-")}.us`;
  const text = await (await get(`https://stooq.com/q/d/l/?s=${s}&i=d`, fetchImpl)).text();
  return parseStooqCsv(text);
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

interface Entry {
  bars: Bar[];
  source: string;
  fetchedAt: number;
}

export class MarketData {
  private readonly daily = new Map<string, Entry>();
  private readonly intraday = new Map<string, Entry>();
  private readonly previousClose = new Map<string, number>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (level: "info" | "warn", msg: string, extra?: unknown) => void = () => {},
  ) {}

  /**
   * Refresh every symbol, one request at a time.
   *
   * Sequential and spaced: this is two requests per market to free endpoints
   * that rate limit bursts, and nothing here is urgent. A failure keeps the
   * previous copy; a chart drawn from yesterday's daily bars is still right
   * about every day but today, and today comes from the chain.
   */
  async refresh(symbols: string[], which: Interval, spacingMs = 750): Promise<void> {
    for (const symbol of symbols) {
      try {
        if (which === "1d") await this.refreshDaily(symbol);
        else await this.refreshIntraday(symbol);
      } catch (e) {
        this.log("warn", "market data refresh failed", {
          symbol,
          interval: which,
          message: String((e as Error)?.message ?? e).slice(0, 200),
        });
      }
      await new Promise((r) => setTimeout(r, spacingMs));
    }
  }

  private async refreshDaily(symbol: string) {
    let bars: Bar[] = [];
    let source = "yahoo";
    try {
      const y = await fetchYahoo(symbol, "1d", this.fetchImpl);
      bars = y.bars;
      if (y.previousClose) this.previousClose.set(symbol, y.previousClose);
    } catch (e) {
      this.log("warn", "yahoo daily failed; trying stooq", {
        symbol,
        message: String((e as Error)?.message ?? e).slice(0, 160),
      });
    }
    if (bars.length === 0) {
      bars = await fetchStooqDaily(symbol, this.fetchImpl);
      source = "stooq";
    }
    if (bars.length) this.daily.set(symbol, { bars, source, fetchedAt: Date.now() });
  }

  private async refreshIntraday(symbol: string) {
    const y = await fetchYahoo(symbol, "15m", this.fetchImpl);
    if (y.bars.length) {
      this.intraday.set(symbol, { bars: y.bars, source: "yahoo", fetchedAt: Date.now() });
    }
  }

  candles(symbol: string, interval: Interval) {
    const entry = (interval === "1d" ? this.daily : this.intraday).get(symbol);
    return {
      symbol,
      interval,
      source: entry?.source ?? null,
      fetchedAt: entry ? Math.floor(entry.fetchedAt / 1000) : null,
      bars: entry?.bars ?? [],
    };
  }

  /**
   * What the overview needs for every market in one document: the previous
   * session's close and the last month of daily closes for a sparkline.
   *
   * The previous close prefers the live price feed's figure (passed in, from
   * Finnhub's `pc`), then Yahoo's, then the daily bars themselves: the last
   * completed day's close, which is the second-to-last bar while a session
   * is in progress.
   */
  summary(symbols: string[], feedPreviousClose: Map<string, number>) {
    const today = new Date().toISOString().slice(0, 10);
    const out: Record<string, { previousClose: number | null; closes: number[] }> = {};
    for (const symbol of symbols) {
      const bars = this.daily.get(symbol)?.bars ?? [];
      const last = bars[bars.length - 1];
      const lastIsToday =
        last && new Date(last.t * 1000).toISOString().slice(0, 10) === today;
      const fromBars = (lastIsToday ? bars[bars.length - 2] : last)?.c ?? null;
      out[symbol] = {
        previousClose:
          feedPreviousClose.get(symbol) ?? this.previousClose.get(symbol) ?? fromBars,
        closes: bars.slice(-30).map((b) => b.c),
      };
    }
    return { symbols: out };
  }
}
