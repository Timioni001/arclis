// @vitest-environment jsdom
/**
 * Every source link on the Registry goes somewhere.
 *
 * The reported failure was a disclosure link that led nowhere. The live
 * registry now checks each one, and these hold the page to what it does with
 * the answer: a working link is used as is, and a dead one sends the reader
 * to the issuer's own site instead of to a missing page.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// jsdom has no matchMedia or ResizeObserver, and the motion and glass
// components ask for both.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

import { Registry } from "./Registry";
import { ISSUERS, modelledRegistry } from "../lib/registry/data";
import type { Issuer } from "../lib/registry/types";

afterEach(cleanup);

const NOW = Math.floor(Date.UTC(2026, 9, 1, 12) / 1000);

function liveWith(issuers: Issuer[]) {
  return {
    ...modelledRegistry(),
    kind: "live" as const,
    issuers: () => issuers,
    failures: [],
  };
}

const xstocks = ISSUERS.find((i) => i.id === "backed")!;

describe("Registry source links", () => {
  it("links each issuer's documents when the last check found them", () => {
    const issuers = ISSUERS.map((i) =>
      i.id === "backed"
        ? {
            ...i,
            links: {
              disclosure: { ok: true, status: 200, checkedAt: NOW - 60 },
            },
          }
        : i,
    );
    render(
      <Registry
        registry={liveWith(issuers)}
        now={NOW}
        onOpenMarket={() => {}}
      />,
    );
    const links = screen
      .getAllByRole("link", { name: /Documents/ })
      .map((a) => a.getAttribute("href"));
    expect(links).toContain(xstocks.disclosureUrl);
  });

  it("sends readers to the issuer's site when the documents page is gone", () => {
    const issuers = ISSUERS.map((i) =>
      i.id === "backed"
        ? {
            ...i,
            links: {
              disclosure: { ok: false, status: 404, checkedAt: NOW - 60 },
            },
          }
        : i,
    );
    render(
      <Registry
        registry={liveWith(issuers)}
        now={NOW}
        onOpenMarket={() => {}}
      />,
    );
    const fallback = screen.getAllByRole("link", { name: /Issuer site/ });
    expect(fallback.length).toBeGreaterThan(0);
    for (const a of fallback)
      expect(a.getAttribute("href")).toBe(xstocks.website);
    // No link on the page points at the dead document.
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain(xstocks.disclosureUrl);
  });

  it("opens every issuer link in a new tab over https", () => {
    render(
      <Registry
        registry={liveWith(ISSUERS)}
        now={NOW}
        onOpenMarket={() => {}}
      />,
    );
    for (const a of screen.getAllByRole("link", { name: /Documents/ })) {
      expect(a.getAttribute("href")).toMatch(/^https:\/\//);
      expect(a.getAttribute("target")).toBe("_blank");
    }
  });
});
