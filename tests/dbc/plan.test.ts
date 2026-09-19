/**
 * Unit tests for stock-quoted DBC planning.
 *
 * Pure arithmetic, no validator and no RPC — these run in milliseconds with
 * `yarn test:dbc`, the same way `cargo test --lib` covers the on-chain maths.
 */
import { assert } from "chai";
import {
  DEFAULTS,
  activationAdvice,
  graduationDrift,
  planFeeSchedule,
  planStockLaunch,
  recommendedMaxPriceChangeBps,
  sigmaOverHorizon,
  toQuoteTokens,
  toUsd,
} from "../../src/dbc/plan";
import { LaunchTargets, MarketSession, StockQuote } from "../../src/dbc/types";

const NOW = 1_760_000_000;
const HOUR = 3600;

function aapl(overrides: Partial<StockQuote> = {}): StockQuote {
  return {
    symbol: "AAPL",
    mint: "XsAAPLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    decimals: 8,
    priceUsd: 250,
    annualVolatility: 0.28,
    session: MarketSession.Open,
    nextOpenUnix: NOW + 18 * HOUR,
    nextCloseUnix: NOW + 6 * HOUR,
    ...overrides,
  };
}

const TARGETS: LaunchTargets = {
  initialMarketCapUsd: 5_000,
  migrationMarketCapUsd: 50_000,
  totalTokenSupply: 1_000_000_000,
  tokenDecimals: 6,
};

describe("USD <-> share conversion", () => {
  it("converts a dollar target into shares at the current price", () => {
    // $50,000 at $250/share is 200 shares. This is the conversion no launchpad
    // UI does today, because for a USDC-quoted pool there is nothing to convert.
    assert.equal(toQuoteTokens(50_000, aapl()), 200);
  });

  it("round-trips", () => {
    const s = aapl();
    assert.closeTo(toUsd(toQuoteTokens(1234.56, s), s), 1234.56, 1e-9);
  });

  it("refuses a non-positive price rather than returning Infinity", () => {
    assert.throws(
      () => toQuoteTokens(1000, aapl({ priceUsd: 0 })),
      /price must be positive/,
    );
  });
});

describe("volatility scaling", () => {
  it("scales by the square root of time over trading days", () => {
    // One year of trading days must return the annual figure.
    assert.closeTo(sigmaOverHorizon(0.28, 252), 0.28, 1e-12);
    // Quartering the horizon halves sigma.
    assert.closeTo(sigmaOverHorizon(0.28, 63), 0.14, 1e-12);
  });

  it("is zero at a zero horizon", () => {
    assert.equal(sigmaOverHorizon(0.28, 0), 0);
  });
});

describe("graduation drift", () => {
  it("fixes the threshold in shares and lets the dollar value float", () => {
    const d = graduationDrift(50_000, aapl(), 30);
    assert.equal(d.thresholdQuoteTokens, 200);
    assert.equal(d.targetUsd, 50_000);
    // The band must straddle the target.
    assert.isBelow(d.lowUsd, 50_000);
    assert.isAbove(d.highUsd, 50_000);
  });

  it("is asymmetric, because prices are lognormal", () => {
    // A stock can double but cannot go below zero, so a symmetric band would
    // overstate the downside and understate the upside.
    const d = graduationDrift(50_000, aapl(), 30);
    assert.isAbove(d.highUsd - d.targetUsd, d.targetUsd - d.lowUsd);
  });

  it("widens with volatility", () => {
    const calm = graduationDrift(50_000, aapl({ annualVolatility: 0.15 }), 30);
    const wild = graduationDrift(50_000, aapl({ annualVolatility: 0.9 }), 30);
    assert.isAbove(wild.bandWidthPct, calm.bandWidthPct);
  });

  it("widens with the expected time to fill", () => {
    const fast = graduationDrift(50_000, aapl(), 1);
    const slow = graduationDrift(50_000, aapl(), 180);
    assert.isAbove(slow.bandWidthPct, fast.bandWidthPct);
  });

  it("collapses to the target at a zero horizon", () => {
    const d = graduationDrift(50_000, aapl(), 0);
    assert.closeTo(d.lowUsd, 50_000, 1e-9);
    assert.closeTo(d.highUsd, 50_000, 1e-9);
  });
});

describe("fee schedule", () => {
  it("charges no gap premium while the venue is open", () => {
    const p = planFeeSchedule(aapl({ session: MarketSession.Open }), NOW);
    assert.isFalse(p.pricesGapRisk);
    assert.equal(p.endingFeeBps, DEFAULTS.baseFeeBps);
    assert.equal(p.totalDuration, 600, "open-session ramp should be short");
  });

  it("charges a premium that decays exactly as the venue reopens", () => {
    // The central idea: the fee ramp is pinned to the opening bell, so the
    // premium covers precisely the window where the quote price is frozen.
    const stock = aapl({
      session: MarketSession.Closed,
      nextOpenUnix: NOW + 18 * HOUR,
    });
    const p = planFeeSchedule(stock, NOW);

    assert.isTrue(p.pricesGapRisk);
    assert.equal(p.totalDuration, 18 * HOUR);
    assert.equal(
      p.startingFeeBps,
      DEFAULTS.baseFeeBps * DEFAULTS.closedSessionFeeMultiple,
    );
    assert.equal(p.endingFeeBps, DEFAULTS.baseFeeBps);
    assert.isAbove(p.numberOfPeriod, 0);
  });

  it("scales the premium over a long weekend the same way", () => {
    const friday = aapl({
      session: MarketSession.Closed,
      nextOpenUnix: NOW + 65 * HOUR,
    });
    const p = planFeeSchedule(friday, NOW);
    assert.equal(p.totalDuration, 65 * HOUR);
    assert.include(p.rationale, "65.0h");
  });

  it("holds a flat premium when there is no scheduled reopen", () => {
    // A halt with no resolution time: decaying into an unknown open would be
    // guessing, so hold the premium instead.
    const halted = aapl({ session: MarketSession.Halted, nextOpenUnix: 0 });
    const p = planFeeSchedule(halted, NOW);
    assert.equal(p.startingFeeBps, p.endingFeeBps);
    assert.equal(p.totalDuration, 0);
    assert.isTrue(p.pricesGapRisk);
  });

  it("respects the starting-fee ceiling", () => {
    const p = planFeeSchedule(aapl({ session: MarketSession.Closed }), NOW, {
      baseFeeBps: 500,
      closedSessionFeeMultiple: 100,
      maxStartingFeeBps: 900,
    });
    assert.equal(p.startingFeeBps, 900);
  });

  it("rejects a base fee outside DBC's own bounds", () => {
    assert.throws(
      () => planFeeSchedule(aapl(), NOW, { baseFeeBps: 0 }),
      /baseFeeBps/,
    );
    assert.throws(
      () => planFeeSchedule(aapl(), NOW, { baseFeeBps: 99_999 }),
      /baseFeeBps/,
    );
  });

  it("never schedules a fee that rises", () => {
    for (const session of Object.values(MarketSession)) {
      const p = planFeeSchedule(aapl({ session }), NOW);
      assert.isAtLeast(
        p.startingFeeBps,
        p.endingFeeBps,
        `${session}: DBC's scheduler only decays`,
      );
    }
  });
});

describe("dynamic fee tuning", () => {
  it("sizes the trigger off the specific name, not a memecoin default", () => {
    // DBC's 1500bps default needs a 15% move — a once-in-a-decade day for a
    // large cap, so it would never fire.
    const calm = recommendedMaxPriceChangeBps(aapl({ annualVolatility: 0.25 }));
    assert.isBelow(calm, 1500);
    assert.isAbove(calm, 100);
  });

  it("gives a more volatile name a wider trigger", () => {
    const calm = recommendedMaxPriceChangeBps(aapl({ annualVolatility: 0.2 }));
    const wild = recommendedMaxPriceChangeBps(aapl({ annualVolatility: 0.7 }));
    assert.isAbove(wild, calm);
  });

  it("clamps into DBC's accepted range at both extremes", () => {
    assert.equal(
      recommendedMaxPriceChangeBps(aapl({ annualVolatility: 0 })),
      100,
    );
    assert.equal(
      recommendedMaxPriceChangeBps(aapl({ annualVolatility: 5 })),
      1500,
    );
  });
});

describe("activation advice", () => {
  it("approves an open venue", () => {
    assert.isTrue(
      activationAdvice(aapl({ session: MarketSession.Open }), NOW).safe,
    );
  });

  it("refuses a halt, a pre-open auction, and a closed venue", () => {
    for (const s of [
      MarketSession.Halted,
      MarketSession.PreOpen,
      MarketSession.Closed,
    ]) {
      const a = activationAdvice(aapl({ session: s }), NOW);
      assert.isFalse(a.safe, `${s} should not be a safe activation window`);
      assert.isAbove(a.reason.length, 0);
    }
  });
});

describe("planStockLaunch", () => {
  it("produces a plan with market caps in shares, not dollars", () => {
    const plan = planStockLaunch(aapl(), TARGETS, NOW);
    // DBC stores quote tokens; the issuer typed dollars.
    assert.equal(plan.initialMarketCapQuote, 20); // $5,000 / $250
    assert.equal(plan.migrationMarketCapQuote, 200); // $50,000 / $250
  });

  it("rejects a curve that does not go up", () => {
    assert.throws(
      () =>
        planStockLaunch(
          aapl(),
          { ...TARGETS, migrationMarketCapUsd: 1_000 },
          NOW,
        ),
      /must exceed/,
    );
  });

  it("warns when the venue is shut at activation", () => {
    const plan = planStockLaunch(
      aapl({ session: MarketSession.Closed }),
      TARGETS,
      NOW,
    );
    assert.isAbove(plan.warnings.length, 0);
    assert.isFalse(plan.activation.safe);
  });

  it("warns when the dollar target will drift badly", () => {
    const plan = planStockLaunch(
      aapl({ annualVolatility: 1.2 }),
      TARGETS,
      NOW,
      {},
      180,
    );
    assert.isTrue(
      plan.warnings.some((w) => w.includes("Graduation target drifts")),
    );
  });

  it("warns on an absurdly steep curve", () => {
    const plan = planStockLaunch(
      aapl(),
      {
        ...TARGETS,
        initialMarketCapUsd: 100,
        migrationMarketCapUsd: 5_000_000,
      },
      NOW,
    );
    assert.isTrue(plan.warnings.some((w) => w.includes("steep curve")));
  });

  it("is quiet when everything is sane", () => {
    const plan = planStockLaunch(
      aapl({ session: MarketSession.Open, annualVolatility: 0.2 }),
      TARGETS,
      NOW,
      {},
      7,
    );
    assert.deepEqual(
      plan.warnings,
      [],
      `unexpected warnings: ${plan.warnings.join(" | ")}`,
    );
  });
});
