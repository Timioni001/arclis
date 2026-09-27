// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NewsSection } from "./NewsSection";
import type { Headline, NewsFeed } from "../../lib/news";

afterEach(cleanup);

const now = Math.floor(Date.now() / 1000);
const item = (id: string, headline: string, solana = false): Headline => ({
  id,
  headline,
  summary: `${headline} summary`,
  source: solana ? "CoinDesk" : "Reuters",
  url: `https://example.com/${id}`,
  image: null,
  datetime: now - 3600,
  solana,
});

const feed: NewsFeed = {
  updatedAt: now,
  stocks: [item("s1", "Stocks lead"), item("s2", "Stocks second")],
  solana: [item("c1", "Solana lead", true)],
};

describe("NewsSection", () => {
  it("renders nothing until the keeper has headlines", () => {
    const { container } = render(<NewsSection feed={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("leads with stocks and switches to Solana", () => {
    render(<NewsSection feed={feed} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Stocks lead");
    fireEvent.click(screen.getByRole("tab", { name: "Solana" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Solana lead");
    expect(screen.getByRole("tab", { name: "Solana" }).getAttribute("aria-selected")).toBe("true");
  });

  it("falls back to stocks when a section is empty", () => {
    render(<NewsSection feed={{ ...feed, solana: [] }} />);
    fireEvent.click(screen.getByRole("tab", { name: "Solana" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Stocks lead");
  });

  it("hides the ticker's looping copy from assistive tech and the keyboard", () => {
    const { container } = render(<NewsSection feed={feed} />);
    const runs = container.querySelectorAll(".news-ticker-run");
    expect(runs).toHaveLength(2);
    expect(runs[1].getAttribute("aria-hidden")).toBe("true");
    for (const a of runs[1].querySelectorAll("a")) expect(a.getAttribute("tabindex")).toBe("-1");
  });

  it("opens every story in a new tab without leaking the page", () => {
    const { container } = render(<NewsSection feed={feed} />);
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
  });

  it("says how old a story is", () => {
    render(<NewsSection feed={feed} />);
    expect(screen.getAllByText("1h ago").length).toBeGreaterThan(0);
  });
});
