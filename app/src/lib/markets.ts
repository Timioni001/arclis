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
  /**
   * `"24/7"` for a round-the-clock market on an xStock: priced from the listed
   * `underlying` while the US market is open and from the xStock's own Solana
   * market otherwise. Absent for a market that follows exchange hours.
   */
  schedule?: "24/7";
  underlying?: string;
  /** The xStock's mainnet mint, for a 24/7 market. */
  mint?: string;
}

export const MARKETS: MarketListing[] = data.markets as MarketListing[];

/** The listing of a 24/7 market, or undefined for an hours-bound one. */
export function roundTheClock(symbol: string): MarketListing | undefined {
  const m = MARKETS.find((x) => x.symbol === symbol);
  return m?.schedule === "24/7" ? m : undefined;
}

export const MARKET_NAMES: Record<string, string> = Object.fromEntries(
  MARKETS.map((m) => [m.symbol, m.name]),
);
