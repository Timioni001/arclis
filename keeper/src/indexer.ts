/**
 * The event indexer: the activity feed and the corporate-action log.
 *
 * Trades, liquidations, LP flows, splits and hedge rebalances are emitted as
 * Anchor events. They leave no account behind, so the interface cannot scan
 * for them the way it scans for treasuries; something has to read
 * transactions and keep what they said. This is that, sized for a devnet
 * deployment: in memory, rebuilt from recent history on every restart.
 *
 * # What it reads, and what it skips
 *
 * It polls signatures for each **market** account rather than for the
 * program. Every trade, close, liquidation, LP action, corporate action and
 * hedge rebalance writes its market, while the oracle publishes the keeper
 * sends every twenty seconds do not. Polling the program would mean fetching
 * forty-five price updates a minute to find the handful of events worth
 * showing. Funding cranks do touch the market; their events are dropped as
 * noise.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import idl from "../../idl/arclis.json";
import { FUNDING_MEMO } from "./cranks";

export interface IndexedEvent {
  /** `signature:index`, unique and stable. */
  id: string;
  kind: string;
  ts: number;
  symbol: string | null;
  signature: string;
  /** Event fields, JSON-safe: integers as strings, keys as base58. */
  data: Record<string, unknown>;
}

const SKIP = new Set(["FundingAccrued"]);
const FETCH_CHUNK = 5;

type Sig = { signature: string; err: unknown; memo?: string | null; blockTime?: number | null };
const CAPACITY = 2_000;
const seed = (s: string) => Buffer.from(new TextEncoder().encode(s));

export function marketAddress(programId: PublicKey, symbol: string) {
  const sym = new Uint8Array(16);
  sym.set(new TextEncoder().encode(symbol));
  const oracle = PublicKey.findProgramAddressSync([seed("oracle"), Buffer.from(sym)], programId)[0];
  const market = PublicKey.findProgramAddressSync([seed("market"), oracle.toBuffer()], programId)[0];
  return { oracle, market };
}

/** BN, PublicKey and Anchor enum values, made JSON-safe. */
export function plain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    const v = value as Record<string, unknown> & { toString?: (radix?: number) => string };
    // BN: has `toArray` and a radix `toString`.
    if (typeof (v as { toArray?: unknown }).toArray === "function") return v.toString!(10);
    const keys = Object.keys(v);
    // An Anchor enum decodes as `{ variant: {} }`.
    if (keys.length === 1 && JSON.stringify(v[keys[0]]) === "{}") return keys[0];
    return Object.fromEntries(keys.map((k) => [k, plain(v[k])]));
  }
  return value;
}

/** Events out of one transaction's logs. */
export function eventsFromLogs(
  parser: EventParser,
  logs: string[],
  signature: string,
  ts: number,
  symbolOf: (address: string) => string | null,
): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  let i = 0;
  for (const ev of parser.parseLogs(logs)) {
    const index = i++;
    if (SKIP.has(ev.name)) continue;
    const data = plain(ev.data) as Record<string, unknown>;
    const ref = (data.market ?? data.oracle) as string | undefined;
    out.push({
      id: `${signature}:${index}`,
      kind: ev.name,
      ts,
      symbol: ref ? symbolOf(ref) : null,
      signature,
      data,
    });
  }
  return out;
}

export class EventIndexer {
  private events: IndexedEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly newest = new Map<string, string>();
  private readonly symbols = new Map<string, string>();
  private readonly markets: { symbol: string; market: PublicKey }[];
  private readonly parser: EventParser;

  constructor(
    private readonly connection: Connection,
    programId: PublicKey,
    symbols: string[],
  ) {
    this.parser = new EventParser(programId, new BorshCoder(idl as never));
    this.markets = symbols.map((symbol) => {
      const { oracle, market } = marketAddress(programId, symbol);
      this.symbols.set(oracle.toBase58(), symbol);
      this.symbols.set(market.toBase58(), symbol);
      return { symbol, market };
    });
  }

  /**
   * One pass over every market. The first pass backfills the last `backfill`
   * signatures per market, paging back through history.
   *
   * Funding cranks carry a memo (`FUNDING_MEMO`), and signatures come back
   * with their memo, so cranks are skipped without being fetched. That is what
   * makes a deep backfill affordable: the market account is written every
   * five minutes by funding, and only the transactions in between are read.
   */
  async poll(backfill = 300): Promise<number> {
    let added = 0;
    for (const { market } of this.markets) {
      const key = market.toBase58();
      const until = this.newest.get(key);
      const sigs: Sig[] = [];
      if (until) {
        sigs.push(...(await this.connection.getSignaturesForAddress(market, { until, limit: 1000 })));
      } else {
        let before: string | undefined;
        while (sigs.length < backfill) {
          const limit = Math.min(1000, backfill - sigs.length);
          const page = await this.connection.getSignaturesForAddress(market, { before, limit });
          sigs.push(...page);
          if (page.length < limit) break;
          before = page[page.length - 1].signature;
        }
      }
      if (sigs.length === 0) continue;
      this.newest.set(key, sigs[0].signature);
      const fresh = sigs.filter(
        (s) =>
          !s.err &&
          !this.seen.has(s.signature) &&
          !(s.memo ?? "").includes(FUNDING_MEMO),
      );
      for (const s of fresh) this.seen.add(s.signature);
      // A few at a time: single requests, not a JSON-RPC batch, which some
      // providers' free tiers refuse, and slow enough to stay under their
      // per-second limits.
      for (let i = 0; i < fresh.length; i += FETCH_CHUNK) {
        const chunk = fresh.slice(i, i + FETCH_CHUNK);
        const txs = await Promise.all(
          chunk.map((s) =>
            this.connection
              .getTransaction(s.signature, {
                maxSupportedTransactionVersion: 0,
                commitment: "confirmed",
              })
              .catch(() => null),
          ),
        );
        txs.forEach((tx, j) => {
          const logs = tx?.meta?.logMessages;
          if (!logs) return;
          const sig = chunk[j].signature;
          const ts = tx.blockTime ?? chunk[j].blockTime ?? Math.floor(Date.now() / 1000);
          const evs = eventsFromLogs(this.parser, logs, sig, ts, (a) => this.symbols.get(a) ?? null);
          this.events.push(...evs);
          added += evs.length;
        });
      }
    }
    if (added) {
      this.events.sort((a, b) => b.ts - a.ts);
      this.events = this.events.slice(0, CAPACITY);
    }
    return added;
  }

  list(opts: { symbol?: string | null; kinds?: string[]; limit?: number } = {}) {
    let out = this.events;
    if (opts.symbol) out = out.filter((e) => e.symbol === opts.symbol);
    if (opts.kinds?.length) out = out.filter((e) => opts.kinds!.includes(e.kind));
    return out.slice(0, Math.min(opts.limit ?? 50, 500));
  }
}
