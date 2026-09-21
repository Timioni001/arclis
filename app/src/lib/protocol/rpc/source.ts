/**
 * The chain-backed `DataSource`.
 *
 * # Why it holds a snapshot instead of fetching per call
 *
 * `DataSource` is synchronous, and every screen calls it during render. That
 * was a deliberate choice when the only implementation was in-memory, and it
 * is worth preserving: making it async would turn six screens into loading-state
 * machines for no gain, because they all want the same consistent view of the
 * world anyway.
 *
 * So this implementation fetches into a snapshot and serves the snapshot. One
 * `refresh()` reads every account the interface needs in a small number of
 * batched calls, and the screens see a single coherent moment rather than a
 * dozen reads interleaved with block production. A market whose oracle is one
 * slot newer than its pool is exactly the kind of inconsistency that makes a
 * NAV look wrong.
 *
 * # What it does not do
 *
 * It does not sign, send, or simulate anything. Reads and writes are separate
 * files on purpose, so a bug in the transaction layer cannot corrupt what the
 * interface displays, and a read-only deployment is the default rather than a
 * configuration.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import type {
  ActivityEvent,
  Candle,
  CorporateAction,
  LpPosition,
  MarketView,
  Position,
  Treasury,
} from "../types";
import type { DataSource } from "../mock";
import {
  decodeLpPosition,
  decodeMarket,
  decodeOracle,
  decodePool,
  decodePosition,
} from "./decode";
import { lpPositionPda, marketAddresses, positionPda } from "./pdas";
import {
  appendPoint,
  candlesFrom,
  fetchPriceHistory,
  type PricePoint,
} from "./history";

/**
 * A source that reads a chain, and can say when it last managed to.
 *
 * `refresh` is separate from the read methods so the caller decides the
 * cadence. `lastError` is a field rather than a thrown exception because a
 * failed poll must not blank the interface: the previous snapshot is still the
 * best information available, and the banner says how old it is.
 */
export interface LiveDataSource extends DataSource {
  refresh(): Promise<void>;
  /**
   * Re-point at a different account, or at none. Does not itself refetch.
   *
   * Takes base58 rather than a `PublicKey` so the caller does not have to
   * import `@solana/web3.js` just to change who is signed in.
   */
  setOwner(owner: string | null): void;
  readonly loadedAt: number | null;
  readonly lastError: string | null;
  readonly endpoint: string;
}

interface Snapshot {
  markets: MarketView[];
  positions: Position[];
  lpPositions: LpPosition[];
}

const EMPTY: Snapshot = { markets: [], positions: [], lpPositions: [] };

export interface RpcSourceOptions {
  endpoint: string;
  programId: PublicKey;
  symbols: string[];
  /** The connected account, when there is one. Null means read-only. */
  owner?: PublicKey | null;
  /** Company names by ticker, resolved off-chain. */
  names?: Record<string, string>;
  connection?: Connection;
}

export function rpcSource(options: RpcSourceOptions): LiveDataSource {
  const connection =
    options.connection ?? new Connection(options.endpoint, "confirmed");

  let snapshot: Snapshot = EMPTY;
  let loadedAt: number | null = null;
  let lastError: string | null = null;
  let owner: PublicKey | null = options.owner ?? null;

  /*
   * Price history, per oracle, for the lifetime of the page.
   *
   * Two sources feed it. `fetchPriceHistory` reads the publishes that already
   * happened, once per session, because they are on-chain and re-reading them
   * every thirty seconds would be paying repeatedly for an answer that cannot
   * change. After that the refresh below extends the series from the price it
   * is already fetching, which costs nothing at all.
   *
   * Backfill failure is not an error anyone needs to see. It means the chart
   * starts at the moment the page opened instead of an hour earlier, which is
   * a smaller chart, not a wrong one.
   */
  const history = new Map<string, PricePoint[]>();
  const backfilled = new Set<string>();

  async function backfill(oracles: { key: PublicKey; id: string }[]) {
    await Promise.all(
      oracles
        .filter((o) => !backfilled.has(o.id))
        .map(async (o) => {
          backfilled.add(o.id);
          try {
            const points = await fetchPriceHistory(
              connection,
              o.key,
              options.programId,
            );
            if (points.length === 0) return;
            // Merge under whatever the live loop has already appended, rather
            // than over it: the poll may well have landed first.
            const live = history.get(o.id) ?? [];
            const merged = points.concat(
              live.filter((p) => p.t > points[points.length - 1].t),
            );
            history.set(o.id, merged);
          } catch {
            /* the series simply starts later */
          }
        }),
    );
  }

  /**
   * Percentage move over the trailing day, from the series.
   *
   * Zero until there is a print old enough to compare against. Reporting a
   * move against the oldest point available would make a keeper that started
   * ten minutes ago look like a 24h change, and "biggest movers" would rank
   * markets by how long the keeper has been up.
   */
  function changeOverDay(points: PricePoint[], now: bigint): number {
    if (points.length < 2) return 0;
    const cutoff = points[points.length - 1].t - 86_400;
    const earlier = points.find((p) => p.t >= cutoff) ?? points[0];
    if (points[0].t > cutoff) return 0;
    const from = Number(earlier.price);
    if (from === 0) return 0;
    return ((Number(now) - from) / from) * 100;
  }

  async function refresh(): Promise<void> {
    try {
      const derived = options.symbols.map((symbol) => ({
        symbol,
        ...marketAddresses(options.programId, symbol),
      }));

      // One batched read for every market's oracle, market, pool and both
      // vaults. `getMultipleAccountsInfo` caps at 100 keys per call, and five
      // keys per market means twenty markets per batch, so chunk rather than
      // assume.
      const keys: PublicKey[] = [];
      for (const d of derived) {
        keys.push(d.oracle, d.market, d.pool, d.poolVault, d.marketVault);
      }
      if (owner) {
        for (const d of derived) {
          keys.push(
            positionPda(options.programId, owner, d.market),
            lpPositionPda(options.programId, owner, d.pool),
          );
        }
      }

      // In parallel with the account read, and a no-op after the first call.
      // Sequencing them would add the backfill's round trip to every first
      // paint for no reason: neither read depends on the other.
      const [infos] = await Promise.all([
        getMultiple(connection, keys),
        backfill(
          derived.map((d) => ({ key: d.oracle, id: d.oracle.toBase58() })),
        ),
      ]);

      const markets: MarketView[] = [];
      const positions: Position[] = [];
      const lpPositions: LpPosition[] = [];

      derived.forEach((d, i) => {
        const base = i * 5;
        const oracleInfo = infos[base];
        const marketInfo = infos[base + 1];
        const poolInfo = infos[base + 2];
        const poolVaultInfo = infos[base + 3];

        // A market whose accounts are not all present is skipped rather than
        // half-rendered. Half a market is worse than no market: the screens
        // would show a real oracle price beside a zeroed pool and imply
        // solvency that is not there.
        if (!oracleInfo || !marketInfo || !poolInfo) return;

        const oracle = decodeOracle(d.oracle, oracleInfo.data, {
          name: options.names?.[d.symbol],
        });
        const market = decodeMarket(d.market, marketInfo.data);
        const pool = decodePool(
          d.pool,
          poolInfo.data,
          poolVaultInfo ? tokenAccountAmount(poolVaultInfo.data) : 0n,
        );

        // The oracle's own timestamp, not the clock here: two prints can land
        // in one refresh window, and stamping both with `Date.now()` would
        // draw a move that never happened.
        const id = d.oracle.toBase58();
        const points = appendPoint(history.get(id) ?? [], {
          t: oracle.lastUpdateTs,
          price: oracle.price,
        });
        history.set(id, points);

        markets.push({
          market,
          oracle,
          pool,
          // Reconstructed from the transactions that published each price;
          // see `history.ts`. Volume stays zero because a price publish
          // carries no size, and there is no indexer over fills yet.
          candles: candlesFrom(points) as Candle[],
          volume24h: 0n,
          changePct24h: changeOverDay(points, oracle.price),
        });
      });

      if (owner) {
        const ownerBase = derived.length * 5;
        derived.forEach((d, i) => {
          const posInfo = infos[ownerBase + i * 2];
          const lpInfo = infos[ownerBase + i * 2 + 1];
          if (posInfo) {
            positions.push(
              decodePosition(
                positionPda(options.programId, owner!, d.market),
                posInfo.data,
              ),
            );
          }
          if (lpInfo) {
            lpPositions.push(
              decodeLpPosition(
                lpPositionPda(options.programId, owner!, d.pool),
                lpInfo.data,
              ),
            );
          }
        });
      }

      /*
       * A read that finds nothing does not mean there is nothing.
       *
       * Every market is skipped when its accounts come back null, and a
       * shared endpoint returns nulls for reasons that have nothing to do
       * with the chain: a rate limit, a lagging replica, a dropped batch. If
       * that were written through, the interface would go from five markets
       * to none and back on the next poll, which downstream reads as the
       * protocol having been emptied.
       *
       * So an empty result is treated as a failed read, not as news. The
       * previous snapshot stands and the error is recorded, exactly as any
       * other dropped poll.
       */
      if (markets.length === 0 && snapshot.markets.length > 0) {
        lastError = "a refresh returned no markets; kept the last good read";
        return;
      }

      snapshot = { markets, positions, lpPositions };
      loadedAt = Math.floor(Date.now() / 1000);
      lastError = null;
    } catch (e) {
      // Keep the previous snapshot. A dropped poll is a stale interface, which
      // is recoverable; a blanked one looks like the protocol failed.
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    kind: "rpc",
    get loadedAt() {
      return loadedAt;
    },
    get lastError() {
      return lastError;
    },
    endpoint: options.endpoint,
    refresh,
    setOwner(next) {
      owner = next ? new PublicKey(next) : null;
      // The previous snapshot's positions belong to whoever was signed in
      // before. Keeping them would show one account's positions to another.
      snapshot = { ...snapshot, positions: [], lpPositions: [] };
    },

    wallet: () => owner?.toBase58() ?? null,
    markets: () => snapshot.markets,
    market: (symbol) =>
      snapshot.markets.find((mv) => mv.oracle.symbol === symbol),
    positions: () =>
      snapshot.positions.filter((p) => p.size !== 0n || p.collateral > 0n),
    positionFor: (marketAddress) =>
      snapshot.positions.find((p) => p.market === marketAddress),
    lpPosition: (poolAddress) =>
      snapshot.lpPositions.find((p) => p.pool === poolAddress),

    // Treasuries, corporate actions and activity are all event-stream or
    // scan-based rather than derivable from a known address, so they need an
    // indexer. Returning empty is what the screens' empty states are for.
    treasuries: () => [] as Treasury[],
    treasuryPosition: () => undefined,
    corporateActions: () => [] as CorporateAction[],
    activity: () => [] as ActivityEvent[],
  };
}

/** `getMultipleAccountsInfo` caps at 100 keys, so chunk and flatten. */
async function getMultiple(connection: Connection, keys: PublicKey[]) {
  const out: (Awaited<ReturnType<Connection["getAccountInfo"]>> | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const batch = await connection.getMultipleAccountsInfo(
      keys.slice(i, i + 100),
    );
    out.push(...batch);
  }
  return out;
}

/**
 * Read an SPL token account's `amount` without pulling in the full token
 * program decoder.
 *
 * The layout is fixed: mint (32), owner (32), then the amount as a
 * little-endian u64 at offset 64. This is stable across both Token and
 * Token-2022 for the base fields, which is all that is needed here.
 */
export function tokenAccountAmount(data: Buffer | Uint8Array): bigint {
  if (data.length < 72) return 0n;
  let amount = 0n;
  for (let i = 7; i >= 0; i--) {
    amount = (amount << 8n) | BigInt(data[64 + i]);
  }
  return amount;
}
