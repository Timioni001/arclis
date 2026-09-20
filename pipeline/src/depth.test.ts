/**
 * Depth-ladder tests.
 *
 * The impact curve is the registry's most consequential number after the claim
 * score, and it is the one a holder acts on directly. These use a fake router
 * with a known pool so the expected impact can be reasoned about rather than
 * recorded from a live quote.
 */

import { describe, expect, it } from "vitest";
import { depthUnder, impactLadder, measureDepth, type Router } from "./depth";

const M = 1_000_000n;

describe("impactLadder", () => {
  it("reports zero impact when every size fills at the same rate", () => {
    const out = impactLadder([
      { size: 1_000n * M, out: 4n * M },
      { size: 5_000n * M, out: 20n * M },
      { size: 25_000n * M, out: 100n * M },
    ]);
    expect(out.map((p) => p.impactBps)).toEqual([0, 0, 0]);
  });

  it("measures degradation from the best rate, not from the first rung", () => {
    // The mid rung fills best, which a concentrated range can genuinely do.
    // Anchoring on rung zero would report a negative impact there.
    const out = impactLadder([
      { size: 1_000n * M, out: 3_900n * M },
      { size: 5_000n * M, out: 20_000n * M }, // best rate
      { size: 25_000n * M, out: 97_500n * M },
    ]);
    expect(out[0].impactBps).toBeGreaterThan(0);
    expect(out[1].impactBps).toBe(0);
    expect(out.every((p) => p.impactBps >= 0)).toBe(true);
  });

  it("computes a 2.5% degradation as 250 bps", () => {
    const out = impactLadder([
      { size: 1_000n * M, out: 1_000n * M }, // rate 1.0
      { size: 10_000n * M, out: 9_750n * M }, // rate 0.975
    ]);
    expect(out[1].impactBps).toBe(250);
  });

  it("reports a totally failed fill as the maximum rather than dividing by zero", () => {
    expect(impactLadder([{ size: 1_000n * M, out: 0n }])[0].impactBps).toBe(
      10_000,
    );
  });

  it("returns nothing for an empty ladder", () => {
    expect(impactLadder([])).toEqual([]);
  });
});

describe("depthUnder", () => {
  const ladder = [
    { size: 1_000n * M, out: 0n, impactBps: 5 },
    { size: 5_000n * M, out: 0n, impactBps: 40 },
    { size: 25_000n * M, out: 0n, impactBps: 95 },
    { size: 100_000n * M, out: 0n, impactBps: 480 },
  ];

  it("finds the largest size still inside the threshold", () => {
    expect(depthUnder(ladder, 100)).toBe(25_000n * M);
  });

  it("tightens as the threshold tightens", () => {
    expect(depthUnder(ladder, 50)).toBe(5_000n * M);
    expect(depthUnder(ladder, 10)).toBe(1_000n * M);
  });

  it("is zero when even the smallest size is too expensive", () => {
    expect(depthUnder(ladder, 1)).toBe(0n);
  });
});

/**
 * A constant-product pool, which is the shape most of these tokens trade in.
 * Impact is therefore a known function of size, so the ladder can be checked
 * against arithmetic rather than against a recording.
 */
function poolRouter(reserveToken: number, reserveQuote: number): Router {
  return {
    name: "fake-amm",
    async quote({ amount }) {
      const tokensIn = Number(amount) / 1e6;
      const k = reserveToken * reserveQuote;
      const quoteOut = reserveQuote - k / (reserveToken + tokensIn);
      return {
        outAmount: BigInt(Math.floor(quoteOut * 1e6)),
        routes: ["FakeAMM"],
      };
    },
  };
}

describe("measureDepth", () => {
  const base = {
    tokenMint: "TOKEN",
    quoteMint: "USDC",
    tokenDecimals: 6,
    approxPrice: 250,
  };

  it("finds near-zero impact in a deep pool", async () => {
    // $50m of quote against a $250 token: a $25k sell is a rounding error.
    const result = (await measureDepth({
      ...base,
      router: poolRouter(200_000, 50_000_000),
    }))!;
    expect(result).not.toBeNull();
    expect(result.referenceImpactBps).toBeLessThan(50);
    expect(result.depthAt1Pct).toBeGreaterThanOrEqual(25_000n * M);
  });

  it("finds heavy impact in a thin pool", async () => {
    // $200k of quote. A $25k sell is an eighth of the pool.
    const result = (await measureDepth({
      ...base,
      router: poolRouter(800, 200_000),
    }))!;
    expect(result.referenceImpactBps).toBeGreaterThan(500);
  });

  it("produces an impact curve that only worsens with size", async () => {
    const result = (await measureDepth({
      ...base,
      router: poolRouter(4_000, 1_000_000),
    }))!;
    const impacts = result.probes.map((p) => p.impactBps);
    for (let i = 1; i < impacts.length; i++) {
      expect(impacts[i]).toBeGreaterThanOrEqual(impacts[i - 1]);
    }
  });

  it("returns null when nothing routes at any size", async () => {
    const dead: Router = {
      name: "dead",
      async quote() {
        return null;
      },
    };
    expect(await measureDepth({ ...base, router: dead })).toBeNull();
  });

  it("stops the ladder at the first size that will not route", async () => {
    let calls = 0;
    const limited: Router = {
      name: "limited",
      async quote({ amount }) {
        calls++;
        // Nothing above roughly $5,000 worth routes.
        if (Number(amount) / 1e6 > 20) return null;
        return { outAmount: amount * 250n, routes: ["Small"] };
      },
    };
    const result = (await measureDepth({ ...base, router: limited }))!;
    expect(result.probes.length).toBe(2); // $1k and $5k
    // It must not keep asking after the first refusal.
    expect(calls).toBe(3);
  });

  it("names the venue the route actually used", async () => {
    const result = (await measureDepth({
      ...base,
      router: poolRouter(4_000, 1_000_000),
    }))!;
    expect(result.venue).toBe("FakeAMM");
    expect(result.routes).toContain("FakeAMM");
  });

  it("quotes the sell side, which is the direction a holder leaves in", async () => {
    const seen: Array<{ input: string; output: string }> = [];
    const spy: Router = {
      name: "spy",
      async quote({ inputMint, outputMint, amount }) {
        seen.push({ input: inputMint, output: outputMint });
        return { outAmount: amount * 250n, routes: [] };
      },
    };
    await measureDepth({ ...base, router: spy });
    // Token in, quote out. The reverse would measure how easy it is to buy,
    // which is a different and often much rosier number.
    expect(seen[0]).toEqual({ input: "TOKEN", output: "USDC" });
  });
});
