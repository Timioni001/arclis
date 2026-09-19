/**
 * The market-session rules, mirroring `programs/arclis/src/math/session.rs`.
 *
 * This is the single most important thing for the UI to get right, and the one
 * a generic DeFi frontend gets wrong. A closed equity market is not "trading is
 * down": you can still reduce or close, you just cannot take on new risk
 * against a price that has been frozen since Friday.
 *
 * DESIGN.md §19 and §30: never surface a generic transaction error when the
 * frontend already knows the market state. Disable the action, and say why.
 */

import type { MarketSession, PriceUse } from "./types";

export interface SessionVerdict {
  allowed: boolean;
  /** Shown to the user verbatim when `allowed` is false. */
  reason: string;
  /** The on-chain error this would produce, for support and debugging. */
  errorCode?: string;
}

export function sessionAllows(session: MarketSession, use: PriceUse): SessionVerdict {
  switch (session) {
    case "Open":
      return { allowed: true, reason: "" };

    case "Closed":
      return use === "ReduceRisk"
        ? { allowed: true, reason: "" }
        : {
            allowed: false,
            reason:
              "The market is closed, so the price has not moved since the last session. " +
              "New positions would be a free bet on the next open. You can still reduce " +
              "or close what you already hold.",
            errorCode: "CannotIncreaseRiskWhileClosed",
          };

    case "PreOpen":
      return {
        allowed: false,
        reason:
          "The opening auction is running. Indications move fast and are not firm prices, " +
          "so nothing can be valued against them yet.",
        errorCode: "SessionNotOpen",
      };

    case "Halted":
      return {
        allowed: false,
        reason:
          "Trading is halted, so there is no price to mark against. Closing is unavailable " +
          "too — settling against the pre-halt print would be guesswork.",
        errorCode: "MarketHalted",
      };
  }
}

export const SESSION_LABEL: Record<MarketSession, string> = {
  Open: "OPEN",
  Closed: "CLOSED",
  PreOpen: "PRE-OPEN",
  Halted: "HALTED",
};

/** Does funding accrue right now? Only while the venue is open. */
export function fundingAccrues(session: MarketSession): boolean {
  return session === "Open";
}
