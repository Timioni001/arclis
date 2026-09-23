/**
 * The price feed seam.
 *
 * One interface, several providers, and a simulated one for a local validator.
 * Which provider is in use is a configuration decision, not a code change, and
 * the keeper never learns which it is talking to.
 *
 * Two things every implementation must get right:
 *
 *  1. **A halt is data, not an absence.** A provider that returns nothing for a
 *     halted symbol is indistinguishable from a provider that is down, and the
 *     two need opposite responses: a halt must be published on-chain, an
 *     outage must not. So `Quote.halted` is an explicit field and a missing
 *     quote is always treated as an outage.
 *  2. **The timestamp is the provider's, not ours.** The staleness rules
 *     on-chain are about how old the *print* is. Stamping a quote with the
 *     moment it was fetched would launder a ten-minute-old price into a fresh
 *     one, which is exactly the check those rules exist to make.
 */

export interface Quote {
  symbol: string;
  /** Price at PRICE_SCALE (1e6). */
  price: bigint;
  /** Half-width of the confidence interval, at PRICE_SCALE. Zero if unknown. */
  confidence: bigint;
  /** When the venue printed it, unix seconds. Never the fetch time. */
  printedAt: number;
  /** The exchange has halted this symbol. Distinct from "no data". */
  halted: boolean;
  /**
   * The previous session's official close, in dollars, when the provider
   * reports one. The basis for a day's percentage change.
   */
  previousClose?: number;
}

export interface PriceFeed {
  readonly name: string;
  /**
   * Quote several symbols at once.
   *
   * Returns only what it could price. A symbol missing from the result is an
   * outage for that symbol, and the keeper leaves the last on-chain price
   * alone rather than publishing something it does not have.
   */
  quote(symbols: string[]): Promise<Quote[]>;
}

/** Convert a decimal price to the protocol's 1e6 fixed point, rounding half up. */
export function toFixed(price: number): bigint {
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`Not a usable price: ${price}`);
  }
  return BigInt(Math.round(price * 1_000_000));
}

/** Percentage of price, as an absolute confidence at 1e6. */
export function confidenceFromPct(price: number, pct: number): bigint {
  return toFixed((price * pct) / 100);
}
