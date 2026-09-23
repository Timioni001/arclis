/**
 * Price history from the keeper, for the charts.
 *
 * The keeper publishes every price, records each one, and serves the series.
 * Reading it here gives a chart a full session of depth on first paint,
 * instead of the few minutes a browser can reconstruct from recent oracle
 * transactions before a public endpoint starts rate limiting it.
 *
 * It is a supplement, never a dependency. If the keeper is unreachable the
 * chart carries on with the on-chain series alone, one refresh at a time.
 */
import { useEffect, useState } from "react";
import { DATA_SOURCE, KEEPER_URL } from "../config";
import type { PricePoint } from "./types";

/** How often to re-read. Live prints arrive on the chain poll in between. */
const REFRESH_MS = 60_000;

export async function fetchKeeperHistory(
  symbol: string,
  base = KEEPER_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<PricePoint[]> {
  if (!base) return [];
  const res = await fetchImpl(
    `${base}/history?symbol=${encodeURIComponent(symbol)}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { points?: { t: number; p: number }[] };
  return (body.points ?? [])
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p) && x.p > 0)
    .map((x) => ({ t: x.t, price: BigInt(Math.round(x.p * 1_000_000)) }));
}

/**
 * Keeper history merged under the chain's own points.
 *
 * Where both have a print for the same second the chain's wins: it is the
 * record, and the keeper's copy is a convenience.
 */
export function mergePoints(
  keeper: PricePoint[],
  chain: PricePoint[],
): PricePoint[] {
  const byT = new Map<number, PricePoint>();
  for (const p of keeper) byT.set(p.t, p);
  for (const p of chain) byT.set(p.t, p);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

export function useKeeperHistory(symbol: string): PricePoint[] {
  const [points, setPoints] = useState<PricePoint[]>([]);

  useEffect(() => {
    // The modelled data source has no keeper behind it.
    if (!KEEPER_URL || DATA_SOURCE !== "rpc") return;
    let cancelled = false;
    setPoints([]);
    const load = () =>
      fetchKeeperHistory(symbol)
        .then((p) => !cancelled && setPoints(p))
        .catch(() => {
          /* keep what we have; the chain series still draws */
        });
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  return points;
}
