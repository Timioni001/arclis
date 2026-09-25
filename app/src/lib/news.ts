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

/** Headlines, re-read every ten minutes; null until there are any. */
export function useNews(): NewsFeed | null {
  const [feed, setFeed] = useState<NewsFeed | null>(null);
  useEffect(() => {
    // Headlines are not chain data, so a demo build shows them too.
    if (!KEEPER_URL) return;
    let cancelled = false;
    const load = () =>
      fetch(`${KEEPER_URL}/news`)
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          const parsed = parseFeed(body);
          if (!cancelled && parsed) setFeed(parsed);
        })
        .catch(() => {});
    void load();
    const id = setInterval(load, 10 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return feed;
}
