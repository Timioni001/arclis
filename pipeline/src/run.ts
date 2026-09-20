#!/usr/bin/env node
/**
 * Build a registry snapshot and write it where the app can serve it.
 *
 *   npx ts-node pipeline/src/run.ts
 *
 * Writes `app/public/registry.json`. The interface fetches that at load and
 * falls back to the modelled dataset when it is absent, so a failed pipeline
 * run degrades to the labelled demo rather than to an empty page.
 *
 * Designed to be run on a schedule (a cron, a GitHub Action, a Cloudflare
 * scheduled worker) rather than per request. The data changes on the timescale
 * of minutes and every visitor triggering a fan-out of Jupiter quotes would be
 * both slow and a good way to get rate limited.
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble, type CuratedEntry } from "./assemble";
import { jupiterRouter } from "./depth";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CURATED = join(ROOT, "pipeline/curated.json");
const OUT = join(ROOT, "app/public/registry.json");

const env = process.env;
const RPC_URL = env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const QUOTE_MINT =
  env.QUOTE_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Read a mint account over plain JSON-RPC.
 *
 * `fetch` rather than `@solana/web3.js`: this needs one method, and the
 * pipeline is a short-lived script where a 300KB dependency for
 * `getAccountInfo` is not a good trade.
 */
async function getAccount(address: string) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64" }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`rpc ${response.status}`);

  const body = (await response.json()) as {
    result?: { value?: { data?: [string, string]; owner?: string } };
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? "rpc error");

  const value = body.result?.value;
  if (!value?.data) return null;

  return {
    data: Uint8Array.from(Buffer.from(value.data[0], "base64")),
    owner: value.owner ?? "",
  };
}

/**
 * Reference prices for the underlying stocks.
 *
 * Reuses the keeper's feed rather than adding a second provider integration:
 * the price a registry compares against and the price the perp marks against
 * must be the same price, or the two halves of the product disagree about what
 * AAPL is worth.
 */
async function referencePrices(symbols: string[]) {
  const { polygonFeed, finnhubFeed, simulatedFeed } =
    await import("../../keeper/src/prices/providers");
  const { sessionAt } = await import("../../keeper/src/calendar");

  const feed = env.POLYGON_API_KEY
    ? polygonFeed(env.POLYGON_API_KEY)
    : env.FINNHUB_API_KEY
      ? finnhubFeed(env.FINNHUB_API_KEY)
      : null;

  if (!feed) {
    throw new Error(
      "No equity price provider configured. Set POLYGON_API_KEY or FINNHUB_API_KEY. " +
        "The registry compares on-chain prices against the real stock, so there is " +
        "no meaningful snapshot without one.",
    );
  }
  void simulatedFeed;

  const now = Math.floor(Date.now() / 1000);
  const session = sessionAt(now);
  const quotes = await feed.quote(symbols);

  return new Map(
    quotes.map((q) => [
      q.symbol.toUpperCase(),
      {
        price: q.price,
        at: q.printedAt,
        session: q.halted ? "Halted" : session,
      },
    ]),
  );
}

async function main() {
  const entries = JSON.parse(readFileSync(CURATED, "utf8")) as {
    issuers: unknown[];
    tokens: CuratedEntry[];
  };

  const underlyings = [...new Set(entries.tokens.map((t) => t.underlying))];
  const prices = await referencePrices(underlyings);

  const snapshot = await assemble({
    entries: entries.tokens,
    getAccount,
    router: jupiterRouter(env.JUPITER_URL),
    quoteMint: QUOTE_MINT,
    referencePrices: prices,
    log: (level, message, extra) =>
      console[level === "warn" ? "warn" : "log"](
        `[pipeline] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`,
      ),
  });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ ...snapshot, issuers: entries.issuers }, null, 2),
  );

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
