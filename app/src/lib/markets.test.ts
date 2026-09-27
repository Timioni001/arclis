/**
 * One market list, four places: `markets.json` (interface and seed script),
 * `.env.production` (the deployed interface), `fly.toml` (the keeper) and the
 * program's 16-byte symbol seed. A market in one list and not another is a
 * market that renders with no price, or one nobody can see.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { MARKETS, MARKET_NAMES, roundTheClock } from "./markets";

const root = resolve(__dirname, "../../..");
const symbols = MARKETS.map((m) => m.symbol);

function listFrom(file: string, pattern: RegExp): string[] {
  const match = readFileSync(resolve(root, file), "utf8").match(pattern);
  if (!match) throw new Error(`no market list in ${file}`);
  return match[1].split(",").map((s) => s.trim());
}

describe("the market list", () => {
  it("has no duplicates and fits the program's 16-byte symbol seed", () => {
    expect(new Set(symbols).size).toBe(symbols.length);
    for (const s of symbols) expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(16);
  });

  it("is the list the deployed interface and the keeper both run", () => {
    expect(listFrom("app/.env.production", /^VITE_MARKETS=(.+)$/m)).toEqual(symbols);
    expect(listFrom("fly.toml", /^\s*MARKETS\s*=\s*"([^"]+)"/m)).toEqual(symbols);
  });

  it("gives every 24/7 market an underlying ticker and a real mint", () => {
    const twins = MARKETS.filter((m) => m.schedule === "24/7");
    expect(twins.length).toBeGreaterThanOrEqual(20);
    for (const m of twins) {
      expect(m.symbol).toBe(`${m.underlying}x`);
      // The underlying need not be listed itself (DFDV is not): the keeper
      // asks its stock feed for it directly while the US market is open.
      expect(m.underlying).toMatch(/^[A-Z.]{1,6}$/);
      expect(() => new PublicKey(m.mint!)).not.toThrow();
      expect(roundTheClock(m.symbol)).toBe(m);
    }
  });

  it("treats hours-bound markets as hours-bound", () => {
    expect(roundTheClock("AAPL")).toBeUndefined();
    expect(roundTheClock("NOPE")).toBeUndefined();
  });

  it("names every market and prices every seed", () => {
    for (const m of MARKETS) {
      expect(MARKET_NAMES[m.symbol]).toBe(m.name);
      expect(m.indicativePrice).toBeGreaterThan(0);
    }
  });
});
