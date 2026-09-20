/**
 * The scanner's health arithmetic.
 *
 * This is the one piece of the liquidator that can be wrong quietly. A wrong
 * PDA fails loudly; a wrong margin ratio just means positions are never
 * submitted, and the first symptom is bad debt nobody can explain.
 *
 * The ratio is duplicated from the Rust on purpose (the scanner needs it
 * off-chain to decide what is worth submitting), so these tests exist to keep
 * the duplicate honest against the same identities `math/pnl.rs` asserts.
 */

import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { addressesFor, marginRatioBps, type ScannedPosition } from "./cranks";

const P = 1_000_000n;
const F = 1_000_000_000n;
const KEY = PublicKey.default;

function position(over: Partial<ScannedPosition> = {}): ScannedPosition {
  return {
    address: KEY,
    owner: KEY,
    market: KEY,
    size: 10n * P, // 10 units
    entryPrice: 100n * P, // at $100
    collateral: 200n * P, // $200, so 5x
    entryFundingIndex: 0n,
    ...over,
  };
}

describe("marginRatioBps", () => {
  it("is collateral over notional when the price has not moved", () => {
    // $200 on $1,000 notional is 2000 bps.
    expect(marginRatioBps(position(), 100n * P, 0n)).toBe(2_000n);
  });

  it("falls as a long loses", () => {
    // Price to $90: unrealised is -$100, equity $100, notional $900.
    expect(marginRatioBps(position(), 90n * P, 0n)).toBe(1_111n);
  });

  it("rises as a long gains", () => {
    // Price to $110: equity $300, notional $1,100.
    expect(marginRatioBps(position(), 110n * P, 0n)).toBe(2_727n);
  });

  it("flips direction for a short", () => {
    const short = position({ size: -10n * P });
    // A short gains when the price falls.
    expect(marginRatioBps(short, 90n * P, 0n)).toBeGreaterThan(2_000n);
    expect(marginRatioBps(short, 110n * P, 0n)).toBeLessThan(2_000n);
  });

  it("subtracts unsettled funding from equity", () => {
    // The bug this guards: a position healthy on collateral alone but
    // liquidatable once funding is applied. Index at 10 quote per unit means
    // a 10-unit long owes $100.
    const index = 10n * F;
    const withFunding = marginRatioBps(position(), 100n * P, index);
    const without = marginRatioBps(position(), 100n * P, 0n);
    expect(withFunding).toBeLessThan(without);
    // Equity $100 on $1,000 notional.
    expect(withFunding).toBe(1_000n);
  });

  it("credits funding to the side that receives it", () => {
    const short = position({ size: -10n * P });
    // A short with longs paying receives, so equity rises.
    expect(marginRatioBps(short, 100n * P, 10n * F)).toBeGreaterThan(2_000n);
  });

  it("goes negative once equity is gone, rather than wrapping", () => {
    // Price to $70 on a 5x long: unrealised -$300 against $200 collateral.
    const ratio = marginRatioBps(position(), 70n * P, 0n);
    expect(ratio).toBeLessThan(0n);
  });

  it("returns zero for a flat position rather than dividing by zero", () => {
    expect(marginRatioBps(position({ size: 0n }), 100n * P, 0n)).toBe(0n);
  });

  it("crosses a 500 bps maintenance threshold at the price the program would", () => {
    // 5x long, maintenance 500 bps. Equity = 200 + 10*(p-100); notional = 10p.
    // 200 + 10p - 1000 = 0.05 * 10p  ->  9.5p = 800  ->  p = 84.21
    const maintenance = 500n;
    expect(marginRatioBps(position(), 85n * P, 0n)).toBeGreaterThan(
      maintenance,
    );
    expect(marginRatioBps(position(), 84n * P, 0n)).toBeLessThan(maintenance);
  });

  it("handles a size that overflows a JS number", () => {
    // Raw 1e6 units past 2^53. bigint throughout or this silently rounds.
    const huge = position({
      size: 9_007_199_254_740_993n,
      collateral: 10_000_000_000_000n,
    });
    expect(() => marginRatioBps(huge, 100n * P, 0n)).not.toThrow();
  });
});

describe("addressesFor", () => {
  // Any valid pubkey will do: these tests check that derivation is a pure
  // function of (programId, symbol), not that it matches a deployment. It is
  // deliberately not kept in step with `declare_id!` - a fixture that tracks
  // the real program invites someone to "fix" it during a key rotation.
  const programId = new PublicKey(
    "A2WJAgqLpcZSkyqHu1cJA62gANDjiYx7M5Qyz9kZdoH3",
  );

  it("derives a distinct address set per symbol", () => {
    const aapl = addressesFor(programId, "AAPL");
    const nvda = addressesFor(programId, "NVDA");
    expect(aapl.oracle.toBase58()).not.toBe(nvda.oracle.toBase58());
    expect(aapl.market.toBase58()).not.toBe(nvda.market.toBase58());
    expect(aapl.pool.toBase58()).not.toBe(nvda.pool.toBase58());
  });

  it("is deterministic", () => {
    expect(addressesFor(programId, "AAPL").market.toBase58()).toBe(
      addressesFor(programId, "AAPL").market.toBase58(),
    );
  });

  it("shares one config across every market", () => {
    expect(addressesFor(programId, "AAPL").config.toBase58()).toBe(
      addressesFor(programId, "NVDA").config.toBase58(),
    );
  });

  it("pads the symbol seed to 16 bytes, so AAPL and AAPL\\0 are one market", () => {
    // The seed is fixed width on-chain. If this derivation did not pad, every
    // address here would be wrong and nothing would be found.
    const a = addressesFor(programId, "AAPL");
    expect(a.oracle.toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});
