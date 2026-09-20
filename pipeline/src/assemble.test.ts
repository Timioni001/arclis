/**
 * Assembler tests.
 *
 * The rule these exist to protect is the one the whole product rests on: a
 * token that cannot be fully read is left out and recorded, never filled in
 * from the modelled dataset. A real claim score beside an invented supply is
 * exactly what the registry exists to stop other people doing.
 */

import { describe, expect, it } from "vitest";
import { assemble, type CuratedEntry } from "./assemble";
import type { Router } from "./depth";

function mintAccount(supply: bigint, decimals = 6, freeze = true) {
  const data = new Uint8Array(82);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  data.set(
    Uint8Array.from({ length: 32 }, () => 7),
    4,
  );
  view.setBigUint64(36, supply, true);
  data[44] = decimals;
  data[45] = 1;
  if (freeze) {
    view.setUint32(46, 1, true);
    data.set(
      Uint8Array.from({ length: 32 }, () => 9),
      50,
    );
  }
  return { data, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" };
}

const entry = (over: Partial<CuratedEntry> = {}): CuratedEntry => ({
  symbol: "AAPLx",
  underlying: "AAPL",
  name: "Apple Inc.",
  issuerId: "backed",
  mint: "MINT_AAPL",
  backing: "Redeemable",
  redemption: "VerifiedHolders",
  custodian: "InCore Bank AG",
  dividendTreatment: "Accrues into the certificate value.",
  corporateActionPolicy: "Passed through.",
  issuerRisk: "Creditor claim against the collateral pool.",
  arclisSymbol: "AAPL",
  ...over,
});

const goodRouter: Router = {
  name: "jupiter",
  async quote({ amount }) {
    // A deep, near-linear pool: 250 quote per token, tiny impact.
    return {
      outAmount: (amount * 250n * 999n) / 1000n,
      routes: ["Raydium CLMM"],
    };
  },
};

const prices = new Map([
  ["AAPL", { price: 254_200_000n, at: 1_700_000_000, session: "Closed" }],
]);

const base = {
  getAccount: async () => mintAccount(412_000_000_000n),
  router: goodRouter,
  quoteMint: "USDC",
  referencePrices: prices,
};

describe("assemble", () => {
  it("builds a token from chain facts and curated disclosure", async () => {
    const snapshot = await assemble({ ...base, entries: [entry()] });
    expect(snapshot.kind).toBe("live");
    expect(snapshot.tokens).toHaveLength(1);

    const token = snapshot.tokens[0];
    expect(token.mint.supply).toBe("412000000000");
    expect(token.mint.freezeAuthority).not.toBeNull();
    expect(token.backing).toBe("Redeemable");
    expect(token.custodian).toBe("InCore Bank AG");
  });

  it("attributes every field to where it came from", async () => {
    // A claim with no source is not checkable, which is the failure mode the
    // whole product is a response to.
    const snapshot = await assemble({ ...base, entries: [entry()] });
    const sources = snapshot.tokens[0].sources;
    expect(sources.supply).toBe("getAccountInfo");
    expect(sources.extensions).toBe("getAccountInfo");
    expect(sources.depth).toBe("jupiter");
    expect(sources.structure).toBe("issuer disclosure");
  });

  it("drops a token whose mint cannot be found, and says which", async () => {
    const snapshot = await assemble({
      ...base,
      entries: [entry()],
      getAccount: async () => null,
    });
    expect(snapshot.tokens).toHaveLength(0);
    expect(snapshot.failures).toEqual([
      { symbol: "AAPLx", reason: "mint account not found" },
    ]);
  });

  it("drops a token whose mint account is malformed", async () => {
    const snapshot = await assemble({
      ...base,
      entries: [entry()],
      getAccount: async () => ({ data: new Uint8Array(10), owner: "x" }),
    });
    expect(snapshot.tokens).toHaveLength(0);
    expect(snapshot.failures[0].reason).toMatch(/unreadable/);
  });

  it("drops a token with no reference price rather than pricing it at zero", async () => {
    const snapshot = await assemble({
      ...base,
      entries: [entry({ underlying: "UNKNOWN" })],
    });
    expect(snapshot.tokens).toHaveLength(0);
    expect(snapshot.failures[0].reason).toMatch(/no reference price/);
  });

  it("marks the snapshot partial when anything failed", async () => {
    const snapshot = await assemble({
      ...base,
      entries: [entry(), entry({ symbol: "BAD", underlying: "UNKNOWN" })],
    });
    expect(snapshot.kind).toBe("partial");
    expect(snapshot.tokens).toHaveLength(1);
    expect(snapshot.failures).toHaveLength(1);
  });

  it("keeps a token with no route, because unexitable is the finding", async () => {
    const dead: Router = {
      name: "jupiter",
      async quote() {
        return null;
      },
    };
    const snapshot = await assemble({
      ...base,
      entries: [entry()],
      router: dead,
    });
    expect(snapshot.tokens).toHaveLength(1);
    // No pools is what the scoring reads as Illiquid, which is exactly right.
    expect(snapshot.tokens[0].pools).toHaveLength(0);
  });

  it("does not let one bad token stop the others", async () => {
    let call = 0;
    const snapshot = await assemble({
      ...base,
      entries: [
        entry({ symbol: "A" }),
        entry({ symbol: "B" }),
        entry({ symbol: "C" }),
      ],
      getAccount: async () => {
        call++;
        if (call === 2) throw new Error("rpc exploded");
        return mintAccount(1_000_000n);
      },
    });
    expect(snapshot.tokens.map((t) => t.symbol)).toEqual(["A", "C"]);
    expect(snapshot.failures[0].symbol).toBe("B");
  });

  it("scales a 9-decimal supply into the registry's 1e6 convention", async () => {
    const snapshot = await assemble({
      ...base,
      entries: [entry()],
      getAccount: async () => mintAccount(412_000_000_000_000n, 9),
    });
    expect(snapshot.tokens[0].mint.supply).toBe("412000000000");
  });

  it("reports a revoked mint authority as null", async () => {
    const account = mintAccount(1_000_000n);
    new DataView(account.data.buffer).setUint32(0, 0, true); // COption: none
    const snapshot = await assemble({
      ...base,
      entries: [entry()],
      getAccount: async () => account,
    });
    expect(snapshot.tokens[0].mint.mintAuthority).toBeNull();
  });

  it("stamps the snapshot so staleness is visible", async () => {
    const before = Math.floor(Date.now() / 1000);
    const snapshot = await assemble({ ...base, entries: [entry()] });
    expect(snapshot.generatedAt).toBeGreaterThanOrEqual(before);
  });
});
