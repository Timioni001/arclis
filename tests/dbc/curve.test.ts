/**
 * Tests that the planned config is one Meteora will actually accept.
 *
 * These call the real SDK — `buildCurveWithMarketCap` and
 * `validateConfigParameters` — but touch no network. The point is that a
 * config's validity is proven here, on a laptop, rather than discovered inside
 * a partially-signed mainnet transaction.
 */
import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigrationOption,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

import { buildAndValidate, buildStockQuotedConfig } from "../../src/dbc/curve";
import { planStockLaunch } from "../../src/dbc/plan";
import { LaunchTargets, MarketSession, StockQuote } from "../../src/dbc/types";

const NOW = 1_760_000_000;
const RECEIVER = new PublicKey("So11111111111111111111111111111111111111112");

function stock(overrides: Partial<StockQuote> = {}): StockQuote {
  return {
    symbol: "AAPL",
    mint: "XsAAPLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    decimals: 8,
    priceUsd: 250,
    annualVolatility: 0.28,
    session: MarketSession.Open,
    nextOpenUnix: NOW + 18 * 3600,
    nextCloseUnix: NOW + 6 * 3600,
    ...overrides,
  };
}

const TARGETS: LaunchTargets = {
  initialMarketCapUsd: 5_000,
  migrationMarketCapUsd: 50_000,
  totalTokenSupply: 1_000_000_000,
  tokenDecimals: 6,
};

describe("stock-quoted DBC config", () => {
  it("passes Meteora's own validateConfigParameters", () => {
    const plan = planStockLaunch(stock(), TARGETS, NOW);
    const { valid, error } = buildAndValidate(plan, {}, RECEIVER);
    assert.isTrue(valid, `SDK rejected the config: ${error}`);
  });

  it("is still valid when launched into a closed session", () => {
    // The closed-session path produces a very different fee schedule (hours of
    // decay rather than minutes), so it needs validating separately.
    const plan = planStockLaunch(
      stock({ session: MarketSession.Closed }),
      TARGETS,
      NOW,
    );
    const { valid, error } = buildAndValidate(plan, {}, RECEIVER);
    assert.isTrue(valid, `SDK rejected the closed-session config: ${error}`);
  });

  it("reports when validation used the placeholder receiver", () => {
    const plan = planStockLaunch(stock(), TARGETS, NOW);
    assert.isTrue(buildAndValidate(plan).usedPlaceholderReceiver);
    assert.isFalse(
      buildAndValidate(plan, {}, RECEIVER).usedPlaceholderReceiver,
    );
  });

  it("uses timestamp activation, because the fee ramp tracks an opening bell", () => {
    // Slot timing drifts against wall clock by enough over a weekend to miss
    // the open entirely.
    const plan = planStockLaunch(stock(), TARGETS, NOW);
    const config = buildStockQuotedConfig(plan);
    assert.equal(config.activationType, ActivationType.Timestamp);
  });

  it("collects fees in the quote token, so fee income is already hedged", () => {
    // Fees arrive in the tokenized stock the treasury is denominated in,
    // rather than adding a second exposure in the launched token.
    const plan = planStockLaunch(stock(), TARGETS, NOW);
    const config = buildStockQuotedConfig(plan);
    assert.equal(config.collectFeeMode, CollectFeeMode.QuoteToken);
  });

  it("uses exponential fee decay and migrates to DAMM v2", () => {
    const plan = planStockLaunch(stock(), TARGETS, NOW);
    const config = buildStockQuotedConfig(plan);
    assert.equal(
      config.poolFees.baseFee.baseFeeMode,
      BaseFeeMode.FeeSchedulerExponential,
    );
    assert.equal(config.migrationOption, MigrationOption.MET_DAMM_V2);
  });

  it("carries the closed-session fee ramp into the built config", () => {
    const shutForHours = 18 * 3600;
    const plan = planStockLaunch(
      stock({
        session: MarketSession.Closed,
        nextOpenUnix: NOW + shutForHours,
      }),
      TARGETS,
      NOW,
    );
    const config = buildStockQuotedConfig(plan);

    // DBC encodes a fee scheduler as (firstFactor = number of periods,
    // secondFactor = seconds per period), so the ramp's wall-clock length is
    // their product rather than a single stored field.
    const periods = Number(config.poolFees.baseFee.firstFactor);
    const secondsPerPeriod = Number(config.poolFees.baseFee.secondFactor);
    assert.equal(
      periods * secondsPerPeriod,
      shutForHours,
      "the ramp must last exactly as long as the venue is shut",
    );
  });

  it("gives an open-session launch a far shorter ramp than a closed one", () => {
    // The distinction the whole fee design rests on: minutes of anti-sniper
    // protection when price discovery is live, hours of gap premium when it is
    // not.
    const dur = (s: StockQuote) => {
      const c = buildStockQuotedConfig(planStockLaunch(s, TARGETS, NOW));
      return (
        Number(c.poolFees.baseFee.firstFactor) *
        Number(c.poolFees.baseFee.secondFactor)
      );
    };
    const open = dur(stock({ session: MarketSession.Open }));
    const closed = dur(
      stock({ session: MarketSession.Closed, nextOpenUnix: NOW + 18 * 3600 }),
    );
    assert.equal(open, 600);
    assert.isAbove(closed, open * 10);
  });

  it("produces different curves for different stock prices", () => {
    // Same dollar targets against a cheaper share means more shares, so a
    // different sqrt start price. This is the conversion the toolkit exists for.
    const cheap = planStockLaunch(stock({ priceUsd: 10 }), TARGETS, NOW);
    const dear = planStockLaunch(stock({ priceUsd: 500 }), TARGETS, NOW);
    assert.notEqual(
      buildStockQuotedConfig(cheap).sqrtStartPrice.toString(),
      buildStockQuotedConfig(dear).sqrtStartPrice.toString(),
    );
  });
});
