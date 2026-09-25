/**
 * Fill the gaps in one feed from another, and say so.
 *
 * The keeper's rule is never to fall back to a second provider *silently*: a
 * blend of sources is a fact about every price on the chain, and whoever
 * reads the logs is owed it. So this names each symbol it filled, once per
 * change, and only asks the second feed for what the first could not price.
 */

import type { PriceFeed, Quote } from "./types";

export function withFallback(
  primary: PriceFeed,
  secondary: PriceFeed,
  log: (level: "info" | "warn", message: string, extra?: unknown) => void,
  /**
   * The most symbols to ask the secondary for in one pass, in listing order.
   * A rate-limited secondary asked for everything at once prices nothing; a
   * capped one keeps the first markets live while the primary is down.
   */
  maxPerPass = Infinity,
): PriceFeed {
  let lastFilled = "";
  return {
    name: `${primary.name}+${secondary.name}`,
    async quote(symbols) {
      let first: Quote[] = [];
      try {
        first = await primary.quote(symbols);
      } catch (e) {
        log("warn", `${primary.name} unavailable`, {
          message: String((e as Error)?.message ?? e).slice(0, 200),
        });
      }
      const have = new Set(first.map((q) => q.symbol.toUpperCase()));
      const gaps = symbols
        .filter((s) => !have.has(s.toUpperCase()))
        .slice(0, maxPerPass);
      if (gaps.length === 0) {
        lastFilled = "";
        return first;
      }
      const filled = await secondary.quote(gaps).catch(() => [] as Quote[]);
      const names = filled.map((q) => q.symbol).sort().join(",");
      if (names && names !== lastFilled) {
        log("warn", `priced from ${secondary.name} instead of ${primary.name}`, {
          symbols: names,
        });
      }
      lastFilled = names;
      return [...first, ...filled];
    },
  };
}
