#!/usr/bin/env node
/**
 * Build a registry snapshot and write it where the app can serve it.
 *
 *   npx ts-node pipeline/src/run.ts
 *
 * Writes `app/public/registry.json`, a static copy of what the keeper serves
 * live at `/registry`. The interface reads the keeper first, then this file,
 * and falls back to its labelled sample dataset when neither is available.
 *
 * Useful for a one-off check of the curated list (a new token, a moved mint)
 * before it reaches the keeper. Never run per request: the data changes on the
 * timescale of minutes, and a fan-out of Jupiter quotes per visitor would be
 * slow and rate limited.
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry, type CuratedFile } from "./build";
import { jupiterRouter } from "./depth";
import { accountReader } from "./rpc";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CURATED = join(ROOT, "pipeline/curated.json");
const OUT = join(ROOT, "app/public/registry.json");

const env = process.env;
const RPC_URL = env.REGISTRY_RPC_URL ?? env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const QUOTE_MINT =
  env.QUOTE_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Reference prices for the underlying stocks.
 *
 * Reuses the keeper's providers rather than adding a second integration: the
 * price a registry compares against and the price the perp marks against
 * must be the same price, or the two halves of the product disagree about
 * what AAPL is worth.
 */
async function referencePrices(symbols: string[]) {
  const { alpacaFeed, polygonFeed, finnhubFeed } =
    await import("../../keeper/src/prices/providers");
  const { sessionAt } = await import("../../keeper/src/calendar");

  const feed =
    env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY
      ? alpacaFeed(env.ALPACA_KEY_ID, env.ALPACA_SECRET_KEY, env.ALPACA_DATA_FEED === "sip" ? "sip" : "iex")
      : env.POLYGON_API_KEY
        ? polygonFeed(env.POLYGON_API_KEY)
        : env.FINNHUB_API_KEY
          ? finnhubFeed(env.FINNHUB_API_KEY)
          : null;

  if (!feed) {
    throw new Error(
      "No equity price provider configured. Set ALPACA_KEY_ID and ALPACA_SECRET_KEY, " +
        "POLYGON_API_KEY or FINNHUB_API_KEY. The registry compares on-chain prices " +
        "against the real stock, so there is no meaningful snapshot without one.",
    );
  }

  const session = sessionAt(Math.floor(Date.now() / 1000));
  const quotes = await feed.quote(symbols);
  return new Map(
    quotes.map((q) => [
      q.symbol.toUpperCase(),
      { price: q.price, at: q.printedAt, session: q.halted ? "Halted" : session },
    ]),
  );
}

async function main() {
  const curated = JSON.parse(readFileSync(CURATED, "utf8")) as CuratedFile;

  const snapshot = await buildRegistry({
    curated,
    getAccount: accountReader(RPC_URL),
    router: jupiterRouter({ apiKey: env.JUPITER_API_KEY, spacingMs: 1_100 }),
    quoteMint: QUOTE_MINT,
    referencePrices,
    log: (level, message, extra) =>
      console[level === "warn" ? "warn" : "log"](
        `[pipeline] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`,
      ),
  });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2));

  console.log(
    `[pipeline] wrote ${snapshot.tokens.length} tokens (${snapshot.kind})` +
      (snapshot.failures.length ? `, ${snapshot.failures.length} failed` : ""),
  );
  for (const failure of snapshot.failures) {
    console.warn(`[pipeline]   ${failure.symbol}: ${failure.reason}`);
  }

  // A run that produced nothing is a failed run, and CI should see that.
  if (snapshot.tokens.length === 0) process.exit(1);
}

main().catch((err) => {
  console.error(`[pipeline] FATAL ${String(err?.message ?? err)}`);
  process.exit(1);
});
