/**
 * Price history, kept by the keeper and served to the interface.
 *
 * # Why the keeper and not the browser
 *
 * The interface used to rebuild each chart itself, by paging a market's oracle
 * transactions from a public RPC endpoint and decoding the price out of each
 * publish. That caps out at a few minutes of history before rate limits bite,
 * and it starts from nothing every time the page loads. The result was a chart
 * of three candles after a keeper restart, and an almost empty one overnight.
 *
 * The keeper is the one party that already sees every price: it publishes
 * them. So it records each one as it goes, backfills from the chain once at
 * startup through its own dedicated endpoint, and serves the series over HTTP.
 * Every visitor then reads one small JSON document per market instead of
 * paging hundreds of transactions each.
 *
 * # Counted, not timed
 *
 * The store keeps the last `capacity` prints per symbol rather than the last N
 * hours. A market that has been closed since Friday still has Friday's session
 * in the store on Sunday, which is what a chart of a closed market should show.
 */

import type { Connection, PublicKey } from "@solana/web3.js";
import { BorshCoder } from "@coral-xyz/anchor";
import idl from "../../idl/arclis.json";

const coder = new BorshCoder(idl as never);

/** The IDL's spelling: a raw `BorshCoder` does not camelCase names. */
const PUBLISH_IX = "update_price_oracle";

export interface Print {
  /** Unix seconds, from the cluster's block time. */
  t: number;
  /** Protocol price scale, 1e6. */
  price: bigint;
}

export class PriceHistory {
  private readonly series = new Map<string, Print[]>();

  constructor(readonly capacity = 3000) {}

  /** Record a price the keeper has just published. */
  record(symbol: string, price: bigint, t = Math.floor(Date.now() / 1000)) {
    this.merge(symbol, [{ t, price }]);
  }

  /**
   * Fold prints into a symbol's series: sorted, one print per second, and
   * trimmed to capacity from the old end.
   */
  merge(symbol: string, prints: Print[]) {
    const byT = new Map<number, Print>();
    for (const p of this.series.get(symbol) ?? []) byT.set(p.t, p);
    for (const p of prints) byT.set(p.t, p);
    const sorted = [...byT.values()].sort((a, b) => a.t - b.t);
    this.series.set(symbol, sorted.slice(-this.capacity));
  }

  get(symbol: string, limit = this.capacity): Print[] {
    return (this.series.get(symbol) ?? []).slice(-limit);
  }

  symbols(): string[] {
    return [...this.series.keys()];
  }

  /** The wire format: dollars as numbers, which is what a chart consumes. */
  toJson(symbol: string, limit?: number) {
    return {
      symbol,
      points: this.get(symbol, limit).map((p) => ({
        t: p.t,
        p: Number(p.price) / 1_000_000,
      })),
    };
  }
}

/**
 * Read a symbol's past publishes back off the chain.
 *
 * Paced deliberately. This runs once at startup for every market, against the
 * same endpoint the keeper publishes through, and a burst of transaction
 * fetches is exactly what drew the wall of 429s that once stopped the keeper.
 * It runs in the background while publishing carries on, so taking a few
 * minutes costs nothing but a shorter chart for those minutes.
 */
export async function backfillSymbol(
  connection: Connection,
  programId: PublicKey,
  oracle: PublicKey,
  options: {
    target: number;
    maxPages?: number;
    pageSize?: number;
    batch?: number;
    delayMs?: number;
  },
): Promise<Print[]> {
  const pageSize = options.pageSize ?? 200;
  const maxPages = options.maxPages ?? 40;
  const batch = options.batch ?? 25;
  const delayMs = options.delayMs ?? 250;

  const prints: Print[] = [];
  let before: string | undefined;

  for (let page = 0; page < maxPages && prints.length < options.target; page++) {
    const signatures = await connection.getSignaturesForAddress(oracle, {
      limit: pageSize,
      before,
    });
    if (signatures.length === 0) break;
    before = signatures[signatures.length - 1].signature;

    const usable = signatures.filter((s) => !s.err).map((s) => s.signature);
    for (let i = 0; i < usable.length; i += batch) {
      const txs = await connection.getParsedTransactions(
        usable.slice(i, i + batch),
        { maxSupportedTransactionVersion: 0 },
      );
      for (const tx of txs) {
        const price = publishedPrice(tx, programId);
        if (price !== null && tx?.blockTime != null) {
          prints.push({ t: tx.blockTime, price });
        }
      }
      await sleep(delayMs);
    }
    if (signatures.length < pageSize) break;
  }
  return prints.sort((a, b) => a.t - b.t);
}

/** The price an `update_price_oracle` in this transaction set, if any. */
export function publishedPrice(
  tx: Awaited<ReturnType<Connection["getParsedTransaction"]>>,
  programId: PublicKey,
): bigint | null {
  if (!tx || tx.meta?.err) return null;
  for (const ix of tx.transaction.message.instructions) {
    if (!("data" in ix) || !ix.programId.equals(programId)) continue;
    try {
      const decoded = coder.instruction.decode(ix.data, "base58");
      if (decoded?.name !== PUBLISH_IX) continue;
      const price = (decoded.data as { price?: { toString(): string } }).price;
      if (price != null) return BigInt(price.toString());
    } catch {
      /* another of our instructions, or an older layout */
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
