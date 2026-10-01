import { describe, expect, it, vi } from "vitest";
import { buildRegistry, type CuratedFile } from "./build";
import type { Router } from "./depth";

function mintAccount(supply: bigint) {
  const data = new Uint8Array(82);
  new DataView(data.buffer).setBigUint64(36, supply, true);
  data[44] = 6;
  data[45] = 1;
  return { data, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" };
}

const router: Router = {
  name: "jupiter",
  async quote({ amount }) {
    return { outAmount: (amount * 250n * 999n) / 1000n, routes: ["Raydium CLMM"] };
  },
};

const token = {
  underlying: "AAPL",
  name: "Apple",
  issuerId: "backed",
  backing: "Redeemable" as const,
  redemption: "VerifiedHolders" as const,
  custodian: "C",
  dividendTreatment: "D",
  corporateActionPolicy: "P",
  issuerRisk: "R",
  arclisSymbol: null,
};

const curated: CuratedFile = {
  checkedAt: "2026-10-01",
  issuers: [
    {
      id: "backed",
      name: "Backed",
      jurisdiction: "J",
      structure: "S",
      regulator: null,
      website: "https://site.example",
      disclosureUrl: "https://docs.example/gone",
      attestationUrl: null,
      attestation: "Unverified",
    },
  ],
  tokens: [
    { ...token, symbol: "AAPLx", mint: "M1", referenceSymbol: "AAPL" },
    { ...token, symbol: "AAPLon", mint: "M2" },
  ],
};

describe("buildRegistry", () => {
  it("asks the feed for each listed ticker once", async () => {
    const referencePrices = vi.fn(async () =>
      new Map([["AAPL", { price: 250_000_000n, at: 1, session: "Closed" }]]),
    );
    await buildRegistry({
      curated,
      getAccount: async () => mintAccount(1_000_000n),
      router,
      quoteMint: "USDC",
      referencePrices,
      checkLink: async () => ({ ok: true, status: 200, checkedAt: 1 }),
    });
    expect(referencePrices).toHaveBeenCalledWith(["AAPL"]);
  });

  it("carries each issuer's link check and the curated check date", async () => {
    const snapshot = await buildRegistry({
      curated,
      getAccount: async () => mintAccount(1_000_000n),
      router,
      quoteMint: "USDC",
      referencePrices: async () =>
        new Map([["AAPL", { price: 250_000_000n, at: 1, session: "Closed" }]]),
      checkLink: async () => ({ ok: false, status: 404, checkedAt: 7 }),
    });
    expect(snapshot.tokens.map((t) => t.symbol)).toEqual(["AAPLx", "AAPLon"]);
    expect(snapshot.issuers[0].checkedAt).toBe("2026-10-01");
    expect(snapshot.issuers[0].links.disclosure).toEqual({ ok: false, status: 404, checkedAt: 7 });
    expect(snapshot.issuers[0].links.attestation).toBeUndefined();
  });
});

describe("buildRegistry, end to end on realistic shapes", () => {
  /** A Token-2022 mint (8 decimals) carrying a Scaled UI amount config. */
  function token2022Mint(rawSupply: bigint, multiplier: number) {
    const data = new Uint8Array(166 + 4 + 56);
    const view = new DataView(data.buffer);
    view.setUint32(0, 1, true); // mint authority set
    data.fill(3, 4, 36);
    view.setBigUint64(36, rawSupply, true);
    data[44] = 8;
    data[45] = 1;
    view.setUint32(46, 1, true); // freeze authority set
    data.fill(5, 50, 82);
    data[165] = 1; // account type: mint
    view.setUint16(166, 25, true); // Scaled UI amount
    view.setUint16(168, 56, true);
    view.setFloat64(170 + 32, multiplier, true);
    view.setBigInt64(170 + 40, 0n, true);
    view.setFloat64(170 + 48, multiplier, true);
    return { data, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" };
  }

  it("reports per-share price and supply for a token with a display multiplier", async () => {
    // One raw token is 1.02 shares of a $250 stock, so it sells for $255.
    const m = 1.02;
    const share = 250;
    const jupiter: Router = {
      name: "jupiter",
      async quote({ amount }) {
        const rawTokens = Number(amount) / 1e8;
        const usdc = rawTokens * share * m * 0.9995;
        return {
          outAmount: BigInt(Math.round(usdc * 1e6)),
          routes: ["Meteora DLMM"],
        };
      },
    };
    const snapshot = await buildRegistry({
      curated: {
        checkedAt: "2026-10-01",
        issuers: curated.issuers,
        tokens: [{ ...token, symbol: "AAPLx", mint: "M1", referenceSymbol: "AAPL" }],
      },
      getAccount: async () => token2022Mint(1_000n * 100_000_000n, m),
      router: jupiter,
      quoteMint: "USDC",
      referencePrices: async () =>
        new Map([["AAPL", { price: 250_000_000n, at: 1, session: "Open" }]]),
      checkLink: async () => ({ ok: false, status: 404, checkedAt: 2 }),
    });

    expect(snapshot.failures).toEqual([]);
    const t = snapshot.tokens[0];
    // Per share, within the 5 bps of the fake pool's fee: not $255.
    expect(Number(t.onChainPrice) / 1e6).toBeCloseTo(249.9, 0);
    // 1,000 raw tokens are 1,020 shares, at the registry's 1e6 scale.
    expect(t.mint.supply).toBe("1020000000");
    expect(t.mint.extensions).toContain("Scaled UI amount");
    expect(t.mint.freezeAuthority).not.toBeNull();
    expect(snapshot.issuers[0].links.disclosure?.ok).toBe(false);
  });
});
