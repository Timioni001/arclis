/**
 * Daily headlines from the keeper's `/news`, for the Overview.
 *
 * The keeper fetches them server-side because the provider needs a key. This
 * re-validates what arrives anyway: it is third-party text rendered on our
 * front page, so only plain strings and http(s) links get through.
 */
import { useEffect, useState } from "react";
import { KEEPER_URL } from "./config";

export interface Headline {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  image: string | null;
  /** Unix seconds. */
  datetime: number;
  solana: boolean;
}

export interface NewsFeed {
  updatedAt: number;
  stocks: Headline[];
  solana: Headline[];
}

const httpUrl = (v: unknown): string | null => {
  try {
    const u = new URL(String(v ?? ""));
    return u.protocol === "https:" || u.protocol === "http:"
      ? u.toString()
      : null;
  } catch {
    return null;
  }
};

function clean(list: unknown): Headline[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const url = httpUrl(r?.url);
    const headline = typeof r?.headline === "string" ? r.headline : "";
    const datetime = Number(r?.datetime);
    if (!url || !headline || !Number.isFinite(datetime)) return [];
    return [
      {
        id: String(r.id ?? url),
        headline,
        summary: typeof r.summary === "string" ? r.summary : "",
        source: typeof r.source === "string" ? r.source : "",
        url,
        image: httpUrl(r.image),
        datetime,
        solana: r.solana === true,
      },
    ];
  });
}

export function parseFeed(body: unknown): NewsFeed | null {
  const b = body as Record<string, unknown>;
  const feed = {
    updatedAt: Number(b?.updatedAt) || 0,
    stocks: clean(b?.stocks),
    solana: clean(b?.solana),
  };
  return feed.stocks.length || feed.solana.length ? feed : null;
}

const CACHE_KEY = "arclis-news-v1";
/** Older than this, a saved copy is yesterday's news and not shown. */
const CACHE_MAX_AGE_SECS = 36 * 3_600;

/**
 * The last headlines this browser saw, if recent enough.
 *
 * Only a convenience: the keeper serves the headlines, and when it was down
 * the section vanished from the Overview with no word as to why. A saved copy
 * keeps it on the page through an outage. Storage can be missing or refuse
 * (private windows, blocked site data), which reads as no copy.
 */
export function readCachedNews(now = Date.now() / 1000): NewsFeed | null {
  try {
    const parsed = parseFeed(JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"));
    return parsed && now - parsed.updatedAt <= CACHE_MAX_AGE_SECS ? parsed : null;
  } catch {
    return null;
  }
}

export function cacheNews(feed: NewsFeed): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(feed));
  } catch {
    /* no storage: the next visit simply waits for the keeper */
  }
}

/**
 * Headlines: the saved copy at once, then the keeper's, re-read every ten
 * minutes; every minute while the keeper has not answered yet.
 */
export function useNews(): NewsFeed | null {
  const [feed, setFeed] = useState<NewsFeed | null>(() =>
    KEEPER_URL ? readCachedNews() : null,
  );
  useEffect(() => {
    // Headlines are not chain data, so a demo build shows them too.
    if (!KEEPER_URL) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      fetch(`${KEEPER_URL}/news`)
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => parseFeed(body))
        .catch(() => null)
        .then((parsed) => {
          if (cancelled) return;
          if (parsed) {
            setFeed(parsed);
            cacheNews(parsed);
          }
          timer = setTimeout(load, parsed ? 10 * 60_000 : 60_000);
        });
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  return feed;
}
