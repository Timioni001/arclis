/**
 * The registry's arithmetic. Pure, integer, and tested.
 *
 * Everything a holder is told on the registry page comes out of this file.
 * That is on purpose: a transparency product whose numbers are computed inline
 * in a component is a transparency product nobody can check.
 *
 * Two rules the scoring follows, both of which cost it some apparent
 * simplicity and are worth it:
 *
 *  1. **Nothing is penalised for being what it says it is.** A synthetic that
 *     is disclosed as synthetic scores lower on backing than a redeemable
 *     claim, because it *is* a weaker claim. It is not additionally penalised
 *     for dishonesty, because it was not dishonest. The score measures the
 *     strength of the claim, not the virtue of the issuer.
 *
 *  2. **Nothing here is a recommendation.** There is no overall "buy" number,
 *     no ranking that mixes backing with liquidity into one figure. They are
 *     different risks and a holder needs to see both. Collapsing them is how a
 *     transparency product quietly becomes a league table, and a league table
 *     is a thing issuers pay to move.
 */

import type { MarketSession } from "../protocol/types";
import {
  BACKING_RANK,
  REGISTRY_BPS_SCALE,
  REGISTRY_PRICE_SCALE,
  type AttestationCadence,
  type BackingTier,
  type PoolDepth,
  type RedemptionAccess,
  type TokenizedStock,
} from "./types";

// ---------------------------------------------------------------------------
// NAV deviation
// ---------------------------------------------------------------------------

export type DeviationVerdict =
  "Fair" | "Premium" | "Discount" | "Stale" | "Dislocated";

export interface Deviation {
  /** Signed basis points: positive means the token trades above the stock. */
  bps: number;
  verdict: DeviationVerdict;
  /** One sentence a non-technical holder can act on. */
  note: string;
  /** True when the reference venue is shut, so the deviation is partly just
   *  the clock rather than a mispricing. */
  referenceStale: boolean;
}

/**
 * Signed deviation of the on-chain price from the reference price, in bps.
 *
 * Integer throughout. Rounds toward zero, so a deviation is never reported as
 * larger than it is.
 */
export function deviationBps(onChain: bigint, reference: bigint): number {
  if (reference <= 0n) return 0;
  const diff = onChain - reference;
  return Number((diff * REGISTRY_BPS_SCALE) / reference);
}

/**
 * How far the token may drift from the stock before it is worth saying
 * something, given what the reference venue is doing.
 *
 * This is the session matrix from the perp engine applied to a different
 * question, and it is the part of this page most other trackers get wrong.
 * When the US market is shut, the reference price is Friday's close and the
 * token keeps trading. A 90 bps gap at 2am Sunday is the market pricing the
 * weekend's news into an asset whose reference has not updated. Flagging that
 * as a mispricing would train holders to ignore the flag, which is worse than
 * not having one.
 */
export function deviationToleranceBps(session: MarketSession): number {
  switch (session) {
    case "Open":
      // The reference is live. An arbitrageur can close this in one block, so
      // anything wide is a real signal about the token, not about the clock.
      return 50;
    case "PreOpen":
      // Indications are moving; the token is allowed to front-run the print.
      return 150;
    case "Closed":
      // The reference is frozen and the token is not. Most of the gap is time.
      return 300;
    case "Halted":
      // There is no reference price worth the name. Nothing is tolerable
      // because nothing is measurable; say so instead of scoring it.
      return 0;
  }
}

export function assessDeviation(
  stock: TokenizedStock,
  nowTs: number,
): Deviation {
  const bps = deviationBps(stock.onChainPrice, stock.referencePrice);
  const tolerance = deviationToleranceBps(stock.referenceSession);
  const referenceStale = stock.referenceSession !== "Open";
  const magnitude = Math.abs(bps);

  if (stock.referenceSession === "Halted") {
    return {
      bps,
      verdict: "Stale",
      referenceStale: true,
      note:
        "The reference stock is halted, so there is no price to compare against. " +
        "Any quote you see on-chain right now is the market guessing.",
    };
  }

  // A reference price that has not updated in a whole session is a data
  // problem, not a pricing one, and it outranks the number.
  const ageSecs = Math.max(0, nowTs - stock.referenceTs);
  if (stock.referenceSession === "Open" && ageSecs > 15 * 60) {
    return {
      bps,
      verdict: "Stale",
      referenceStale: true,
      note:
        `The reference price is ${Math.floor(ageSecs / 60)} minutes old while the market is open. ` +
        "Treat the comparison below as indicative until it refreshes.",
    };
  }

  if (magnitude <= tolerance) {
    return {
      bps,
      verdict: "Fair",
      referenceStale,
      note: referenceStale
        ? "Trading in line with the last reference print, allowing for the market being shut."
        : "Trading in line with the underlying stock.",
    };
  }

  // Past roughly 5%, the gap is no longer a spread; something structural is
  // wrong - a broken redemption, a drained pool, a depegged wrapper.
  if (magnitude >= 500) {
    return {
      bps,
      verdict: "Dislocated",
      referenceStale,
      note:
        `This token is trading ${formatBps(magnitude)} ${bps > 0 ? "above" : "below"} the stock it tracks. ` +
        "A gap this wide usually means redemption is not working, not that the stock moved.",
    };
  }

  return {
    bps,
    verdict: bps > 0 ? "Premium" : "Discount",
    referenceStale,
    note:
      bps > 0
        ? `You would pay ${formatBps(magnitude)} more than the stock is worth buying this right now.` +
          (referenceStale ? " Some of that is the market being shut." : "")
        : `This is ${formatBps(magnitude)} cheaper than the stock, which is good to buy and bad to sell.` +
          (referenceStale ? " Some of that is the market being shut." : ""),
  };
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps < 100 ? 2 : 1)}%`;
}

// ---------------------------------------------------------------------------
// Backing strength
// ---------------------------------------------------------------------------

export interface BackingAssessment {
  tier: BackingTier;
  /** 0 to 100. A composite of the claim, who can exercise it, whether anyone
   *  independent checks, and whether a custodian is named. */
  score: number;
  /** The individual components, so the number can be argued with rather than
   *  just trusted. A score with no breakdown is an oracle, and this product
   *  exists because people are tired of those. */
  components: Array<{
    label: string;
    points: number;
    max: number;
    detail: string;
  }>;
}

const REDEMPTION_POINTS: Record<RedemptionAccess, number> = {
  AnyHolder: 25,
  VerifiedHolders: 18,
  AuthorizedParticipants: 8,
  None: 0,
};

const ATTESTATION_POINTS: Record<AttestationCadence, number> = {
  Realtime: 25,
  Daily: 20,
  Monthly: 12,
  Quarterly: 6,
  None: 0,
};

export function assessBacking(
  stock: TokenizedStock,
  attestation: AttestationCadence,
  regulator: string | null,
): BackingAssessment {
  const claimPoints = BACKING_RANK[stock.backing] * 10; // 10..40
  const redemptionPoints = REDEMPTION_POINTS[stock.redemption];
  const attestationPoints = ATTESTATION_POINTS[attestation];
  const custodyPoints = stock.custodian ? 10 : 0;

  const components = [
    {
      label: "Claim",
      points: claimPoints,
      max: 40,
      detail:
        stock.backing === "Synthetic"
          ? "The token holds nothing. It tracks a price."
          : stock.backing === "Redeemable"
            ? "The token is a claim on a share, exercisable by the holder."
            : stock.backing === "CustodyBacked"
              ? "Shares are held against the token, but the holder cannot demand them directly."
              : "The issuer states shares are held. No third party confirms it.",
    },
    {
      label: "Redemption",
      points: redemptionPoints,
      max: 25,
      detail:
        stock.redemption === "None"
          ? "There is no way to convert this back into a share. Your only exit is selling it."
          : stock.redemption === "AuthorizedParticipants"
            ? "Only market makers can redeem. In practice your exit is the DEX pool below."
            : stock.redemption === "VerifiedHolders"
              ? "Redemption requires an account with the issuer."
              : "Any holder can redeem.",
    },
    {
      label: "Independent attestation",
      points: attestationPoints,
      max: 25,
      detail:
        attestation === "None"
          ? "Nobody outside the issuer publishes confirmation that the shares exist."
          : `Holdings are attested ${attestation.toLowerCase()} by a third party.`,
    },
    {
      label: "Named custodian",
      points: custodyPoints,
      max: 10,
      detail: stock.custodian
        ? `Shares sit with ${stock.custodian}.`
        : "No custodian is named, so there is nobody to ask.",
    },
  ];

  // The regulator is reported in the components above via the structure, and
  // deliberately does not add points: a regulated wrapper around an
  // unredeemable token is still unredeemable, and letting a licence buy score
  // is exactly how a badge scheme turns into pay-to-rank.
  void regulator;

  const score = components.reduce((sum, c) => sum + c.points, 0);
  return { tier: stock.backing, score, components };
}

// ---------------------------------------------------------------------------
// Exit liquidity
// ---------------------------------------------------------------------------

export type LiquidityVerdict = "Deep" | "Adequate" | "Thin" | "Illiquid";

export interface LiquidityAssessment {
  verdict: LiquidityVerdict;
  /** Total quote-side liquidity across every pool, at REGISTRY_PRICE_SCALE. */
  totalQuoteLiquidity: bigint;
  /** The best (lowest) sell impact available across venues, in bps. */
  bestSellImpactBps: number;
  /** The venue that offers it. */
  bestVenue: string | null;
  note: string;
}

/**
 * Judge the exit, not the pool.
 *
 * TVL is the number every other dashboard shows and it is the wrong one. A
 * $10m pool that is 95% one-sided will not let you out. Price impact on a real
 * sell is what a holder actually experiences, so that is what ranks here; TVL
 * is reported beside it as context.
 */
export function assessLiquidity(pools: PoolDepth[]): LiquidityAssessment {
  if (pools.length === 0) {
    return {
      verdict: "Illiquid",
      totalQuoteLiquidity: 0n,
      bestSellImpactBps: 0,
      bestVenue: null,
      note: "No DEX pool found. Without redemption, there is currently no way out of this position.",
    };
  }

  const totalQuoteLiquidity = pools.reduce(
    (sum, p) => sum + p.quoteLiquidity,
    0n,
  );
  let best = pools[0];
  for (const p of pools) {
    if (p.sellImpactBps < best.sellImpactBps) best = p;
  }

  const impact = best.sellImpactBps;
  const probe = Number(best.depthProbeQuote / REGISTRY_PRICE_SCALE);
  const probeLabel = `$${probe.toLocaleString("en-US")}`;

  if (impact <= 25) {
    return {
      verdict: "Deep",
      totalQuoteLiquidity,
      bestSellImpactBps: impact,
      bestVenue: best.venue,
      note: `Selling ${probeLabel} on ${best.venue} moves the price ${(impact / 100).toFixed(2)}%. You can get out at close to the quote.`,
    };
  }
  if (impact <= 100) {
    return {
      verdict: "Adequate",
      totalQuoteLiquidity,
      bestSellImpactBps: impact,
      bestVenue: best.venue,
      note: `Selling ${probeLabel} on ${best.venue} costs about ${(impact / 100).toFixed(2)}% in impact. Fine for retail size, tight for anything larger.`,
    };
  }
  if (impact <= 500) {
    return {
      verdict: "Thin",
      totalQuoteLiquidity,
      bestSellImpactBps: impact,
      bestVenue: best.venue,
      note: `Selling ${probeLabel} would move the price ${(impact / 100).toFixed(1)}%. Size your exit, or plan to use redemption instead.`,
    };
  }
  return {
    verdict: "Illiquid",
    totalQuoteLiquidity,
    bestSellImpactBps: impact,
    bestVenue: best.venue,
    note: `Even ${probeLabel} moves the price ${(impact / 100).toFixed(1)}%. Treat the quoted price as decorative.`,
  };
}

// ---------------------------------------------------------------------------
// Mint control
// ---------------------------------------------------------------------------

export interface ControlFinding {
  label: string;
  /** "neutral" where a power is expected for the structure, "watch" where it
   *  is a real and often undisclosed power over a holder's balance. */
  tone: "neutral" | "watch";
  detail: string;
}

/**
 * What the mint's own authorities let somebody do to a holder.
 *
 * Reported, not scored. A freeze authority on a regulated security token is
 * required by the regulation; the same authority on a token marketed as
 * permissionless is a different fact entirely. The page's job is to make sure
 * the holder knows it is there, and the structure column right beside it is
 * what tells them which case they are in.
 */
export function assessControl(stock: TokenizedStock): ControlFinding[] {
  const findings: ControlFinding[] = [];

  findings.push(
    stock.mint.freezeAuthority
      ? {
          label: "Balances can be frozen",
          tone: "watch",
          detail:
            "The freeze authority is set, so the issuer can render your tokens untransferable. " +
            "Regulated share tokens generally need this; permissionless ones do not.",
        }
      : {
          label: "Balances cannot be frozen",
          tone: "neutral",
          detail: "No freeze authority. Nobody can immobilise your balance.",
        },
  );

  findings.push(
    stock.mint.mintAuthority
      ? {
          label: "Supply can be increased",
          tone: "watch",
          detail:
            "The mint authority is live, so more tokens can be created. For a backed token this is " +
            "how new shares enter; it is also how an unbacked one would.",
        }
      : {
          label: "Supply is fixed",
          tone: "neutral",
          detail:
            "The mint authority is revoked. The supply you see is the supply that exists.",
        },
  );

  for (const ext of stock.mint.extensions) {
    findings.push({
      label: ext,
      tone: "watch",
      detail:
        "A Token-2022 extension is active on this mint and can intercept transfers.",
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Supply cover
// ---------------------------------------------------------------------------

/**
 * Value of the circulating supply at the reference price, at
 * REGISTRY_PRICE_SCALE. This is the number that has to be backed by something.
 */
export function circulatingValue(stock: TokenizedStock): bigint {
  return (stock.mint.supply * stock.referencePrice) / REGISTRY_PRICE_SCALE;
}

/**
 * What fraction of the circulating value could actually leave through the DEX
 * pools today, in bps of the supply.
 *
 * The number that made PreStocks' break legible after the fact: the supply was
 * many times what the pools could absorb, and it was visible on-chain before
 * anything happened. Nobody was looking at the ratio because nobody published
 * it.
 */
export function exitCoverageBps(stock: TokenizedStock): number {
  const value = circulatingValue(stock);
  if (value <= 0n) return 0;
  const pooled = stock.pools.reduce((sum, p) => sum + p.quoteLiquidity, 0n);
  return Number((pooled * REGISTRY_BPS_SCALE) / value);
}
