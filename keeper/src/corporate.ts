/**
 * Corporate actions: splits and cash dividends, published between sessions.
 *
 * # The timing rule is the whole file
 *
 * Both instructions refuse to run while the venue is open, and that is not a
 * convenience. A split moves the oracle price and the cumulative factor in one
 * transaction; a dividend moves the index. If either landed mid-session there
 * would be a window in which a position could be opened against one side of
 * the change and settled against the other. On Solana that window is long
 * enough to be taken deliberately.
 *
 * So this keeper only acts while `Closed`, and it acts on the *ex-date*: the
 * morning the price drops. Applying a dividend the day before pays a credit
 * against a price that has not fallen yet, which is a straight transfer from
 * the shorts.
 *
 * # Idempotency
 *
 * A corporate action applied twice is a four-for-one split becoming sixteen.
 * There is no on-chain replay guard keyed to a provider's action id, so the
 * guard lives here: applied actions are recorded, and the record is checked
 * before anything is sent. `AppliedLog` is an interface so a deployment can
 * back it with something that survives a restart, and the default in-memory
 * one is explicitly not that.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BN, BorshCoder } from "@coral-xyz/anchor";
import idl from "../../idl/arclis.json";
import { sessionAt } from "./calendar";
import { send, type ChainConfig } from "./chain";
import { addressesFor } from "./cranks";

const coder = new BorshCoder(idl as never);

export type CorporateAction =
  | {
      kind: "split";
      /** A stable id from the provider, used to avoid double-applying. */
      id: string;
      symbol: string;
      /** `4:1` is numerator 4, denominator 1. A reverse `1:10` is 1 and 10. */
      numerator: number;
      denominator: number;
      /** The date the price adjusts, `YYYY-MM-DD` Eastern. */
      exDate: string;
    }
  | {
      kind: "dividend";
      id: string;
      symbol: string;
      /** Quote per share, in whole currency units. */
      perShare: number;
      exDate: string;
    };

export interface CorporateActionFeed {
  readonly name: string;
  /** Actions whose ex-date is on or before `throughDate`, `YYYY-MM-DD`. */
  pending(symbols: string[], throughDate: string): Promise<CorporateAction[]>;
}

/** Remembers what has already been applied. */
export interface AppliedLog {
  has(id: string): Promise<boolean>;
  record(id: string): Promise<void>;
}

/**
 * The default log, which is memory only.
 *
 * Named so nobody deploys it by accident. A restart forgets everything, and a
 * forgotten split is a split applied twice. Back it with a file or a row in a
 * table before this runs anywhere that matters.
 */
export function ephemeralAppliedLog(): AppliedLog {
  const seen = new Set<string>();
  return {
    async has(id) {
      return seen.has(id);
    },
    async record(id) {
      seen.add(id);
    },
  };
}

/**
 * Polygon's corporate actions endpoints.
 *
 * Splits and dividends are separate resources with different shapes, so this
 * is two calls and one normalisation. As with the price feeds, the parse is
 * defensive and drops anything it cannot read: a malformed split is worse than
 * a missing one.
 */
export function polygonActions(apiKey: string): CorporateActionFeed {
  const get = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok)
      throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as { results?: unknown[] };
  };

  return {
    name: "polygon",
    async pending(symbols, throughDate) {
      const out: CorporateAction[] = [];

      for (const symbol of symbols) {
        const [splits, dividends] = await Promise.all([
          get(
            `https://api.polygon.io/v3/reference/splits?ticker=${symbol}&execution_date.lte=${throughDate}&limit=10&apiKey=${apiKey}`,
          ).catch(() => ({ results: [] })),
          get(
            `https://api.polygon.io/v3/reference/dividends?ticker=${symbol}&ex_dividend_date.lte=${throughDate}&limit=10&apiKey=${apiKey}`,
          ).catch(() => ({ results: [] })),
        ]);

        for (const raw of splits.results ?? []) {
          const r = raw as Record<string, any>;
          const numerator = Number(r.split_to);
          const denominator = Number(r.split_from);
          const exDate = String(r.execution_date ?? "");
          if (!Number.isInteger(numerator) || !Number.isInteger(denominator))
            continue;
          if (numerator <= 0 || denominator <= 0 || !exDate) continue;
          out.push({
            kind: "split",
            id: String(
              r.id ?? `${symbol}-split-${exDate}-${numerator}-${denominator}`,
            ),
            symbol,
            numerator,
            denominator,
            exDate,
          });
        }

        for (const raw of dividends.results ?? []) {
          const r = raw as Record<string, any>;
          const perShare = Number(r.cash_amount);
          const exDate = String(r.ex_dividend_date ?? "");
          if (!Number.isFinite(perShare) || perShare <= 0 || !exDate) continue;
          out.push({
            kind: "dividend",
            id: String(r.id ?? `${symbol}-div-${exDate}-${perShare}`),
            symbol,
            perShare,
            exDate,
          });
        }
      }

      return out;
    },
  };
}

const ro = (pubkey: PublicKey) => ({
  pubkey,
  isSigner: false,
  isWritable: false,
});
const rw = (pubkey: PublicKey) => ({
  pubkey,
  isSigner: false,
  isWritable: true,
});
void ro;

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

export interface CorporateOptions {
  config: ChainConfig;
  feed: CorporateActionFeed;
  symbols: string[];
  applied: AppliedLog;
  now?: () => number;
}

/**
 * Apply any action whose ex-date has arrived, while the venue is shut.
 *
 * Returns what it did. Doing nothing is the normal outcome: corporate actions
 * are rare, and the window to apply one is the hours the market is closed.
 */
export async function corporateTick(options: CorporateOptions): Promise<{
  applied: string[];
  deferred: string[];
}> {
  const { config, feed, symbols, applied } = options;
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))();

  const done: string[] = [];
  const deferred: string[] = [];

  // Only between sessions. The program refuses otherwise, but checking here
  // keeps the log honest about *why* nothing happened.
  if (sessionAt(now) !== "Closed") {
    return { applied: done, deferred: ["market is not closed"] };
  }

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now * 1000));

  let actions: CorporateAction[] = [];
  try {
    actions = await feed.pending(symbols, today);
  } catch (err) {
    config.log("warn", "corporate action feed unavailable", {
      feed: feed.name,
      message: String((err as Error)?.message ?? err),
    });
    return { applied: done, deferred: ["feed unavailable"] };
  }

  for (const action of actions) {
    if (await applied.has(action.id)) continue;

    const a = addressesFor(config.programId, action.symbol);
    const keys = [
      { pubkey: config.payer.publicKey, isSigner: true, isWritable: false },
      rw(a.oracle),
      rw(a.market),
    ];

    const outcome =
      action.kind === "split"
        ? await send(
            config,
            [
              ix(
                config.programId,
                "apply_corporate_action",
                {
                  numerator: action.numerator,
                  denominator: action.denominator,
                },
                keys,
              ),
            ],
            `split ${action.symbol} ${action.numerator}:${action.denominator}`,
          )
        : await send(
            config,
            [
              ix(
                config.programId,
                "apply_dividend",
                // Quote per share at PRICE_SCALE. Rounding down: crediting a
                // fraction of a cent more than was paid would come out of the
                // shorts.
                { per_share: new BN(Math.floor(action.perShare * 1_000_000)) },
                keys,
              ),
            ],
            `dividend ${action.symbol} ${action.perShare}`,
          );

    if (outcome.ok) {
      // Record only after it lands. Recording first would skip a retry after a
      // dropped transaction and silently lose the action.
      await applied.record(action.id);
      done.push(action.id);
      config.log("info", `applied ${action.kind} on ${action.symbol}`, {
        id: action.id,
        signature: outcome.signature,
      });
    } else {
      deferred.push(action.id);
    }
  }

  return { applied: done, deferred };
}
