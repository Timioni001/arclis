#!/usr/bin/env node
/**
 * The daemon entrypoint.
 *
 * Runs the oracle keeper, the funding crank, the liquidator and the corporate
 * action watcher in one process on independent intervals. One process because
 * they share a connection and a keypair and there is no reason to pay for four
 * of each; independent intervals because their cadences differ by two orders
 * of magnitude.
 *
 *   npx ts-node keeper/src/run.ts
 *
 * Configuration is environment only, and every secret has a safe default of
 * "off". A missing price provider falls back to the simulated feed **and says
 * so**, because a simulated feed pointed at a real deployment would publish
 * invented prices to a live market, and that must never happen by accident.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  consoleLogger,
  loadKeypair,
  loop,
  PROGRAM_ID,
  type ChainConfig,
} from "./chain";
import { keeperTick, newKeeperState } from "./oracle-keeper";
import { crankFunding, liquidatePass } from "./cranks";
import {
  corporateTick,
  ephemeralAppliedLog,
  polygonActions,
  type CorporateActionFeed,
} from "./corporate";
import {
  alpacaFeed,
  finnhubFeed,
  polygonFeed,
  simulatedFeed,
} from "./prices/providers";
import type { PriceFeed } from "./prices/types";
import { isCovered, KNOWN_THROUGH } from "./calendar";
import { newHealth, startHealthServer } from "./health";

const env = process.env;

const RPC_URL = env.RPC_URL ?? "http://127.0.0.1:8899";
const SYMBOLS = (env.MARKETS ?? "AAPL,NVDA,MSFT,TSLA,GOOGL")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/** Seed prices for the simulated feed, so a local run has plausible levels. */
const SIMULATED_SEEDS: Record<string, number> = {
  AAPL: 254.2,
  NVDA: 182.9,
  MSFT: 511.6,
  TSLA: 438,
  GOOGL: 247.1,
};

function pickFeed(log: ChainConfig["log"]): PriceFeed {
  if (env.POLYGON_API_KEY) return polygonFeed(env.POLYGON_API_KEY);
  if (env.FINNHUB_API_KEY) return finnhubFeed(env.FINNHUB_API_KEY);
  if (env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY) {
    return alpacaFeed(env.ALPACA_KEY_ID, env.ALPACA_SECRET_KEY);
  }

  const local = /127\.0\.0\.1|localhost/.test(RPC_URL);
  if (!local && env.ALLOW_SIMULATED_FEED !== "yes") {
    // Refusing is the point. A simulated feed against a real cluster publishes
    // invented prices that traders then lose money against.
    throw new Error(
      "No price provider configured and the RPC is not local. Set POLYGON_API_KEY, " +
        "FINNHUB_API_KEY, or ALPACA_KEY_ID/ALPACA_SECRET_KEY. To publish simulated " +
        "prices to a non-local cluster anyway, set ALLOW_SIMULATED_FEED=yes.",
    );
  }

  log("warn", "no price provider configured; publishing SIMULATED prices", {
    rpc: RPC_URL,
    hint: "these are a random walk, not market data",
  });
  return simulatedFeed(SIMULATED_SEEDS, { seed: Number(env.SIM_SEED ?? 42) });
}

function pickCorporateFeed(): CorporateActionFeed | null {
  return env.POLYGON_API_KEY ? polygonActions(env.POLYGON_API_KEY) : null;
}

async function main() {
  const log = consoleLogger("keeper");

  if (!env.KEEPER_KEYPAIR) {
    throw new Error(
      "KEEPER_KEYPAIR is required: a path to a Solana keypair JSON, a JSON array, or base64.",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (!isCovered(now)) {
    throw new Error(
      `The trading calendar only runs through ${KNOWN_THROUGH}. Update ` +
        "keeper/src/calendar.ts before running past it.",
    );
  }

  const config: ChainConfig = {
    connection: new Connection(RPC_URL, "confirmed"),
    payer: loadKeypair(env.KEEPER_KEYPAIR),
    programId: env.PROGRAM_ID ? new PublicKey(env.PROGRAM_ID) : PROGRAM_ID,
    log,
  };

  log("info", "starting", {
    rpc: RPC_URL,
    programId: config.programId.toBase58(),
    keeper: config.payer.publicKey.toBase58(),
    symbols: SYMBOLS,
  });

  const feed = pickFeed(log);
  const state = newKeeperState();
  const abort = new AbortController();

  /*
   * The health surface, off unless HEALTH_PORT is set.
   *
   * Off by default because a local run does not need a listening socket, and
   * on in a container because "the process exists" is not the same as "the
   * keeper is publishing" - a wedged RPC call leaves a process that is alive,
   * idle and useless, and a host cannot tell the difference without being
   * told.
   */
  const health = newHealth({
    rpc: RPC_URL,
    programId: config.programId.toBase58(),
    keeper: config.payer.publicKey.toBase58(),
    symbols: SYMBOLS,
    feed: feed.name,
  });
  const healthPort = Number(env.HEALTH_PORT ?? 0);
  if (healthPort > 0) {
    startHealthServer(health, healthPort, abort.signal, log);
  }

  const PRICE_INTERVAL_MS = Number(env.PRICE_INTERVAL_MS ?? 10_000);
  const FUNDING_INTERVAL_MS = Number(env.FUNDING_INTERVAL_MS ?? 60_000);
  const LIQUIDATOR_INTERVAL_MS = Number(env.LIQUIDATOR_INTERVAL_MS ?? 5_000);
  const CORPORATE_INTERVAL_MS = Number(env.CORPORATE_INTERVAL_MS ?? 3_600_000);
  health.register("oracle", PRICE_INTERVAL_MS);
  health.register("funding", FUNDING_INTERVAL_MS);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log("info", `${signal} received, draining`);
      abort.abort();
      // A hard exit after a grace period, so a hung RPC call cannot keep the
      // process alive after somebody asked it to stop.
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }

  const tasks: Promise<void>[] = [];

  // Prices and sessions. Ten seconds is well inside the 60-second staleness
  // budget an open market applies, with room for a missed round trip.
  tasks.push(
    loop(
      config,
      "oracle",
      PRICE_INTERVAL_MS,
      async () => {
        const result = await keeperTick({
          config,
          feed,
          symbols: SYMBOLS,
          state,
          // Opt-in, because the rejection it responds to is ambiguous. See
          // `cappedStep` in oracle-keeper.ts.
          catchUp: env.ORACLE_CATCHUP === "yes",
        });
        health.published(result.published);
        if (result.published.length || result.sessionsChanged.length) {
          log("info", "published", {
            prices: result.published,
            sessions: result.sessionsChanged,
          });
        }
      },
      abort.signal,
      health.reporter("oracle"),
    ),
  );

  // Funding. The program enforces the interval, so this only has to call often
  // enough not to be the reason funding is late.
  tasks.push(
    loop(
      config,
      "funding",
      FUNDING_INTERVAL_MS,
      async () => {
        await crankFunding(config, SYMBOLS);
      },
      abort.signal,
      health.reporter("funding"),
    ),
  );

  // Liquidation. The tightest loop of the four: every second a position stays
  // underwater is a second the pool is carrying a loss it has not been paid
  // for.
  if (env.QUOTE_MINT) {
    const quoteMint = new PublicKey(env.QUOTE_MINT);
    tasks.push(
      loop(
        config,
        "liquidator",
        LIQUIDATOR_INTERVAL_MS,
        async () => {
          const result = await liquidatePass({
            config,
            symbols: SYMBOLS,
            quoteMint,
          });
          if (result.liquidated.length) {
            log("info", "liquidated", { count: result.liquidated.length });
          }
        },
        abort.signal,
      ),
    );
  } else {
    log("warn", "QUOTE_MINT unset; the liquidator is not running", {
      consequence: "underwater positions will become bad debt",
    });
  }

  // Corporate actions. Hourly is plenty: the window is the whole overnight,
  // and the ex-date is known days ahead.
  const corporate = pickCorporateFeed();
  if (corporate) {
    const applied = ephemeralAppliedLog();
    log("warn", "the applied-actions log is in memory only", {
      consequence:
        "a restart could re-apply a split; back it with durable storage",
    });
    tasks.push(
      loop(
        config,
        "corporate",
        CORPORATE_INTERVAL_MS,
        async () => {
          await corporateTick({
            config,
            feed: corporate,
            symbols: SYMBOLS,
            applied,
          });
        },
        abort.signal,
      ),
    );
  }

  await Promise.all(tasks);
}

main().catch((err) => {
  console.error(
    `${new Date().toISOString()} [keeper] FATAL ${String(err?.message ?? err)}`,
  );
  process.exit(1);
});
