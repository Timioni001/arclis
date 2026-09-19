#!/usr/bin/env ts-node
/**
 * Print a reviewable launch plan for a stock-quoted DBC pool, and build the
 * Meteora config it implies.
 *
 * Read-only: it signs nothing and sends nothing. The point is that an issuer
 * sees the share-denominated thresholds, the drift band, and the fee rationale
 * *before* a config exists on chain.
 *
 *   yarn dbc:plan --symbol AAPL --price 250 --vol 0.28 \
 *                 --initial-fdv 5000 --migration-fdv 50000 --session closed
 */
import { PublicKey } from "@solana/web3.js";

import {
  MarketSession,
  StockQuote,
  LaunchTargets,
  planStockLaunch,
  buildAndValidate,
} from "../src/dbc";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function parseSession(s: string): MarketSession {
  const key = s.toLowerCase();
  if (key === "open") return MarketSession.Open;
  if (key === "closed") return MarketSession.Closed;
  if (key === "preopen" || key === "pre-open") return MarketSession.PreOpen;
  if (key === "halted") return MarketSession.Halted;
  throw new Error(`unknown session "${s}" (open|closed|preopen|halted)`);
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function main(): void {
  const now = Math.floor(Date.now() / 1000);
  const session = parseSession(arg("session", "open"));

  const stock: StockQuote = {
    symbol: arg("symbol"),
    mint: arg("mint", "<quote-mint-not-set>"),
    decimals: Number(arg("decimals", "8")),
    priceUsd: Number(arg("price")),
    annualVolatility: Number(arg("vol", "0.28")),
    session,
    nextOpenUnix: Number(arg("next-open", String(now + 18 * 3600))),
    nextCloseUnix: Number(arg("next-close", String(now + 6 * 3600))),
  };

  const targets: LaunchTargets = {
    initialMarketCapUsd: Number(arg("initial-fdv")),
    migrationMarketCapUsd: Number(arg("migration-fdv")),
    totalTokenSupply: Number(arg("supply", "1000000000")),
    tokenDecimals: Number(arg("token-decimals", "6")) as 6 | 7 | 8 | 9,
  };

  const fillDays = Number(arg("fill-days", "30"));
  const plan = planStockLaunch(stock, targets, now, {}, fillDays);

  console.log(`\n=== ${stock.symbol}-quoted launch plan ===\n`);
  console.log(`quote token        ${stock.symbol} @ ${usd(stock.priceUsd)}`);
  console.log(`venue session      ${stock.session}`);
  console.log(
    `annual vol         ${(stock.annualVolatility * 100).toFixed(1)}%\n`,
  );

  console.log(`--- thresholds (DBC stores these in shares, not dollars) ---`);
  console.log(
    `initial FDV        ${usd(targets.initialMarketCapUsd).padEnd(12)} = ` +
      `${plan.initialMarketCapQuote.toFixed(6)} ${stock.symbol}`,
  );
  console.log(
    `migration FDV      ${usd(targets.migrationMarketCapUsd).padEnd(12)} = ` +
      `${plan.migrationMarketCapQuote.toFixed(6)} ${stock.symbol}\n`,
  );

  console.log(`--- graduation drift over ${fillDays}d ---`);
  console.log(
    `target band        ${usd(plan.drift.lowUsd)} … ${usd(plan.drift.highUsd)} ` +
      `(±${(plan.drift.bandWidthPct * 50).toFixed(1)}%)`,
  );
  console.log(
    `                   the threshold is fixed in shares, so this band is what\n` +
      `                   your dollar goal actually is once the stock moves.\n`,
  );

  console.log(`--- fees ---`);
  console.log(
    `schedule           ${plan.fees.startingFeeBps}bps → ${plan.fees.endingFeeBps}bps ` +
      `over ${(plan.fees.totalDuration / 3600).toFixed(1)}h ` +
      `(${plan.fees.numberOfPeriod} periods)`,
  );
  console.log(
    `dynamic fee        triggers at ${plan.dynamicFeeMaxPriceChangeBps}bps`,
  );
  console.log(`rationale          ${plan.fees.rationale}\n`);

  console.log(`--- activation ---`);
  console.log(
    `${plan.activation.safe ? "OK  " : "WAIT"}  ${plan.activation.reason}\n`,
  );

  if (plan.warnings.length) {
    console.log(`--- warnings ---`);
    for (const w of plan.warnings) console.log(`  !  ${w}\n`);
  }

  const receiverArg = arg("leftover-receiver", "");
  const { valid, error, usedPlaceholderReceiver } = buildAndValidate(
    plan,
    {},
    receiverArg ? new PublicKey(receiverArg) : undefined,
  );
  console.log(`--- Meteora config ---`);
  console.log(
    valid
      ? "built and validated against the SDK's own validateConfigParameters."
      : `built, but the SDK rejected it: ${error}`,
  );
  if (usedPlaceholderReceiver) {
    console.log(
      "note               no --leftover-receiver given, so the supply check ran\n" +
        "                   against a placeholder. Set a real address before creating\n" +
        "                   the config or unsold base tokens have nowhere to go.",
    );
  }
  console.log(
    `\nNothing was signed or sent. Feed the config to ` +
      `client.partner.createConfig() when you are happy with the numbers above.\n`,
  );
}

main();
