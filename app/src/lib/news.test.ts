import { describe, expect, it } from "vitest";
import { parseFeed } from "./news";

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
