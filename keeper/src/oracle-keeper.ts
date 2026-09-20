/**
 * The oracle keeper: the only thing that writes a price or a session.
 *
 * # Order of operations, and why it is not the obvious one
 *
 * The session goes on-chain **before** the price when the venue is opening,
 * and **after** the price when it is closing. That asymmetry is deliberate and
 * it is the whole point of this file.
 *
 *   - **Opening.** Publish `Open` first. The last price is the previous
 *     close, which is stale by definition; setting the session first means the
 *     window between the two writes is one where nobody can increase risk
 *     against it, because `Open` applies the strict 60-second staleness
 *     budget. The other order would leave a moment where a fresh price sits
 *     under a `Closed` session and reducing risk uses a five-day budget it no
 *     longer needs.
 *   - **Closing.** Publish the final print first, then `Closed`. The closing
 *     price is the settlement price for the whole weekend, so it must be the
 *     one that is standing when the session flips. Flipping first would settle
 *     the weekend against the second-to-last trade.
 *
 * # What it refuses to do
 *
 * Publish a price it did not receive. A provider outage leaves the last good
 * price on-chain and logs; it never extrapolates, never repeats a stale quote
 * with a fresh timestamp, and never falls back to a second provider silently.
 * The staleness rules on-chain exist to catch exactly the situation where the
 * feed is down, and a keeper that papers over an outage disarms them.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BN, BorshCoder } from "@coral-xyz/anchor";
import idl from "../../idl/arclis.json";
import { sessionAt, isCovered, type MarketSession } from "./calendar";
import type { PriceFeed, Quote } from "./prices/types";
import { send, type ChainConfig } from "./chain";

const coder = new BorshCoder(idl as never);

function oraclePda(programId: PublicKey, symbol: string): PublicKey {
  const seed = new Uint8Array(16);
  seed.set(new TextEncoder().encode(symbol));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle"), Buffer.from(seed)],
    programId,
  )[0];
}

function ix(
  programId: PublicKey,
  name: string,
  args: Record<string, unknown>,
  keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys,
    data: coder.instruction.encode(name, args),
  });
}

/** Anchor encodes a fieldless enum as `{ open: {} }`. */
function sessionArg(session: MarketSession) {
  return { [session.charAt(0).toLowerCase() + session.slice(1)]: {} } as Record<
    string,
    Record<string, never>
  >;
}

export interface KeeperState {
  /** Last session published per symbol, so an unchanged one is not rewritten. */
  sessions: Map<string, MarketSession>;
  /** Last print timestamp published, so the same trade is not republished. */
  printedAt: Map<string, number>;
}

export function newKeeperState(): KeeperState {
  return { sessions: new Map(), printedAt: new Map() };
}

export interface KeeperOptions {
  config: ChainConfig;
  feed: PriceFeed;
  symbols: string[];
  state: KeeperState;
  /** Overridable for tests. */
  now?: () => number;
}

/**
 * One pass: read the clock, read the feed, write what changed.
 *
 * Returns a summary so a caller can assert on it. Writing nothing is a normal
 * and common outcome: outside market hours the session is already correct and
 * the feed has no new prints.
 */
export async function keeperTick(options: KeeperOptions): Promise<{
  published: string[];
  sessionsChanged: string[];
  skipped: string[];
}> {
  const { config, feed, symbols, state } = options;
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))();

  const published: string[] = [];
  const sessionsChanged: string[] = [];
  const skipped: string[] = [];

  if (!isCovered(now)) {
    // Past the calendar tables. Publishing Halted would be honest but would
    // also freeze every market indefinitely on a date nobody noticed rolling
    // past, so this stops and says so loudly instead.
    config.log(
      "error",
      "the trading calendar does not cover today; refusing to publish",
      {
        hint: "update HOLIDAYS/HALF_DAYS and KNOWN_THROUGH in keeper/src/calendar.ts",
      },
    );
    return { published, sessionsChanged, skipped: [...symbols] };
  }

  const clockSession = sessionAt(now);

  let quotes: Quote[] = [];
  try {
    quotes = await feed.quote(symbols);
  } catch (err) {
    // An outage leaves the chain alone. The on-chain staleness rules will stop
    // anyone trading against an old price by themselves, which is the whole
    // reason they exist.
    config.log("warn", "price feed unavailable; leaving prices as they are", {
      feed: feed.name,
      message: String((err as Error)?.message ?? err),
    });
    return { published, sessionsChanged, skipped: [...symbols] };
  }

  const bySymbol = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q]));

  for (const symbol of symbols) {
    const oracle = oraclePda(config.programId, symbol);
    const quote = bySymbol.get(symbol.toUpperCase());

    // A halt from the exchange outranks the clock. This is the one way
    // `Halted` ever reaches the chain, and it is data, not a timer.
    const target: MarketSession = quote?.halted ? "Halted" : clockSession;
    const opening = target === "Open" && state.sessions.get(symbol) !== "Open";

    const writeSession = async () => {
      if (state.sessions.get(symbol) === target) return;
      const outcome = await send(
        config,
        [
          ix(
            config.programId,
            "set_market_session",
            { session: sessionArg(target) },
            [
              {
                pubkey: config.payer.publicKey,
                isSigner: true,
                isWritable: false,
              },
              { pubkey: oracle, isSigner: false, isWritable: true },
            ],
          ),
        ],
        `set_market_session ${symbol} -> ${target}`,
      );
      if (outcome.ok) {
        state.sessions.set(symbol, target);
        sessionsChanged.push(`${symbol}:${target}`);
        config.log("info", `session ${symbol} -> ${target}`, {
          signature: outcome.signature,
        });
      }
    };

    // Opening: session first, so the stale close is never usable under a live
    // session's strict budget.
    if (opening) await writeSession();

    if (!quote) {
      skipped.push(symbol);
    } else if (state.printedAt.get(symbol) === quote.printedAt) {
      // The same trade. Republishing would reset the on-chain timestamp and
      // launder a stale print into a fresh one.
      skipped.push(symbol);
    } else {
      const outcome = await send(
        config,
        [
          ix(
            config.programId,
            "update_price_oracle",
            {
              price: new BN(quote.price.toString()),
              confidence: new BN(quote.confidence.toString()),
            },
            [
              {
                pubkey: config.payer.publicKey,
                isSigner: true,
                isWritable: false,
              },
              { pubkey: oracle, isSigner: false, isWritable: true },
            ],
          ),
        ],
        `update_price_oracle ${symbol}`,
      );

      if (outcome.ok) {
        state.printedAt.set(symbol, quote.printedAt);
        published.push(symbol);
      } else if (outcome.error === "OracleDeviationTooLarge") {
        // The program's own circuit breaker fired. This is the correct
        // outcome for a bad tick and the wrong one for a real gap, and only a
        // human can tell those apart, so it is loud.
        config.log(
          "error",
          `${symbol} moved more than the deviation cap allows`,
          {
            price: quote.price.toString(),
            hint: "verify against a second source before overriding",
          },
        );
        skipped.push(symbol);
      } else {
        skipped.push(symbol);
      }
    }

    // Closing (and every other transition): price first, session after, so the
    // final print is the one standing when the session flips.
    if (!opening) await writeSession();
  }

  return { published, sessionsChanged, skipped };
}
