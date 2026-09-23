/**
 * ClawPump's tokenized-stock launch pairs, as the interface uses them.
 *
 * A snapshot rather than a live call, deliberately: reading `/pump-pairs` needs
 * a `cpk_` key, and a key in the browser bundle is a key every visitor has.
 * `npm run clawpump -- snapshot` refreshes the file from the operator's machine.
 */
import data from "./stock-pairs.json";
import { MARKETS } from "../markets";

export interface StockPair {
  symbol: string;
  mint: string;
  name: string;
  kind: "equity" | "etf";
}

export const STOCK_PAIRS = data.pairs as StockPair[];
export const PAIRS_SNAPSHOT: string = data.snapshot;
export const CREATOR_FEE_BPS = data.creatorFeeBps;

const LISTED = new Set(MARKETS.map((m) => m.symbol));

/**
 * Whether Arclis runs a perp on this stock, which is what lets an agent
 * launched against it hedge its treasury here.
 */
export function hedgeable(pair: StockPair): boolean {
  return LISTED.has(pair.symbol);
}

/** Mainnet explorer link. The pairs are mainnet mints, whatever cluster Arclis reads. */
export function mintUrl(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}
