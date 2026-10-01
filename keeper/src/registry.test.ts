/**
 * The keeper's registry service: a failed build never replaces a good one,
 * builds never overlap, and the snapshot is served at /registry.
 */

import { describe, expect, it, vi } from "vitest";
import { RegistryService } from "./registry";
import { newHealth, startHealthServer } from "./health";
import type { RegistrySnapshot } from "../../pipeline/src/build";
import type { PriceFeed } from "./prices/types";

const feed: PriceFeed = {
  name: "test",
  quote: async (symbols) =>
    symbols.map((symbol) => ({
      symbol,
      price: 250_000_000n,
      confidence: 0n,
      printedAt: 1,
      halted: false,
    })),
};

const curated = { checkedAt: "2026-10-01", issuers: [], tokens: [] };

function snap(tokens: number): RegistrySnapshot {
  return {
    kind: "live",
    generatedAt: 100,
    tokens: Array.from({ length: tokens }, (_, i) => ({ symbol: `T${i}` }) as never),
    failures: [],
    issuers: [],
  };
}

describe("RegistryService", () => {
  it("serves nothing until the first build lands", () => {
    const service = new RegistryService({ feed, rpcUrl: "x", curated });
    expect(service.current()).toBeNull();
  });

  it("keeps the last good snapshot when a build reads no tokens", async () => {
    const builds = [snap(3), snap(0)];
    const service = new RegistryService({
      feed,
      rpcUrl: "x",
      curated,
      build: vi.fn(async () => builds.shift()!),
    });
    await service.refresh();
    await service.refresh();
    expect(service.current()?.tokens).toHaveLength(3);
    expect(service.status().lastError).toContain("no tokens");
  });

  it("keeps the last good snapshot when a build throws", async () => {
    let call = 0;
    const service = new RegistryService({
      feed,
      rpcUrl: "x",
      curated,
      build: vi.fn(async () => {
        if (call++ === 0) return snap(2);
        throw new Error("rpc 429");
      }),
    });
    await service.refresh();
    await service.refresh();
    expect(service.current()?.tokens).toHaveLength(2);
    expect(service.status().lastError).toBe("rpc 429");
  });

  it("never runs two builds at once", async () => {
    let release!: () => void;
    const build = vi.fn(
      () => new Promise<RegistrySnapshot>((resolve) => (release = () => resolve(snap(1)))),
    );
    const service = new RegistryService({ feed, rpcUrl: "x", curated, build });
    const first = service.refresh();
    await service.refresh();
    release();
    await first;
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("prices references from the oracle's own equity feed", async () => {
    let prices: Map<string, unknown> | null = null;
    const service = new RegistryService({
      feed,
      rpcUrl: "x",
      curated,
      build: vi.fn(async (options) => {
        prices = await options.referencePrices(["AAPL"]);
        return snap(1);
      }),
    });
    await service.refresh();
    expect(prices!.get("AAPL")).toMatchObject({ price: 250_000_000n });
  });

  it("names unreachable source links in its status", async () => {
    const withDeadLink = {
      ...snap(1),
      issuers: [
        {
          id: "a",
          name: "A",
          jurisdiction: "J",
          structure: "S",
          regulator: null,
          disclosureUrl: "https://gone.example",
          attestationUrl: null,
          attestation: "Unverified",
          links: { disclosure: { ok: false, status: 404, checkedAt: 1 } },
        },
      ],
    };
    const service = new RegistryService({
      feed,
      rpcUrl: "x",
      curated,
      build: vi.fn(async () => withDeadLink),
    });
    await service.refresh();
    expect(service.status().deadLinks).toEqual(["https://gone.example"]);
  });
});

describe("GET /registry", () => {
  const port = 18_000 + Math.floor(Math.random() * 2_000);

  it("answers 503 while building and the snapshot once built", async () => {
    let current: RegistrySnapshot | null = null;
    const abort = new AbortController();
    const health = newHealth({ rpc: "r", programId: "p", keeper: "k", symbols: [], feed: "f" });
    startHealthServer(
      health,
      port,
      abort.signal,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => current,
    );
    await new Promise((r) => setTimeout(r, 100));
    try {
      const building = await fetch(`http://127.0.0.1:${port}/registry`);
      expect(building.status).toBe(503);

      current = snap(2);
      const ready = await fetch(`http://127.0.0.1:${port}/registry`);
      expect(ready.status).toBe(200);
      expect(ready.headers.get("access-control-allow-origin")).toBe("*");
      expect(((await ready.json()) as RegistrySnapshot).tokens).toHaveLength(2);
    } finally {
      abort.abort();
    }
  });
});
