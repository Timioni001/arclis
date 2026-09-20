/**
 * The live-snapshot loader.
 *
 * Every test here is about one rule: a failure must land on the modelled
 * dataset, which the interface labels, and never on an empty page or on stale
 * numbers presented as current.
 */

import { describe, expect, it, vi } from "vitest";
import { loadRegistry, MODELLED_TOKEN_COUNT } from "./live";

const NOW = 1_800_000_000;

function snapshot(over: Record<string, unknown> = {}) {
  return {
    kind: "live",
    generatedAt: NOW - 60,
    tokens: [
      {
        symbol: "AAPLx",
        underlying: "AAPL",
        name: "Apple Inc.",
        issuerId: "backed",
        backing: "Redeemable",
        redemption: "VerifiedHolders",
        custodian: "InCore Bank AG",
        dividendTreatment: "Accrues.",
        corporateActionPolicy: "Passed through.",
        issuerRisk: "Creditor claim.",
        arclisSymbol: "AAPL",
        mint: {
          mint: "MINT",
          decimals: 6,
          supply: "412000000000",
          mintAuthority: "AUTH",
          freezeAuthority: "FREEZE",
          extensions: [],
        },
        pools: [
          {
            venue: "Raydium CLMM",
            poolAddress: "POOL",
            quoteLiquidity: "25000000000",
            baseLiquidity: "0",
            sellImpactBps: 18,
            depthProbeQuote: "25000000000",
            volume24h: "0",
          },
        ],
        onChainPrice: "254900000",
        referencePrice: "254200000",
        referenceTs: NOW - 120,
        referenceSession: "Closed",
      },
    ],
    failures: [],
    ...over,
  };
}

const respond = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);

describe("loadRegistry", () => {
  it("uses a fresh snapshot and reports itself live", async () => {
    const registry = await loadRegistry(respond(snapshot()), NOW);
    expect(registry.kind).toBe("live");
    expect(registry.stocks()).toHaveLength(1);
    expect(registry.asOf()).toBe(NOW - 60);
  });

  it("hydrates string amounts into bigints", async () => {
    // The JSON carries these as strings because a supply overflows a JS
    // number. Leaving them as strings would break every calculation silently.
    const registry = await loadRegistry(respond(snapshot()), NOW);
    const token = registry.stocks()[0];
    expect(token.mint.supply).toBe(412_000_000_000n);
    expect(token.onChainPrice).toBe(254_900_000n);
    expect(token.pools[0].quoteLiquidity).toBe(25_000_000_000n);
  });

  it("falls back to the modelled dataset when the file is missing", async () => {
    const registry = await loadRegistry(respond(null, false), NOW);
    expect(registry.kind).toBe("modelled");
    expect(registry.stocks()).toHaveLength(MODELLED_TOKEN_COUNT);
  });

  it("falls back when the snapshot is too old to trust", async () => {
    // Seven hours: past the six-hour ceiling. Presenting this as live is the
    // failure the ceiling exists to prevent.
    const stale = snapshot({ generatedAt: NOW - 7 * 3600 });
    const registry = await loadRegistry(respond(stale), NOW);
    expect(registry.kind).toBe("modelled");
  });

  it("accepts a snapshot just inside the age ceiling", async () => {
    const edge = snapshot({ generatedAt: NOW - 6 * 3600 + 60 });
    expect((await loadRegistry(respond(edge), NOW)).kind).toBe("live");
  });

  it("falls back on an empty token list rather than rendering nothing", async () => {
    const registry = await loadRegistry(respond(snapshot({ tokens: [] })), NOW);
    expect(registry.kind).toBe("modelled");
  });

  it("falls back when a row is malformed", async () => {
    const broken = snapshot();
    (broken.tokens[0] as Record<string, any>).mint.supply = "not a number";
    const registry = await loadRegistry(respond(broken), NOW);
    expect(registry.kind).toBe("modelled");
  });

  it("falls back when the fetch throws entirely", async () => {
    const boom = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect((await loadRegistry(boom, NOW)).kind).toBe("modelled");
  });

  it("treats an unknown session as Halted, which permits nothing", async () => {
    const odd = snapshot();
    (odd.tokens[0] as Record<string, any>).referenceSession = "Brunch";
    const registry = await loadRegistry(respond(odd), NOW);
    expect(registry.stocks()[0].referenceSession).toBe("Halted");
  });

  it("surfaces the pipeline's failures rather than hiding them", async () => {
    const partial = snapshot({
      kind: "partial",
      failures: [{ symbol: "oUSTB-MSFT", reason: "mint account not found" }],
    });
    const registry = await loadRegistry(respond(partial), NOW);
    expect(registry.failures).toHaveLength(1);
    expect(registry.failures[0].symbol).toBe("oUSTB-MSFT");
  });

  it("resolves a ticker case-insensitively, as the modelled source does", async () => {
    const registry = await loadRegistry(respond(snapshot()), NOW);
    expect(registry.stock("aaplx")?.symbol).toBe("AAPLx");
  });
});
