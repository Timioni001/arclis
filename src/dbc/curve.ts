/**
 * The thin layer between {@link planStockLaunch} and Meteora's SDK.
 *
 * Everything decided here is decided in `plan.ts`; this file only translates a
 * reviewed plan into the exact `ConfigParameters` `buildCurveWithMarketCap`
 * expects, and hands them back for `client.partner.createConfig`.
 *
 * Kept separate so the interesting logic stays unit-testable without pulling in
 * `@solana/web3.js`, a `Connection`, or a keypair.
 */

import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  ConfigParameters,
  MigrationFeeOption,
  MigrationOption,
  TokenDecimal,
  TokenType,
  TokenAuthorityOption,
  buildCurveWithMarketCap,
  validateConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

import { PublicKey } from "@solana/web3.js";

import { DEFAULTS, StockLaunchPlan } from "./plan";
import { StockCurveOptions } from "./types";

function toTokenDecimal(d: 6 | 7 | 8 | 9): TokenDecimal {
  switch (d) {
    case 6:
      return TokenDecimal.SIX;
    case 7:
      return TokenDecimal.SEVEN;
    case 8:
      return TokenDecimal.EIGHT;
    case 9:
      return TokenDecimal.NINE;
  }
}

/**
 * Build DBC `ConfigParameters` from a reviewed stock launch plan.
 *
 * Three choices here are equity-specific and worth calling out, because they
 * differ from what a memecoin launch would use:
 *
 * - **`activationType: Timestamp`, not `Slot`.** The fee schedule is pinned to
 *   an exchange opening bell, which is a wall-clock event. Slot timing drifts
 *   against wall clock by enough over a weekend to miss the open entirely.
 *
 * - **`collectFeeMode: QuoteToken`.** Fees accrue in the tokenized stock rather
 *   than in the launched token. For an agent treasury that is the point: fee
 *   income arrives in the same asset the treasury is denominated and hedged in,
 *   so it needs no conversion and does not add a second exposure.
 *
 * - **`dynamicFeeEnabled: true`, tuned per name.** The one-shot fee ramp prices
 *   the first overnight gap; the dynamic fee is the standing defence for every
 *   gap after it. See `recommendedMaxPriceChangeBps`.
 */
export function buildStockQuotedConfig(
  plan: StockLaunchPlan,
  options: StockCurveOptions = {},
): ConfigParameters {
  const { fees, targets } = plan;

  const config = buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: toTokenDecimal(targets.tokenDecimals),
      tokenQuoteDecimal: toTokenDecimal(plan.stock.decimals as 6 | 7 | 8 | 9),
      tokenAuthorityOption: TokenAuthorityOption.CreatorUpdateAuthority,
      totalTokenSupply: targets.totalTokenSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        // Exponential rather than linear: the stale-quote risk is concentrated
        // in the hours furthest from the open and falls away quickly once real
        // price discovery is close, which is the shape exponential decay has
        // and linear does not.
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: fees.startingFeeBps,
          endingFeeBps: fees.endingFeeBps,
          numberOfPeriod: fees.numberOfPeriod,
          totalDuration: fees.totalDuration,
        },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage:
        options.creatorTradingFeePercentage ??
        DEFAULTS.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 0,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 50,
    },
    lockedVesting: {
      totalLockedVestingAmount: Math.floor(
        (targets.totalTokenSupply *
          (options.lockedVestingPercentage ??
            DEFAULTS.lockedVestingPercentage)) /
          100,
      ),
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,

    // The two lines this whole toolkit exists for: DBC wants market caps in
    // quote tokens, the issuer thinks in dollars, and the conversion needs a
    // live oracle price because the quote token is a share.
    initialMarketCap: plan.initialMarketCapQuote,
    migrationMarketCap: plan.migrationMarketCapQuote,
  });

  return config;
}

/**
 * A stand-in `leftoverReceiver` used only to exercise the supply check.
 *
 * `validateTokenSupply` rejects `PublicKey.default` outright, but is otherwise
 * indifferent to *which* address receives leftovers — it only checks that the
 * pre- and post-migration supplies balance. So a placeholder lets the planning
 * CLI validate the numbers without a wallet, while the real receiver is still
 * required before a config is created. Wrapped SOL's mint is used because it is
 * unmistakably not somebody's wallet.
 */
export const PLACEHOLDER_LEFTOVER_RECEIVER = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

/**
 * Build and validate in one step.
 *
 * `validateConfigParameters` is the SDK's own checker, so running it here means
 * a bad config fails on the issuer's laptop rather than inside a
 * partially-signed mainnet transaction.
 *
 * `leftoverReceiver` is the address that collects base tokens left unsold after
 * migration. Pass the real one before creating a config; omitting it validates
 * against {@link PLACEHOLDER_LEFTOVER_RECEIVER}, which checks the supply maths
 * but says nothing about where leftovers actually go, and sets
 * `usedPlaceholderReceiver` so a caller can warn.
 */
export function buildAndValidate(
  plan: StockLaunchPlan,
  options: StockCurveOptions = {},
  leftoverReceiver?: PublicKey,
): {
  config: ConfigParameters;
  valid: boolean;
  error?: string;
  usedPlaceholderReceiver: boolean;
} {
  const config = buildStockQuotedConfig(plan, options);
  const usedPlaceholderReceiver = leftoverReceiver === undefined;
  const receiver = leftoverReceiver ?? PLACEHOLDER_LEFTOVER_RECEIVER;
  try {
    validateConfigParameters({
      ...config,
      leftoverReceiver: receiver,
    } as never);
    return { config, valid: true, usedPlaceholderReceiver };
  } catch (e) {
    return {
      config,
      valid: false,
      error: e instanceof Error ? e.message : String(e),
      usedPlaceholderReceiver,
    };
  }
}
