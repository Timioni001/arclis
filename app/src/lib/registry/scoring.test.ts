import { describe, expect, it } from "vitest";
import {
  assessBacking,
  assessControl,
  assessDeviation,
  assessLiquidity,
  circulatingValue,
  deviationBps,
  deviationToleranceBps,
  exitCoverageBps,
} from "./scoring";
import { issuerById, modelledRegistry, TOKENIZED_STOCKS } from "./data";
import type { PoolDepth, TokenizedStock } from "./types";

const usd = (d: number) => BigInt(Math.round(d * 1_000_000));
const NOW = Math.floor(Date.UTC(2026, 8, 18, 20, 5, 0) / 1000);

function stock(overrides: Partial<TokenizedStock> = {}): TokenizedStock {
  const base = TOKENIZED_STOCKS[0];
  return { ...base, ...overrides };
}

describe("deviationBps", () => {
  it("is zero when the two prices agree", () => {
    expect(deviationBps(usd(100), usd(100))).toBe(0);
  });

  it("is positive when the token trades above the stock", () => {
    // $101 vs $100 is exactly 100 bps.
    expect(deviationBps(usd(101), usd(100))).toBe(100);
  });

  it("is negative when the token trades below the stock", () => {
    expect(deviationBps(usd(99), usd(100))).toBe(-100);
  });

  it("does not divide by zero on a missing reference", () => {
    expect(deviationBps(usd(100), 0n)).toBe(0);
  });

  it("rounds toward zero so a deviation is never overstated", () => {
    // $100.009 vs $100 is 0.9 bps, which must report as 0 and not 1.
    expect(deviationBps(usd(100.009), usd(100))).toBe(0);
  });
});

describe("deviationToleranceBps", () => {
  it("is tightest while the reference venue is open", () => {
    expect(deviationToleranceBps("Open")).toBeLessThan(
      deviationToleranceBps("PreOpen"),
    );
    expect(deviationToleranceBps("PreOpen")).toBeLessThan(
      deviationToleranceBps("Closed"),
    );
  });

  it("refuses to tolerate anything during a halt, because nothing is measurable", () => {
    expect(deviationToleranceBps("Halted")).toBe(0);
  });
});

describe("assessDeviation", () => {
  it("calls a small weekend gap fair rather than a mispricing", () => {
    // 100 bps over a closed reference: inside the 300 bps weekend tolerance.
    const s = stock({
      onChainPrice: usd(101),
      referencePrice: usd(100),
      referenceSession: "Closed",
      referenceTs: NOW,
    });
    const d = assessDeviation(s, NOW);
    expect(d.verdict).toBe("Fair");
    expect(d.referenceStale).toBe(true);
  });

  it("calls the same gap a premium while the market is open", () => {
    const s = stock({
      onChainPrice: usd(101),
      referencePrice: usd(100),
      referenceSession: "Open",
      referenceTs: NOW,
    });
    const d = assessDeviation(s, NOW);
    expect(d.verdict).toBe("Premium");
    expect(d.bps).toBe(100);
  });

  it("flags a wide gap as dislocated whatever the session", () => {
    const s = stock({
      onChainPrice: usd(117),
      referencePrice: usd(100),
      referenceSession: "Closed",
      referenceTs: NOW,
    });
    expect(assessDeviation(s, NOW).verdict).toBe("Dislocated");
  });

  it("reports a discount as its own verdict, not as a negative premium", () => {
    const s = stock({
      onChainPrice: usd(98),
      referencePrice: usd(100),
      referenceSession: "Open",
      referenceTs: NOW,
    });
    const d = assessDeviation(s, NOW);
    expect(d.verdict).toBe("Discount");
    expect(d.bps).toBe(-200);
  });

  it("reports a halted reference as unmeasurable rather than scoring it", () => {
    const s = stock({ referenceSession: "Halted", referenceTs: NOW });
    expect(assessDeviation(s, NOW).verdict).toBe("Stale");
  });

  it("treats a stale price during an open session as a data problem", () => {
    const s = stock({
      onChainPrice: usd(101),
      referencePrice: usd(100),
      referenceSession: "Open",
      referenceTs: NOW - 3600,
    });
    const d = assessDeviation(s, NOW);
    expect(d.verdict).toBe("Stale");
    expect(d.note).toContain("60 minutes old");
  });
});

describe("assessBacking", () => {
  it("scores a redeemable, attested, custodied token above a synthetic one", () => {
    const apple = TOKENIZED_STOCKS.find((s) => s.symbol === "AAPLx")!;
    const synthetic = TOKENIZED_STOCKS.find((s) => s.symbol === "preOPENAI")!;

    const a = assessBacking(
      apple,
      issuerById(apple.issuerId)!.attestation,
      null,
    );
    const b = assessBacking(
      synthetic,
      issuerById(synthetic.issuerId)!.attestation,
      null,
    );

    expect(a.score).toBeGreaterThan(b.score);
  });

  it("gives a synthetic with no redemption and no attestation the floor score", () => {
    const synthetic = TOKENIZED_STOCKS.find((s) => s.symbol === "preOPENAI")!;
    const b = assessBacking(synthetic, "None", null);
    // Claim only: 1 * 10. Everything else is zero, and nothing is negative.
    expect(b.score).toBe(10);
  });

  it("never exceeds 100 or drops below 0", () => {
    for (const s of TOKENIZED_STOCKS) {
      const issuer = issuerById(s.issuerId)!;
      const a = assessBacking(s, issuer.attestation, issuer.regulator);
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(100);
    }
  });

  it("publishes a breakdown that sums to the score", () => {
    for (const s of TOKENIZED_STOCKS) {
      const issuer = issuerById(s.issuerId)!;
      const a = assessBacking(s, issuer.attestation, issuer.regulator);
      const sum = a.components.reduce((t, c) => t + c.points, 0);
      expect(sum).toBe(a.score);
      // Every component must be inside its own stated maximum, or the bar
      // rendered from it would overflow its track.
      for (const c of a.components) {
        expect(c.points).toBeLessThanOrEqual(c.max);
        expect(c.points).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("does not let a regulator buy score", () => {
    const s = TOKENIZED_STOCKS[0];
    const withRegulator = assessBacking(s, "Daily", "FMA Liechtenstein");
    const without = assessBacking(s, "Daily", null);
    expect(withRegulator.score).toBe(without.score);
  });
});

describe("assessLiquidity", () => {
  const pool = (venue: string, impact: number, quote: number): PoolDepth => ({
    venue,
    poolAddress: venue,
    quoteLiquidity: usd(quote),
    baseLiquidity: usd(quote / 250),
    sellImpactBps: impact,
    depthProbeQuote: usd(25_000),
    volume24h: usd(0),
  });

  it("says illiquid, not empty, when there is no pool at all", () => {
    const a = assessLiquidity([]);
    expect(a.verdict).toBe("Illiquid");
    expect(a.bestVenue).toBeNull();
  });

  it("ranks by price impact, not by TVL", () => {
    // The bigger pool is worse to exit through. TVL would pick the wrong one.
    const a = assessLiquidity([
      pool("Deep but lopsided", 300, 9_000_000),
      pool("Small but even", 20, 400_000),
    ]);
    expect(a.bestVenue).toBe("Small but even");
    expect(a.verdict).toBe("Deep");
  });

  it("still totals TVL across every venue", () => {
    const a = assessLiquidity([
      pool("A", 30, 1_000_000),
      pool("B", 60, 500_000),
    ]);
    expect(a.totalQuoteLiquidity).toBe(usd(1_500_000));
  });

  it("steps down through the verdicts as impact widens", () => {
    expect(assessLiquidity([pool("x", 10, 1)]).verdict).toBe("Deep");
    expect(assessLiquidity([pool("x", 60, 1)]).verdict).toBe("Adequate");
    expect(assessLiquidity([pool("x", 300, 1)]).verdict).toBe("Thin");
    expect(assessLiquidity([pool("x", 900, 1)]).verdict).toBe("Illiquid");
  });
});

describe("assessControl", () => {
  it("reports a freeze authority as a watch item and its absence as neutral", () => {
    const frozen = assessControl(stock());
    expect(frozen.find((f) => f.label.includes("frozen"))?.tone).toBe("watch");

    const free = assessControl(
      stock({ mint: { ...TOKENIZED_STOCKS[0].mint, freezeAuthority: null } }),
    );
    expect(free.find((f) => f.label.includes("cannot be frozen"))?.tone).toBe(
      "neutral",
    );
  });

  it("surfaces every Token-2022 extension as its own finding", () => {
    const ondo = TOKENIZED_STOCKS.find((s) => s.symbol === "oUSTB-MSFT")!;
    const findings = assessControl(ondo);
    expect(findings.some((f) => f.label.includes("Transfer hook"))).toBe(true);
  });
});

describe("supply cover", () => {
  it("values the circulating supply at the reference price", () => {
    const s = stock({ referencePrice: usd(100) });
    // supply is 412_000 tokens at 1e6.
    expect(circulatingValue(s)).toBe(usd(41_200_000));
  });

  it("reports exit coverage as pooled liquidity over circulating value", () => {
    const s = stock({
      referencePrice: usd(100),
      mint: { ...TOKENIZED_STOCKS[0].mint, supply: usd(10_000) },
      pools: [
        {
          venue: "v",
          poolAddress: "v",
          quoteLiquidity: usd(100_000),
          baseLiquidity: 0n,
          sellImpactBps: 10,
          depthProbeQuote: usd(25_000),
          volume24h: 0n,
        },
      ],
    });
    // $1,000,000 circulating, $100,000 pooled == 1000 bps == 10%.
    expect(exitCoverageBps(s)).toBe(1_000);
  });

  it("flags the synthetic as the thinnest cover in the set", () => {
    const coverage = TOKENIZED_STOCKS.map((s) => ({
      symbol: s.symbol,
      bps: exitCoverageBps(s),
    }));
    const worst = coverage.reduce((a, b) => (a.bps <= b.bps ? a : b));
    expect(worst.symbol).toBe("preOPENAI");
  });

  it("is zero rather than infinite when nothing is circulating", () => {
    const s = stock({ mint: { ...TOKENIZED_STOCKS[0].mint, supply: 0n } });
    expect(exitCoverageBps(s)).toBe(0);
  });
});

describe("the modelled source", () => {
  it("labels itself as modelled so the interface cannot present it as live", () => {
    expect(modelledRegistry().kind).toBe("modelled");
  });

  it("resolves a ticker case-insensitively", () => {
    expect(modelledRegistry().stock("aaplx")?.symbol).toBe("AAPLx");
  });

  it("points every row at an issuer that exists", () => {
    for (const s of TOKENIZED_STOCKS) {
      expect(issuerById(s.issuerId), s.symbol).toBeDefined();
    }
  });

  it("gives every issuer a disclosure link, because an unlinked claim is not checkable", () => {
    for (const i of modelledRegistry().issuers()) {
      expect(i.disclosureUrl, i.name).toMatch(/^https:\/\//);
    }
  });
});
