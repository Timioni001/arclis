#!/usr/bin/env ts-node
/**
 * Watch a live stock-quoted DBC pool.
 *
 * Reports the three numbers a stock-quoted pool needs and a normal launchpad
 * dashboard does not have: progress in shares, progress in dollars, and how far
 * the dollar graduation target has drifted from what the issuer signed up for.
 *
 *   yarn dbc:monitor --pool <address> --symbol AAPL --price 250 \
 *                    --original-target 50000 --session open
 */
import { Connection, PublicKey } from "@solana/web3.js";

import { MarketSession, StockQuote, assessPool } from "../src/dbc";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

async function main(): Promise<void> {
  const rpc = arg(
    "rpc",
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  );
  const connection = new Connection(rpc, "confirmed");
  const now = Math.floor(Date.now() / 1000);

  const stock: StockQuote = {
    symbol: arg("symbol"),
    mint: arg("mint", "<quote-mint-not-set>"),
    decimals: Number(arg("decimals", "8")),
    priceUsd: Number(arg("price")),
    annualVolatility: Number(arg("vol", "0.28")),
    session: (arg("session", "open").charAt(0).toUpperCase() +
      arg("session", "open").slice(1).toLowerCase()) as MarketSession,
    nextOpenUnix: Number(arg("next-open", String(now + 18 * 3600))),
    nextCloseUnix: Number(arg("next-close", String(now + 6 * 3600))),
  };

  const originalTargetRaw = arg("original-target", "");
  const health = await assessPool(
    connection,
    new PublicKey(arg("pool")),
    stock,
    originalTargetRaw ? Number(originalTargetRaw) : undefined,
  );

  const filled = Math.round(health.progress * 40);
  const bar = "#".repeat(filled) + "-".repeat(40 - filled);

  console.log(`\n=== ${health.pool} ===\n`);
  console.log(`[${bar}] ${(health.progress * 100).toFixed(1)}%\n`);
  console.log(
    `raised             ${health.raisedQuoteTokens.toFixed(4)} ${stock.symbol}  ` +
      `(${usd(health.raisedUsd)})`,
  );
  console.log(
    `remaining          ${health.remainingQuoteTokens.toFixed(4)} ${stock.symbol}`,
  );
  console.log(`target today       ${usd(health.currentTargetUsd)}`);

  if (health.originalTargetUsd !== undefined) {
    const d = health.targetDriftPct ?? 0;
    console.log(
      `target at launch   ${usd(health.originalTargetUsd)}  ` +
        `(${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}% drift)`,
    );
  }

  console.log(`\nvenue              ${health.session}`);
  console.log(
    `quote price        ${health.quotePriceStale ? "STALE - venue shut" : "live"}\n`,
  );

  if (health.warnings.length) {
    for (const w of health.warnings) console.log(`  !  ${w}\n`);
  } else {
    console.log("  no warnings.\n");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
