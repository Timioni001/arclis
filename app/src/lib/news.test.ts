import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheNews, parseFeed, readCachedNews } from "./news";

describe("parseFeed", () => {
  it("keeps only well-formed headlines with http(s) links", () => {
    const feed = parseFeed({
      updatedAt: 10,
      stocks: [
        {
          id: 1,
          headline: "Stocks up",
          url: "https://a.com",
          datetime: 5,
          image: "javascript:x",
        },
        {
          id: 2,
          headline: "Bad link",
          url: "javascript:alert(1)",
          datetime: 5,
        },
        { id: 3, headline: 42, url: "https://b.com", datetime: 5 },
      ],
      solana: [
        {
          id: 4,
          headline: "Solana news",
          url: "https://c.com",
          datetime: 6,
          solana: true,
        },
      ],
    });
    expect(feed?.stocks.map((h) => h.headline)).toEqual(["Stocks up"]);
    expect(feed?.stocks[0].image).toBeNull();
    expect(feed?.solana[0].solana).toBe(true);
  });

  it("is null when there is nothing to show", () => {
    expect(parseFeed({ updatedAt: 0, stocks: [], solana: [] })).toBeNull();
    expect(parseFeed(null)).toBeNull();
  });
});

describe("the saved copy", () => {
  const now = 1_790_000_000;
  const feed = {
    updatedAt: now - 3_600,
    stocks: [{ id: "1", headline: "Stocks", summary: "", source: "Reuters", url: "https://example.com/1", image: null, datetime: now - 3_600, solana: false }],
    solana: [],
  };
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the last headlines for the next visit", () => {
    cacheNews(feed);
    expect(readCachedNews(now)?.stocks[0].headline).toBe("Stocks");
  });

  it("drops a copy more than a day and a half old", () => {
    cacheNews(feed);
    expect(readCachedNews(now + 36 * 3_600)).toBeNull();
  });

  it("reads as no copy when storage is refused or corrupt", () => {
    store.set("arclis-news-v1", "{not json");
    expect(readCachedNews(now)).toBeNull();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } });
    expect(readCachedNews(now)).toBeNull();
    expect(() => cacheNews(feed)).not.toThrow();
  });
});

