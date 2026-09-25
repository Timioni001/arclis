/**
 * Headlines are third-party text on our front page: only well-formed items,
 * plain text, http(s) links, and Solana stories labelled as such only when
 * they are.
 */
import { describe, expect, it } from "vitest";
import { News, parseNews, solanaFirst } from "./news";

const item = (over: Record<string, unknown> = {}) => ({
  id: 1,
  headline: "Stocks rally",
  summary: "Markets rose.",
  source: "Reuters",
  url: "https://example.com/a",
  image: "https://example.com/a.jpg",
  datetime: 1_700_000_000,
  ...over,
});

describe("news", () => {
  it("keeps well-formed items, newest first, as plain text", () => {
    const out = parseNews(
      [
        item({ id: 1, datetime: 100, headline: "Older" }),
        item({ id: 2, datetime: 200, headline: "<b>Newer</b>", summary: "<p>Body</p>" }),
        item({ id: 3, url: "javascript:alert(1)" }),
        item({ id: 4, headline: "" }),
        item({ id: 5, datetime: "soon" }),
        item({ id: 6, image: "data:image/png;base64,xx", headline: "No image" }),
      ],
      "stocks",
    );
    expect(out.map((i) => i.headline)).toEqual(["No image", "Newer", "Older"]);
    expect(out[1].summary).toBe("Body");
    expect(out.find((i) => i.headline === "No image")?.image).toBeNull();
    expect(out.every((i) => !i.solana)).toBe(true);
  });

  it("drops repeated headlines", () => {
    const out = parseNews([item({ id: 1 }), item({ id: 2, url: "https://b.com" })], "stocks");
    expect(out).toHaveLength(1);
  });

  it("marks Solana stories and puts them first", () => {
    const out = solanaFirst(
      parseNews(
        [
          item({ id: 1, datetime: 300, headline: "Bitcoin climbs" }),
          item({ id: 2, datetime: 200, headline: "Solana DEX volume hits record" }),
          item({ id: 3, datetime: 100, headline: "Tokenized stocks", summary: "xStocks on Jupiter" }),
        ],
        "crypto",
      ),
    );
    expect(out.map((i) => [i.headline, i.solana])).toEqual([
      ["Solana DEX volume hits record", true],
      ["Tokenized stocks", true],
      ["Bitcoin climbs", false],
    ]);
  });

  it("keeps the last good copy when a refresh fails", async () => {
    let fail = false;
    const fetchImpl = (async (url: string) => {
      if (fail) return { ok: false, status: 429, statusText: "Too Many" };
      return {
        ok: true,
        json: async () =>
          url.includes("crypto")
            ? [item({ headline: "Solana news" })]
            : [item({ headline: "Stock news" })],
      };
    }) as unknown as typeof fetch;
    const news = new News("k", fetchImpl);
    await news.refresh();
    expect(news.current()?.stocks[0].headline).toBe("Stock news");
    expect(news.current()?.solana[0].solana).toBe(true);
    fail = true;
    await news.refresh();
    expect(news.current()?.stocks[0].headline).toBe("Stock news");
  });
});
