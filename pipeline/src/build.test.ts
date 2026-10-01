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
