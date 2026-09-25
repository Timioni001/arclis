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

/**
 * Anchor encodes a fieldless enum as `{ Open: {} }` - the variant spelled
 * exactly as the IDL spells it.
 *
 * This used to lowercase the first letter, on the reasonable-sounding belief
 * that Anchor camelCases. `Program` does; a raw `BorshCoder` does not, and
 * this is a raw one. The layout then matches no variant and throws "unable to
 * infer src variant" from inside buffer-layout - a message that names neither
 * the instruction nor the enum - so every session write the keeper has ever
 * attempted failed, and the failure looked like a library problem.
 */
function sessionArg(session: MarketSession) {
  return { [session]: {} } as Record<string, Record<string, never>>;
}

/**
 * The largest price the program will accept in one update, moving toward
 * `target`.
 *
 * `check_deviation` rejects an update more than `MAX_ORACLE_DEVIATION_BPS`
 * (1000, ten percent) from the price already on-chain. That is a per-update
 * cap, not an absolute one, and the program says so itself: it "cannot stop a
 * determined attacker who walks the price over many updates, but it removes
 * the one-transaction drain".
 *
 * Which is what makes a walk the correct response to the one situation the
 * cap cannot distinguish from an attack: an oracle that has been off long
 * enough for the market to move past the cap. A seeded price of $228.50
 * against a real $338.98 is 48% away, and every single publish is rejected
 * forever. The feed is right, the chain is stale, and nothing gets better by
 * waiting.
 *
 * 950 bps rather than 1000, because the on-chain check floors its division
 * and a step computed to land exactly on the boundary can land a basis point
 * the wrong side of it.
 */
export const CATCHUP_STEP_BPS = 950n;
const BPS = 10_000n;

export function cappedStep(
  current: bigint,
  target: bigint,
  stepBps: bigint = CATCHUP_STEP_BPS,
): bigint {
  // A never-published oracle has no anchor to deviate from, and the program
  // waves it through.
  if (current === 0n) return target;

  const maxDelta = (current * stepBps) / BPS;
  const delta = target - current;
  if (delta <= maxDelta && -delta <= maxDelta) return target;

  // Integer division floors, so below about 11 units of price scale the step
  // rounds to nothing - and a step of nothing is not a slow walk, it is an
  // infinite one: publish, no movement, reject, publish again, paying a fee
  // every tick and never arriving. Real prices are millionths of a dollar and
  // never get near this, which is exactly why it would never have been found
  // in use. Hand back the target instead and let the program reject it once,
  // loudly, rather than looping in silence.
  if (maxDelta === 0n) return target;

  return delta > 0n ? current + maxDelta : current - maxDelta;
}

export interface KeeperState {
  /** Last session published per symbol, so an unchanged one is not rewritten. */
  sessions: Map<string, MarketSession>;
  /** Last print timestamp published, so the same trade is not republished. */
  printedAt: Map<string, number>;
  /** Previous session close per symbol, in dollars, as the feed reports it. */
  previousClose: Map<string, number>;
  /** Last time a 24/7 market had a usable quote, unix seconds. */
  lastQuoteAt: Map<string, number>;
}

export function newKeeperState(): KeeperState {
  return {
    sessions: new Map(),
    printedAt: new Map(),
    previousClose: new Map(),
    lastQuoteAt: new Map(),
  };
}

/**
 * How long a 24/7 market may go without a usable quote before the keeper
 * closes it. Shorter than the program's sixty-second staleness budget, so the
 * market is `Closed`, and exits work against the last price, before an open
 * session would start refusing everything as stale.
 */
export const NO_PRICE_GRACE_SECS = 45;

export interface KeeperOptions {
  config: ChainConfig;
  feed: PriceFeed;
  symbols: string[];
  state: KeeperState;
  /**
   * Walk the price toward the feed in capped steps when the program rejects
   * an update as too large a jump. Off by default: the same rejection means
   * "the feed is lying" and "the chain is behind", and only a person knows
   * which. See `cappedStep`.
   */
  catchUp?: boolean;
  /**
   * 24/7 markets: open whenever they can be priced, whatever the exchange
   * calendar says. See `round-the-clock.ts`.
   */
  alwaysOpen?: Set<string>;
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
  /** The price each published symbol now carries, for the history store. */
  prints: { symbol: string; price: bigint }[];
  sessionsChanged: string[];
  skipped: string[];
}> {
  const { config, feed, symbols, state } = options;
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))();

  const published: string[] = [];
  const prints: { symbol: string; price: bigint }[] = [];
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
    return { published, prints, sessionsChanged, skipped: [...symbols] };
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
    return { published, prints, sessionsChanged, skipped: [...symbols] };
  }

  const bySymbol = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q]));
  for (const q of quotes) {
    if (q.previousClose) {
      state.previousClose.set(q.symbol.toUpperCase(), q.previousClose);
    }
  }

  for (const symbol of symbols) {
    const oracle = oraclePda(config.programId, symbol);
    const quote = bySymbol.get(symbol.toUpperCase());

    const roundTheClock = options.alwaysOpen?.has(symbol.toUpperCase()) ?? false;

    // A halt from the exchange outranks the clock. This is the one way
    // `Halted` ever reaches the chain, and it is data, not a timer.
    //
    // A 24/7 market is open while its price on chain is fresh and closed once
    // nothing has landed for the grace period, whether the quote was missing
    // or the program refused it. A single missed tick changes nothing.
    const roundTheClockTarget = (): MarketSession =>
      now - (state.lastQuoteAt.get(symbol) ?? 0) <= NO_PRICE_GRACE_SECS
        ? "Open"
        : "Closed";
    let target: MarketSession = quote?.halted
      ? "Halted"
      : roundTheClock
        ? roundTheClockTarget()
        : clockSession;
    // A 24/7 market reopens on a fresh price, so it publishes the price
    // first: the program refuses to open against a mark older than sixty
    // seconds, and its last mark is from before the gap.
    const opening =
      !roundTheClock && target === "Open" && state.sessions.get(symbol) !== "Open";

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
        state.lastQuoteAt.set(symbol, now);
        published.push(symbol);
        prints.push({ symbol, price: quote.price });
      } else if (outcome.error === "OracleDeviationTooLarge") {
        // The program's own circuit breaker fired. This is the correct
        // outcome for a bad tick and the wrong one for an oracle that has
        // simply been off while the market moved, and only a human can tell
        // those apart - so catching up is opt-in, and loud either way.
        if (!options.catchUp) {
          config.log(
            "error",
            `${symbol} moved more than the deviation cap allows`,
            {
              price: quote.price.toString(),
              hint: "verify against a second source, then set ORACLE_CATCHUP=yes to walk it in steps",
            },
          );
          skipped.push(symbol);
        } else {
          // Read the price actually on-chain - the step has to be measured
          // from it, and this is the only path that needs it, so the normal
          // case pays nothing for the extra call.
          const info = await config.connection.getAccountInfo(oracle);
          if (!info) {
            skipped.push(symbol);
          } else {
            const current = BigInt(
              (
                coder.accounts.decode("PriceOracle", info.data) as {
                  price: { toString(): string };
                }
              ).price.toString(),
            );
            const step = cappedStep(current, quote.price);
            const stepped = await send(
              config,
              [
                ix(
                  config.programId,
                  "update_price_oracle",
                  {
                    price: new BN(step.toString()),
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
              `update_price_oracle ${symbol} (catching up)`,
            );
            config.log("warn", `${symbol} catching up in capped steps`, {
              from: current.toString(),
              to: step.toString(),
              target: quote.price.toString(),
              arrived: step === quote.price,
              ok: stepped.ok,
            });
            // Deliberately not recording `printedAt`: this is not the print,
            // it is a step toward it. Recording it would make the next tick
            // treat the real price as already published and stop the walk one
            // step short, forever.
            if (stepped.ok && step === quote.price) {
              state.printedAt.set(symbol, quote.printedAt);
              state.lastQuoteAt.set(symbol, now);
              published.push(symbol);
              prints.push({ symbol, price: quote.price });
            } else {
              skipped.push(symbol);
            }
          }
        }
      } else {
        skipped.push(symbol);
      }
    }

    // Closing (and every other transition): price first, session after, so the
    // final print is the one standing when the session flips.
    if (roundTheClock && !quote?.halted) target = roundTheClockTarget();
    if (!opening) await writeSession();
  }

  return { published, prints, sessionsChanged, skipped };
}
