/**
 * Daily market news for the Overview: stocks, and Solana.
 *
 * Fetched here rather than in the browser for the same reason as market data:
 * the provider needs a key, and nothing prefixed `VITE_` can hold one. The
 * keeper already has a Finnhub key, and two requests every fifteen minutes is
 * nothing next to its sixty a minute.
 *
 *   - **Stocks:** Finnhub's general market news.
 *   - **Solana:** Finnhub's crypto news, Solana stories first. A quiet day for
 *     Solana is filled from the rest of the crypto wire, and each item says
 *     whether it is about Solana, so the interface never labels a Bitcoin
 *     story as Solana news.
 *
 * Headlines are third-party text shown on our page, so everything is coerced
 * to plain strings, links must be http(s), and anything malformed is dropped.
 */

export interface NewsItem {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  image: string | null;
  /** Unix seconds. */
  datetime: number;
  /** A crypto item that is about Solana. Always false for stock news. */
  solana: boolean;
}

export interface NewsSnapshot {
  updatedAt: number;
  stocks: NewsItem[];
  solana: NewsItem[];
}

const PER_SECTION = 12;
const SUMMARY_CHARS = 240;
const TIMEOUT_MS = 10_000;

const SOLANA = /\bsolana\b|\bSOL\b|\bjupiter\b|\bphantom\b|pump\.fun|\bxstocks?\b|\bbonk\b|\braydium\b|\bmeteora\b|\bhelius\b/i;

function safeUrl(raw: unknown): string | null {
  try {
    const u = new URL(String(raw ?? ""));
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function plain(raw: unknown, max: number): string {
  const text = String(raw ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Items out of a Finnhub `/news` response, newest first, deduplicated. */
export function parseNews(payload: unknown, kind: "stocks" | "crypto"): NewsItem[] {
  if (!Array.isArray(payload)) return [];
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const raw of payload) {
    const r = raw as Record<string, unknown>;
    const url = safeUrl(r?.url);
    const headline = plain(r?.headline, 200);
    const datetime = Number(r?.datetime);
    if (!url || !headline || !Number.isFinite(datetime) || datetime <= 0) continue;
    const key = headline.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const summary = plain(r?.summary, SUMMARY_CHARS);
    out.push({
      id: String(r?.id ?? url),
      headline,
      summary,
      source: plain(r?.source, 60) || new URL(url).hostname.replace(/^www\./, ""),
      url,
      image: safeUrl(r?.image),
      datetime: Math.floor(datetime),
      solana: kind === "crypto" && SOLANA.test(`${headline} ${summary}`),
    });
  }
  return out.sort((a, b) => b.datetime - a.datetime);
}

/** Solana stories first, then the rest of the crypto wire to fill the list. */
export function solanaFirst(items: NewsItem[], limit = PER_SECTION): NewsItem[] {
  return [...items.filter((i) => i.solana), ...items.filter((i) => !i.solana)].slice(
    0,
    limit,
  );
}

export class News {
  private snapshot: NewsSnapshot | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (level: "info" | "warn", msg: string, extra?: unknown) => void = () => {},
  ) {}

  current(): NewsSnapshot | null {
    return this.snapshot;
  }

  private async get(category: "general" | "crypto"): Promise<unknown> {
    const res = await this.fetchImpl(
      `https://finnhub.io/api/v1/news?category=${category}&token=${this.apiKey}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  /** A failed refresh keeps the last good copy. */
  async refresh(): Promise<void> {
    const [general, crypto] = await Promise.allSettled([
      this.get("general"),
      this.get("crypto"),
    ]);
    const stocks =
      general.status === "fulfilled"
        ? parseNews(general.value, "stocks").slice(0, PER_SECTION)
        : this.snapshot?.stocks ?? [];
    const solana =
      crypto.status === "fulfilled"
        ? solanaFirst(parseNews(crypto.value, "crypto"))
        : this.snapshot?.solana ?? [];
    for (const r of [general, crypto]) {
      if (r.status === "rejected") {
        this.log("warn", "news refresh failed", {
          message: String((r.reason as Error)?.message ?? r.reason).slice(0, 200),
        });
      }
    }
    if (stocks.length || solana.length) {
      this.snapshot = { updatedAt: Math.floor(Date.now() / 1000), stocks, solana };
    }
  }
}
