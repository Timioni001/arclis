/**
 * Planning logic for stock-quoted DBC launches.
 *
 * Deliberately free of the Meteora SDK, `@solana/web3.js`, and any network
 * call — everything here is arithmetic over plain numbers, so it unit-tests in
 * milliseconds. `curve.ts` is the thin layer that feeds these results into
 * `buildCurveWithMarketCap`.
 *
 * ---
 *
 * ## Why a stock-quoted pool is not a memecoin pool
 *
 * DBC stores every threshold in **quote tokens**. Launch quoted in USDC and a
 * 50,000-token migration threshold means $50,000, today and forever. Launch
 * quoted in AAPLx and a 200-token threshold means $50,000 only while Apple
 * trades at $250.
 *
 * Three consequences, and this module exists to handle each:
 *
 * 1. **Issuers think in dollars; DBC stores shares.** `toQuoteTokens` does the
 *    conversion, and it needs a price, which means it needs an oracle.
 * 2. **The dollar target drifts after launch.** A fixed share threshold is a
 *    floating dollar goal. `graduationDrift` quantifies the band so the issuer
 *    sees it before signing rather than at graduation.
 * 3. **The quote asset stops trading at 4pm.** For most of the week the pool
 *    prices a base token against a quote token whose own price is frozen.
 *    `planFeeSchedule` prices that.
 */

import {
  GraduationDrift,
  FeeSchedulePlan,
  LaunchTargets,
  MarketSession,
  StockCurveOptions,
  StockQuote,
} from "./types";

/** DBC's own ceiling on a base fee, in bps. */
export const DBC_MAX_FEE_BPS = 9900;
/** DBC's own floor. */
export const DBC_MIN_FEE_BPS = 1;

export const DEFAULTS = {
  baseFeeBps: 100, // 1%
  closedSessionFeeMultiple: 4,
  maxStartingFeeBps: 1_000, // 10%
  creatorTradingFeePercentage: 50,
  lockedVestingPercentage: 0,
} as const;

/** Trading days in a year, for scaling annualised vol to a horizon. */
const TRADING_DAYS_PER_YEAR = 252;

/**
 * Convert a USD amount into quote tokens (shares) at the current price.
 *
 * This is the conversion every stock-quoted launch needs and no launchpad UI
 * currently does: the issuer types "$50,000", DBC needs "200 AAPLx".
 */
export function toQuoteTokens(usd: number, stock: StockQuote): number {
  if (stock.priceUsd <= 0) {
    throw new Error(
      `${stock.symbol}: price must be positive, got ${stock.priceUsd}`,
    );
  }
  if (usd < 0) throw new Error(`amount must be non-negative, got ${usd}`);
  return usd / stock.priceUsd;
}

/** Inverse of {@link toQuoteTokens}. */
export function toUsd(quoteTokens: number, stock: StockQuote): number {
  return quoteTokens * stock.priceUsd;
}

/**
 * Scale annualised volatility to a horizon, by the square root of time.
 *
 * Trading days, not calendar days: an equity does not diffuse over a weekend,
 * which is the same fact the session model encodes on-chain.
 */
export function sigmaOverHorizon(
  annualVolatility: number,
  horizonDays: number,
): number {
  if (annualVolatility < 0) throw new Error("volatility must be non-negative");
  if (horizonDays < 0) throw new Error("horizon must be non-negative");
  return annualVolatility * Math.sqrt(horizonDays / TRADING_DAYS_PER_YEAR);
}

/**
 * How much the dollar value of a fixed share-denominated graduation threshold
 * can move before the curve fills.
 *
 * This is the number an issuer should see before they sign a config. A launch
 * configured for "$50k" on a 30% vol stock over a 30-day expected fill is
 * really a launch for somewhere between roughly $45k and $55k, and if it takes
 * a quarter to fill, wider still. Nothing in DBC surfaces this, because for a
 * USDC-quoted pool there is nothing to surface.
 */
export function graduationDrift(
  targetUsd: number,
  stock: StockQuote,
  horizonDays: number,
): GraduationDrift {
  const thresholdQuoteTokens = toQuoteTokens(targetUsd, stock);
  const sigma = sigmaOverHorizon(stock.annualVolatility, horizonDays);

  // Lognormal one-sigma moves, so the band is asymmetric — a stock can double
  // but cannot fall below zero, and a symmetric band would overstate the
  // downside and understate the upside.
  const lowUsd = targetUsd * Math.exp(-sigma);
  const highUsd = targetUsd * Math.exp(sigma);

  return {
    thresholdQuoteTokens,
    targetUsd,
    lowUsd,
    highUsd,
    horizonDays,
    bandWidthPct: targetUsd === 0 ? 0 : (highUsd - lowUsd) / targetUsd,
  };
}

/**
 * Build a fee schedule that prices the overnight gap.
 *
 * ## The problem
 *
 * A stock-quoted DBC pool trades continuously. Its quote asset does not. From
 * 16:00 Friday to 09:30 Monday the pool will happily fill orders against a
 * quote token whose price has not moved since Friday's close — and whose real
 * price is already moving, in after-hours prints, on news, in every other
 * market on earth.
 *
 * Whoever trades that pool on Sunday holds a free option on Monday's open. The
 * liquidity provider is on the other side of it.
 *
 * ## The lever
 *
 * DBC's fee scheduler decays monotonically from `startingFeeBps` to
 * `endingFeeBps` over `totalDuration`, starting at pool activation. It was
 * designed as an anti-sniper ramp for memecoin launches, and it is normally
 * set to a few minutes.
 *
 * Point it at the equity calendar instead. A pool activating while the venue is
 * shut starts at a multiple of the base fee and decays to the floor **exactly
 * as the market opens** — so the premium is charged over precisely the window
 * where the quote price is stale, and normal fees resume the moment real price
 * discovery does.
 *
 * A pool activating during a live session has no gap to price, so it gets a
 * short, shallow anti-sniper ramp instead.
 *
 * ## The honest limitation
 *
 * The scheduler is monotonic and one-shot: it decays once from activation and
 * never rises again. So this prices the *first* close-to-open window and no
 * later one. Recurring overnight premia would need either a config rotation
 * between sessions or DBC's dynamic fee, which reacts to realised volatility
 * rather than to the calendar — {@link recommendedMaxPriceChangeBps} tunes that
 * for equities as the standing complement to this one-shot ramp.
 */
export function planFeeSchedule(
  stock: StockQuote,
  nowUnix: number,
  options: StockCurveOptions = {},
): FeeSchedulePlan {
  const baseFeeBps = options.baseFeeBps ?? DEFAULTS.baseFeeBps;
  const multiple =
    options.closedSessionFeeMultiple ?? DEFAULTS.closedSessionFeeMultiple;
  const maxStarting = options.maxStartingFeeBps ?? DEFAULTS.maxStartingFeeBps;

  if (baseFeeBps < DBC_MIN_FEE_BPS || baseFeeBps > DBC_MAX_FEE_BPS) {
    throw new Error(
      `baseFeeBps must be within [${DBC_MIN_FEE_BPS}, ${DBC_MAX_FEE_BPS}]`,
    );
  }
  if (multiple < 1)
    throw new Error("closedSessionFeeMultiple must be at least 1");

  const venueLive = stock.session === MarketSession.Open;

  if (venueLive) {
    // Real price discovery is available, so there is no stale-quote premium to
    // charge. Keep only a short anti-sniper ramp over the first ten minutes.
    const starting = Math.min(baseFeeBps * 2, maxStarting, DBC_MAX_FEE_BPS);
    return {
      startingFeeBps: starting,
      endingFeeBps: baseFeeBps,
      numberOfPeriod: 10,
      totalDuration: 600,
      rationale:
        `${stock.symbol} is open, so the quote price is live and there is no gap to ` +
        `price. Short anti-sniper ramp only: ${starting}bps decaying to ${baseFeeBps}bps ` +
        `over 10 minutes.`,
      pricesGapRisk: false,
    };
  }

  // Shut. Charge the premium until the venue reopens.
  const secondsToOpen = Math.max(stock.nextOpenUnix - nowUnix, 0);
  const starting = Math.min(
    Math.round(baseFeeBps * multiple),
    maxStarting,
    DBC_MAX_FEE_BPS,
  );

  if (secondsToOpen === 0) {
    // Shut with no scheduled reopen — a halt with no resolution time, or a bad
    // calendar. Hold the premium flat rather than guess a decay window.
    return {
      startingFeeBps: starting,
      endingFeeBps: starting,
      numberOfPeriod: 0,
      totalDuration: 0,
      rationale:
        `${stock.symbol} is ${stock.session.toLowerCase()} with no scheduled reopen. ` +
        `Holding a flat ${starting}bps rather than decaying into an unknown open.`,
      pricesGapRisk: true,
    };
  }

  // One step per ten minutes, clamped to DBC's practical range, so the decay is
  // smooth rather than a cliff.
  const numberOfPeriod = Math.max(
    1,
    Math.min(120, Math.floor(secondsToOpen / 600)),
  );
  const hours = (secondsToOpen / 3600).toFixed(1);

  return {
    startingFeeBps: starting,
    endingFeeBps: baseFeeBps,
    numberOfPeriod,
    totalDuration: secondsToOpen,
    rationale:
      `${stock.symbol} is ${stock.session.toLowerCase()}; its quote price is frozen for ` +
      `${hours}h. Anyone trading this pool before the open holds a free option on the ` +
      `gap, so the fee starts at ${starting}bps (${multiple}x base) and decays to ` +
      `${baseFeeBps}bps exactly as the venue reopens and real price discovery resumes.`,
    pricesGapRisk: true,
  };
}

/**
 * Trigger threshold for DBC's dynamic fee, tuned for an equity quote token.
 *
 * DBC's default is 1500 bps — a 15% move before the volatility surcharge really
 * bites. That is calibrated for memecoins, where 15% is a quiet afternoon. A
 * large-cap equity that moves 15% has had a once-in-a-decade day, so the
 * default never fires and the dynamic fee is effectively off.
 *
 * Size it off the asset instead: a two-sigma daily move for this specific
 * stock. A 25%-vol name gets roughly 315bps, a 60%-vol name roughly 755bps, and
 * both start charging when *that name* is genuinely disorderly.
 */
export function recommendedMaxPriceChangeBps(stock: StockQuote): number {
  const dailySigma = sigmaOverHorizon(stock.annualVolatility, 1);
  const twoSigmaBps = Math.round(dailySigma * 2 * 10_000);
  // Stay inside DBC's own accepted range.
  return Math.max(100, Math.min(twoSigmaBps, 1_500));
}

/**
 * Whether it is sane to *activate* a pool right now.
 *
 * Advisory, not enforced — DBC has no oracle hook, so nothing on-chain can stop
 * an activation during a halt. Surfacing it is the point: the failure mode is
 * an issuer activating at 02:00 on a Sunday without realising the first
 * eighteen hours of their launch will trade against a frozen price.
 */
export function activationAdvice(
  stock: StockQuote,
  nowUnix: number,
): { safe: boolean; reason: string } {
  switch (stock.session) {
    case MarketSession.Open:
      return {
        safe: true,
        reason: `${stock.symbol} is open — quote price is live and price discovery is real.`,
      };
    case MarketSession.Halted:
      return {
        safe: false,
        reason:
          `${stock.symbol} is halted. There is no reliable quote price, so every fill ` +
          `until the halt lifts is priced off a stale print. Wait for the resumption.`,
      };
    case MarketSession.PreOpen: {
      const mins = Math.round(Math.max(stock.nextOpenUnix - nowUnix, 0) / 60);
      return {
        safe: false,
        reason:
          `${stock.symbol} is in the opening auction (${mins}min to open). Indications ` +
          `move fast and are not firm; wait for the open.`,
      };
    }
    case MarketSession.Closed: {
      const hours = (Math.max(stock.nextOpenUnix - nowUnix, 0) / 3600).toFixed(
        1,
      );
      return {
        safe: false,
        reason:
          `${stock.symbol} is closed for ${hours}h. Launching now is possible and the ` +
          `fee schedule will price the gap, but the first ${hours}h of your curve will ` +
          `fill against a frozen quote price. Prefer activating just after the open.`,
      };
    }
  }
}

/** Everything an issuer needs to review before signing a config. */
export interface StockLaunchPlan {
  stock: StockQuote;
  targets: LaunchTargets;
  /** Market caps converted into quote tokens, which is what DBC stores. */
  initialMarketCapQuote: number;
  migrationMarketCapQuote: number;
  fees: FeeSchedulePlan;
  dynamicFeeMaxPriceChangeBps: number;
  drift: GraduationDrift;
  activation: { safe: boolean; reason: string };
  warnings: string[];
}

/**
 * Turn dollar targets and a live stock quote into a reviewable launch plan.
 *
 * This is the function the CLI and any issuer UI should call. It does not touch
 * the chain and does not sign anything — it produces the numbers a human should
 * look at before a config exists.
 */
export function planStockLaunch(
  stock: StockQuote,
  targets: LaunchTargets,
  nowUnix: number,
  options: StockCurveOptions = {},
  expectedFillDays = 30,
): StockLaunchPlan {
  if (targets.migrationMarketCapUsd <= targets.initialMarketCapUsd) {
    throw new Error(
      "migrationMarketCapUsd must exceed initialMarketCapUsd — the curve has to go up",
    );
  }

  const fees = planFeeSchedule(stock, nowUnix, options);
  const drift = graduationDrift(
    targets.migrationMarketCapUsd,
    stock,
    expectedFillDays,
  );
  const activation = activationAdvice(stock, nowUnix);

  const warnings: string[] = [];
  if (!activation.safe) warnings.push(activation.reason);

  if (drift.bandWidthPct > 0.25) {
    warnings.push(
      `Graduation target drifts ±${(drift.bandWidthPct * 50).toFixed(0)}% over ` +
        `${expectedFillDays}d at ${(stock.annualVolatility * 100).toFixed(0)}% vol: ` +
        `$${Math.round(drift.lowUsd).toLocaleString()}–` +
        `$${Math.round(drift.highUsd).toLocaleString()} against a ` +
        `$${Math.round(drift.targetUsd).toLocaleString()} target. The threshold is fixed ` +
        `in ${stock.symbol} shares, so the dollar goal moves with the stock. Consider a ` +
        `shorter expected fill or a lower target.`,
    );
  }

  if (stock.annualVolatility > 0.8) {
    warnings.push(
      `${(stock.annualVolatility * 100).toFixed(0)}% annualised vol is high for an ` +
        `equity quote token. The pool inherits that volatility on top of the base ` +
        `token's own.`,
    );
  }

  const ratio = targets.migrationMarketCapUsd / targets.initialMarketCapUsd;
  if (ratio > 100) {
    warnings.push(
      `Migration FDV is ${ratio.toFixed(0)}x the initial FDV. That is a very steep curve; ` +
        `most of the supply will clear near the top and graduation may never be reached.`,
    );
  }

  return {
    stock,
    targets,
    initialMarketCapQuote: toQuoteTokens(targets.initialMarketCapUsd, stock),
    migrationMarketCapQuote: toQuoteTokens(
      targets.migrationMarketCapUsd,
      stock,
    ),
    fees,
    dynamicFeeMaxPriceChangeBps: recommendedMaxPriceChangeBps(stock),
    drift,
    activation,
    warnings,
  };
}
