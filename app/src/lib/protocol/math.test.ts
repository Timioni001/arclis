/**
 * Cross-checks the TypeScript read-model maths against the Rust.
 *
 * Every expected value here is taken from a named test in
 * `programs/arclis/src/math/`. If the program's arithmetic changes and this is
 * not updated, the UI starts quoting margin ratios the chain disagrees with -
 * which shows up as a position that looked healthy right until it was
 * liquidated.
 */
import { describe, it, expect } from "vitest";
import * as m from "./math";
import { sessionAllows } from "./session";

const UNIT = m.BASE_SCALE;
const Q = m.QUOTE_SCALE;
const P100 = 100n * m.PRICE_SCALE;
const P110 = 110n * m.PRICE_SCALE;
const P90 = 90n * m.PRICE_SCALE;

describe("position valuation, matching math/pnl.rs", () => {
  it("notional ignores direction", () => {
    expect(m.notional(UNIT, P100)).toBe(100n * Q);
    expect(m.notional(-UNIT, P100)).toBe(100n * Q);
  });

  it("a long profits when price rises", () => {
    expect(m.unrealizedPnl(UNIT, P100, P110)).toBe(10n * Q);
    expect(m.unrealizedPnl(UNIT, P100, P90)).toBe(-10n * Q);
  });

  it("a short profits when price falls", () => {
    expect(m.unrealizedPnl(-UNIT, P100, P90)).toBe(10n * Q);
    expect(m.unrealizedPnl(-UNIT, P100, P110)).toBe(-10n * Q);
  });

  it("funding is denominated in quote, not base", () => {
    const delta = (Q * m.FUNDING_INDEX_SCALE) / Q;
    expect(m.fundingOwed(UNIT, 0n, delta)).toBe(Q);
    expect(m.fundingOwed(-UNIT, 0n, delta)).toBe(-Q);
  });

  it("equity combines collateral, PnL and funding", () => {
    expect(m.equity(50n * Q, UNIT, P100, P110, 0n, 0n)).toBe(60n * Q);
  });

  it("equity goes negative on bad debt and is not clamped", () => {
    expect(m.equity(5n * Q, UNIT, P100, P90, 0n, 0n)).toBe(-5n * Q);
  });

  it("margin ratio matches the hand calculation", () => {
    expect(m.marginRatioBps(10n * Q, 100n * Q)).toBe(1_000n);
  });

  it("a flat position has no margin ratio rather than a divide-by-zero", () => {
    expect(m.marginRatioBps(0n, 0n)).toBeNull();
  });

  it("fee rounds up so dust trades still pay", () => {
    expect(m.feeOnNotional(100n * Q, 1)).toBe(10_000n);
    expect(m.feeOnNotional(1n, 1)).toBe(1n);
    expect(m.feeOnNotional(100n * Q, 0)).toBe(0n);
  });
});

describe("liquidation price", () => {
  it("sits below entry for a long and is consistent with marginRatioBps", () => {
    // 1 unit long from $100, $20 collateral, 5% maintenance.
    const collateral = 20n * Q;
    const liq = m.liquidationPrice(collateral, UNIT, P100, 0n, 0n, 500);
    expect(liq).not.toBeNull();
    expect(liq!).toBeLessThan(P100);

    // At the returned price, margin must be at (or within rounding of) the
    // maintenance threshold, which is what makes it the liquidation price.
    const eq = m.equity(collateral, UNIT, P100, liq!, 0n, 0n);
    const ratio = m.marginRatioBps(eq, m.notional(UNIT, liq!))!;
    expect(Number(ratio)).toBeGreaterThanOrEqual(499);
    expect(Number(ratio)).toBeLessThanOrEqual(501);
  });

  it("sits above entry for a short", () => {
    const liq = m.liquidationPrice(20n * Q, -UNIT, P100, 0n, 0n, 500);
    expect(liq).not.toBeNull();
    expect(liq!).toBeGreaterThan(P100);
  });

  it("is null for a flat position", () => {
    expect(m.liquidationPrice(20n * Q, 0n, 0n, 0n, 0n, 500)).toBeNull();
  });

  it("moves closer once unsettled funding is owed", () => {
    const flat = m.liquidationPrice(20n * Q, UNIT, P100, 0n, 0n, 500)!;
    const owing = m.liquidationPrice(
      20n * Q,
      UNIT,
      P100,
      0n,
      500_000_000n,
      500,
    )!;
    expect(owing).toBeGreaterThan(flat);
  });
});

describe("funding, matching math/funding.rs", () => {
  it("skew is bounded and signed by the heavier side", () => {
    expect(m.skewBps(1_000n, 1_000n)).toBe(0n);
    expect(m.skewBps(1_000n, 0n)).toBe(10_000n);
    expect(m.skewBps(0n, 1_000n)).toBe(-10_000n);
    expect(m.skewBps(0n, 0n)).toBe(0n);
  });

  it("zero utilisation reproduces the skew-only rate", () => {
    expect(m.fundingRateBps(5_000n, 10, 0n)).toBe(5n);
  });

  it("full utilisation doubles the rate", () => {
    expect(m.fundingRateBps(5_000n, 10, 10_000n)).toBe(10n);
  });

  it("is clamped in both directions regardless of config", () => {
    expect(m.fundingRateBps(10_000n, 10_000, 10_000n)).toBe(
      m.MAX_FUNDING_RATE_BPS_PER_INTERVAL,
    );
    expect(m.fundingRateBps(-10_000n, 10_000, 10_000n)).toBe(
      -m.MAX_FUNDING_RATE_BPS_PER_INTERVAL,
    );
  });
});

describe("liquidity pool, matching math/liquidity.rs", () => {
  const oi = 10n * UNIT;
  const entryNotional = 10n * UNIT * P100;

  it("a balanced book costs the pool nothing", () => {
    for (const p of [P90, P100, P110]) {
      expect(m.netTraderPnl(oi, entryNotional, oi, entryNotional, p)).toBe(0n);
      expect(m.netExposureNotional(oi, oi, p)).toBe(0n);
    }
  });

  it("the pool owes longs when price rises", () => {
    expect(m.netTraderPnl(oi, entryNotional, 0n, 0n, P110)).toBe(100n * Q);
  });

  it("the pool gains when longs are wrong", () => {
    expect(m.netTraderPnl(oi, entryNotional, 0n, 0n, P90)).toBe(-100n * Q);
  });

  it("NAV subtracts what the pool owes", () => {
    expect(m.poolNav(10_000n * Q, 100n * Q)).toBe(9_900n * Q);
  });

  it("later depositors buy in at NAV, not book", () => {
    // $10,000 held, $5,000 owed => NAV $5,000 across 10,000 shares.
    expect(m.sharesForDeposit(1_000n * Q, 10_000n * Q, 5_000n * Q)).toBe(
      2_000n * Q,
    );
  });

  it("refuses to price shares in an underwater pool", () => {
    expect(() => m.sharesForDeposit(1_000n, 1_000n, -1n)).toThrow();
    expect(() => m.amountForShares(1_000n, 1_000n, 0n)).toThrow();
  });

  it("utilisation is exposure over capital, direction-blind", () => {
    expect(m.utilizationBps(5_000n * Q, 10_000n * Q)).toBe(5_000n);
    expect(m.utilizationBps(-5_000n * Q, 10_000n * Q)).toBe(5_000n);
    expect(m.utilizationBps(0n, 0n)).toBe(0n);
    expect(m.utilizationBps(1n, 0n)).toBeNull();
  });

  it("withdrawals are capped by what the open book requires", () => {
    expect(m.maxWithdrawable(10_000n * Q, 0n, 8_000)).toBe(10_000n * Q);
    expect(m.maxWithdrawable(10_000n * Q, 4_000n * Q, 8_000)).toBe(5_000n * Q);
    expect(m.maxWithdrawable(10_000n * Q, 8_000n * Q, 8_000)).toBe(0n);
    expect(m.maxWithdrawable(-1n, 0n, 8_000)).toBe(0n);
  });
});

describe("treasury, matching math/treasury.rs", () => {
  it("hedging holds NAV flat through a drawdown", () => {
    const stock = 10n * UNIT;
    const margin = 1_000n * Q;
    const P80 = 80n * m.PRICE_SCALE;

    const unhedgedBefore = m.treasuryExposure(
      stock,
      0n,
      0n,
      0n,
      0n,
      0n,
      P100,
    ).nav;
    const unhedgedAfter = m.treasuryExposure(
      stock,
      0n,
      0n,
      0n,
      0n,
      0n,
      P80,
    ).nav;
    expect(unhedgedBefore).toBe(1_000n * Q);
    expect(unhedgedAfter).toBe(800n * Q);

    const short = -10n * UNIT;
    const hedgedBefore = m.treasuryExposure(
      stock,
      short,
      margin,
      P100,
      0n,
      0n,
      P100,
    ).nav;
    const hedgedAfter = m.treasuryExposure(
      stock,
      short,
      margin,
      P100,
      0n,
      0n,
      P80,
    ).nav;
    expect(hedgedBefore).toBe(2_000n * Q);
    expect(hedgedAfter).toBe(2_000n * Q);
  });

  it("target delta spans neutral to unhedged", () => {
    expect(m.targetDelta(10n * UNIT, 10_000)).toBe(0n);
    expect(m.targetDelta(10n * UNIT, 0)).toBe(10n * UNIT);
    expect(m.targetDelta(10n * UNIT, 5_000)).toBe(5n * UNIT);
  });

  it("NAV per token handles a wiped-out treasury", () => {
    expect(m.navPerToken(-5n * Q, 1_000n)).toBe(0n);
    expect(m.navPerToken(1_000n * Q, 0n)).toBe(0n);
  });
});

describe("corporate actions, matching math/corporate_actions.rs", () => {
  it("a 4-for-1 quadruples size and quarters entry, leaving PnL untouched", () => {
    const size = 10n * UNIT;
    const entry = 200n * m.PRICE_SCALE;
    const before = m.notional(size, entry);

    const to = 4n * m.SPLIT_FACTOR_SCALE;
    const norm = m.normalizeForSplits(
      size,
      entry,
      0n,
      m.SPLIT_FACTOR_SCALE,
      to,
    );

    expect(norm.size).toBe(40n * UNIT);
    expect(norm.entryPrice).toBe(50n * m.PRICE_SCALE);
    expect(m.notional(norm.size, norm.entryPrice)).toBe(before);

    const markAfter = m.rescaleHistoricalPrice(entry, m.SPLIT_FACTOR_SCALE, to);
    expect(m.unrealizedPnl(norm.size, norm.entryPrice, markAfter)).toBe(0n);
  });

  it("is a no-op when the position is already current", () => {
    const f = m.SPLIT_FACTOR_SCALE;
    const r = m.normalizeForSplits(10n * UNIT, 200n * m.PRICE_SCALE, 5n, f, f);
    expect(r.size).toBe(10n * UNIT);
    expect(r.entryPrice).toBe(200n * m.PRICE_SCALE);
  });
});

describe("session matrix, matching math/session.rs", () => {
  it("lets traders out but not in while the venue is closed", () => {
    expect(sessionAllows("Closed", "ReduceRisk").allowed).toBe(true);
    expect(sessionAllows("Closed", "IncreaseRisk").allowed).toBe(false);
  });

  it("allows both while open", () => {
    expect(sessionAllows("Open", "IncreaseRisk").allowed).toBe(true);
    expect(sessionAllows("Open", "ReduceRisk").allowed).toBe(true);
  });

  it("blocks everything during a halt or the opening auction", () => {
    for (const s of ["Halted", "PreOpen"] as const) {
      expect(sessionAllows(s, "IncreaseRisk").allowed).toBe(false);
      expect(sessionAllows(s, "ReduceRisk").allowed).toBe(false);
    }
  });

  it("gives every refusal a reason the UI can show", () => {
    for (const s of ["Closed", "Halted", "PreOpen"] as const) {
      const r = sessionAllows(s, "IncreaseRisk");
      expect(r.allowed).toBe(false);
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});
