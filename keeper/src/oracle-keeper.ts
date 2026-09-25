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

/**
 * Price updates per transaction. Eight fit comfortably in a transaction's
 * size and compute limits, and cut the keeper's request rate by eight.
 */
export const PRICE_BATCH = 8;

/**
 * Just under the program's 1000 bps per-update cap: its check floors, so a
 * move computed at exactly the cap can land a basis point over it.
 */
const SAFE_DEVIATION_BPS = 990n;

function deviationBps(from: bigint, to: bigint): bigint {
  const delta = to > from ? to - from : from - to;
  return (delta * BPS) / from;
}

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
  /** Price updates per transaction. Default `PRICE_BATCH`. */
  batchSize?: number;
  /**
   * The prices on chain now, one per oracle, null where unknown. Default: one
   * `getMultipleAccountsInfo` for every oracle. Overridable for tests.
   */
  readPrices?: (oracles: PublicKey[]) => Promise<(bigint | null)[]>;
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

  const readPrices =
    options.readPrices ??
    (async (oracles: PublicKey[]) => {
      const infos = await config.connection.getMultipleAccountsInfo(oracles);
      return infos.map((info) => {
        if (!info) return null;
        try {
          return BigInt(
            (
              coder.accounts.decode("PriceOracle", info.data) as {
                price: { toString(): string };
              }
            ).price.toString(),
          );
        } catch {
          return null;
        }
      });
    });

  const signer = {
    pubkey: config.payer.publicKey,
    isSigner: true,
    isWritable: false,
  };
  const priceIx = (oracle: PublicKey, price: bigint, confidence: bigint) =>
    ix(
      config.programId,
      "update_price_oracle",
      {
        price: new BN(price.toString()),
        confidence: new BN(confidence.toString()),
      },
      [signer, { pubkey: oracle, isSigner: false, isWritable: true }],
    );

  interface Plan {
    symbol: string;
    oracle: PublicKey;
    quote: Quote | undefined;
    roundTheClock: boolean;
    target: MarketSession;
    opening: boolean;
  }

  // A 24/7 market is open while its price on chain is fresh and closed once
  // nothing has landed for the grace period, whether the quote was missing
  // or the program refused it. A single missed tick changes nothing.
  const roundTheClockTarget = (symbol: string): MarketSession =>
    now - (state.lastQuoteAt.get(symbol) ?? 0) <= NO_PRICE_GRACE_SECS
      ? "Open"
      : "Closed";

  const plans: Plan[] = symbols.map((symbol) => {
    const quote = bySymbol.get(symbol.toUpperCase());
    const roundTheClock = options.alwaysOpen?.has(symbol.toUpperCase()) ?? false;
    // A halt from the exchange outranks the clock. This is the one way
    // `Halted` ever reaches the chain, and it is data, not a timer.
    const target: MarketSession = quote?.halted
      ? "Halted"
      : roundTheClock
        ? roundTheClockTarget(symbol)
        : clockSession;
    return {
      symbol,
      oracle: oraclePda(config.programId, symbol),
      quote,
      roundTheClock,
      target,
      // A 24/7 market reopens on a fresh price, so it publishes the price
      // first: the program refuses to open against a mark older than sixty
      // seconds, and its last mark is from before the gap.
      opening:
        !roundTheClock &&
        target === "Open" &&
        state.sessions.get(symbol) !== "Open",
    };
  });

  const writeSession = async (p: Plan) => {
    if (state.sessions.get(p.symbol) === p.target) return;
    const outcome = await send(
      config,
      [
        ix(
          config.programId,
          "set_market_session",
          { session: sessionArg(p.target) },
          [signer, { pubkey: p.oracle, isSigner: false, isWritable: true }],
        ),
      ],
      `set_market_session ${p.symbol} -> ${p.target}`,
    );
    if (outcome.ok) {
      state.sessions.set(p.symbol, p.target);
      sessionsChanged.push(`${p.symbol}:${p.target}`);
      config.log("info", `session ${p.symbol} -> ${p.target}`, {
        signature: outcome.signature,
      });
    }
  };

  const landed = (p: Plan, quote: Quote) => {
    state.printedAt.set(p.symbol, quote.printedAt);
    state.lastQuoteAt.set(p.symbol, now);
    published.push(p.symbol);
    prints.push({ symbol: p.symbol, price: quote.price });
  };

  /**
   * Walk a market that moved past the deviation cap toward its real price,
   * one legal step per tick. Opt-in: the same rejection means "the feed is
   * lying" and "the chain is behind", and only a person knows which.
   */
  const catchUp = async (p: Plan, quote: Quote, current: bigint) => {
    if (!options.catchUp) {
      config.log("error", `${p.symbol} moved more than the deviation cap allows`, {
        price: quote.price.toString(),
        hint: "verify against a second source, then set ORACLE_CATCHUP=yes to walk it in steps",
      });
      skipped.push(p.symbol);
      return;
    }
    const step = cappedStep(current, quote.price);
    const stepped = await send(
      config,
      [priceIx(p.oracle, step, quote.confidence)],
      `update_price_oracle ${p.symbol} (catching up)`,
    );
    config.log("warn", `${p.symbol} catching up in capped steps`, {
      from: current.toString(),
      to: step.toString(),
      target: quote.price.toString(),
      arrived: step === quote.price,
      ok: stepped.ok,
    });
    // Not recording `printedAt` for a step: it is not the print, and
    // recording it would stop the walk one step short, forever.
    if (stepped.ok && step === quote.price) landed(p, quote);
    else skipped.push(p.symbol);
  };

  /** One market's price on its own; a deviation rejection goes to catch-up. */
  const publishOne = async (p: Plan, quote: Quote) => {
    const outcome = await send(
      config,
      [priceIx(p.oracle, quote.price, quote.confidence)],
      `update_price_oracle ${p.symbol}`,
    );
    if (outcome.ok) {
      landed(p, quote);
      return;
    }
    if (outcome.error !== "OracleDeviationTooLarge") {
      skipped.push(p.symbol);
      return;
    }
    if (!options.catchUp) {
      await catchUp(p, quote, 0n); // logs the refusal and skips; reads nothing
      return;
    }
    // The step has to be measured from the price actually on chain.
    const [current] = await readPrices([p.oracle]).catch(() => [null]);
    if (current === null || current === undefined) {
      skipped.push(p.symbol);
      return;
    }
    await catchUp(p, quote, current);
  };

  // 1. Opening: session first, so the stale close is never usable under a
  //    live session's strict budget.
  for (const p of plans) if (p.opening) await writeSession(p);

  // 2. Prices, several markets per transaction.
  //
  //    One transaction per market was a request storm at thirty-five markets:
  //    every send is a blockhash fetch, the send and a confirmation poll, and
  //    a rate-limited RPC then throttled prices past the program's sixty-second
  //    staleness limit. Batching cuts that by the batch size. A batch the
  //    program rejects (one market's jump over the deviation cap fails all of
  //    them) falls back to one market at a time, which is where the rare
  //    per-market handling lives.
  const fresh: { p: Plan; quote: Quote }[] = [];
  for (const p of plans) {
    if (!p.quote) skipped.push(p.symbol);
    // The same trade. Republishing would reset the on-chain timestamp and
    // launder a stale print into a fresh one.
    else if (state.printedAt.get(p.symbol) === p.quote.printedAt) skipped.push(p.symbol);
    else fresh.push({ p, quote: p.quote });
  }
  // Which of these would the program refuse? One read covers every oracle.
  // A market that jumped past the deviation cap would fail any batch it rode
  // in, and a failed batch falls back to one send per market: with a few such
  // markets that turned every tick into dozens of sends, and prices across the
  // whole book went stale waiting behind them. So they are set aside and
  // handled after every other market is published.
  let current: (bigint | null)[] = fresh.map(() => null);
  try {
    current = await readPrices(fresh.map(({ p }) => p.oracle));
  } catch {
    /* unknown: everything is batched, and a rejected batch still falls back */
  }
  const batchable: typeof fresh = [];
  const jumped: { p: Plan; quote: Quote; current: bigint }[] = [];
  fresh.forEach((f, i) => {
    const onChain = current[i];
    if (
      onChain !== null &&
      onChain !== undefined &&
      onChain > 0n &&
      deviationBps(onChain, f.quote.price) > SAFE_DEVIATION_BPS
    ) {
      jumped.push({ ...f, current: onChain });
    } else {
      batchable.push(f);
    }
  });

  const batchSize = Math.max(1, options.batchSize ?? PRICE_BATCH);
  for (let i = 0; i < batchable.length; i += batchSize) {
    const batch = batchable.slice(i, i + batchSize);
    if (batch.length === 1) {
      await publishOne(batch[0].p, batch[0].quote);
      continue;
    }
    const outcome = await send(
      config,
      batch.map(({ p, quote }) => priceIx(p.oracle, quote.price, quote.confidence)),
      `update_price_oracle ${batch.map(({ p }) => p.symbol).join(",")}`,
    );
    if (outcome.ok) {
      for (const { p, quote } of batch) landed(p, quote);
    } else if (outcome.rejected) {
      for (const { p, quote } of batch) await publishOne(p, quote);
    } else {
      // Transport failure after retries: the next tick tries again, and the
      // staleness rules on chain cover the gap.
      for (const { p } of batch) skipped.push(p.symbol);
    }
  }

  // Only now the markets that moved past the cap, so they never delay the rest.
  for (const j of jumped) await catchUp(j.p, j.quote, j.current);

  // 3. Every other transition: price first, session after, so the final
  //    print is the one standing when the session flips.
  for (const p of plans) {
    if (p.roundTheClock && !p.quote?.halted) p.target = roundTheClockTarget(p.symbol);
    if (!p.opening) await writeSession(p);
  }

  return { published, prints, sessionsChanged, skipped };
}
