/**
 * The markets Arclis lists, as data.
 *
 * Kept in JSON rather than TypeScript so `scripts/seed-local.ts` can read the
 * same file with no build step: the list of markets the interface shows and
 * the list the seed script creates on chain are one list.
 */
import data from "./markets.json";

export interface MarketListing {
  symbol: string;
  name: string;
  /** Seeding fallback only. The keeper owns the live price. */
  indicativePrice: number;
  /** Annualised volatility, used only by the modelled data source. */
  vol: number;
}

export const MARKETS: MarketListing[] = data.markets;

export const MARKET_NAMES: Record<string, string> = Object.fromEntries(
  MARKETS.map((m) => [m.symbol, m.name]),
);
