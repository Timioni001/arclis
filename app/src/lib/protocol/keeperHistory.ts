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
import type { Candle, PricePoint } from "./types";

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

// ---------------------------------------------------------------------------
// Market data: years of daily bars, a month of 15-minute bars, and the
// previous close every market's daily change is measured against.
// ---------------------------------------------------------------------------


const toUnits = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));

export async function fetchCandles(
  symbol: string,
  interval: "1d" | "15m",
  base = KEEPER_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<Candle[]> {
  if (!base) return [];
  const res = await fetchImpl(
    `${base}/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as {
    bars?: { t: number; o: number; h: number; l: number; c: number; v: number }[];
  };
  return (body.bars ?? [])
    .filter((b) => [b.t, b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0))
    .map((b) => ({
      t: b.t,
      o: toUnits(b.o),
      h: toUnits(b.h),
      l: toUnits(b.l),
      c: toUnits(b.c),
      // Share volume, carried at the same 1e6 scale the chart divides by.
      v: toUnits(b.v || 0),
    }));
}

export interface MarketCandles {
  daily: Candle[];
  intraday: Candle[];
}

/** Daily and 15-minute bars for one market, re-read every twenty minutes. */
export function useMarketCandles(symbol: string): MarketCandles {
  const [data, setData] = useState<MarketCandles>({ daily: [], intraday: [] });

  useEffect(() => {
    if (!KEEPER_URL || DATA_SOURCE !== "rpc") return;
    let cancelled = false;
    setData({ daily: [], intraday: [] });
    const load = async () => {
      const [daily, intraday] = await Promise.all([
        fetchCandles(symbol, "1d").catch(() => [] as Candle[]),
        fetchCandles(symbol, "15m").catch(() => [] as Candle[]),
      ]);
      if (!cancelled) {
        setData((prev) => ({
          // Keep the previous copy of a series that failed to load.
          daily: daily.length ? daily : prev.daily,
          intraday: intraday.length ? intraday : prev.intraday,
        }));
      }
    };
    void load();
    const id = setInterval(() => void load(), 20 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  return data;
}

export interface MarketSummary {
  /** Previous session's close, protocol scale (1e6). */
  previousClose: bigint | null;
  /** Last month of daily closes, protocol scale. */
  closes: bigint[];
}

export async function fetchSummary(
  base = KEEPER_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, MarketSummary>> {
  if (!base) return {};
  const res = await fetchImpl(`${base}/summary`);
  if (!res.ok) return {};
  const body = (await res.json()) as {
    symbols?: Record<string, { previousClose: number | null; closes: number[] }>;
  };
  const out: Record<string, MarketSummary> = {};
  for (const [symbol, s] of Object.entries(body.symbols ?? {})) {
    out[symbol] = {
      previousClose:
        s.previousClose && s.previousClose > 0 ? toUnits(s.previousClose) : null,
      closes: (s.closes ?? []).filter((c) => c > 0).map(toUnits),
    };
  }
  return out;
}

/** The overview's summary for every market, re-read every minute. */
export function useMarketSummary(): Record<string, MarketSummary> {
  const [summary, setSummary] = useState<Record<string, MarketSummary>>({});
  useEffect(() => {
    if (!KEEPER_URL || DATA_SOURCE !== "rpc") return;
    let cancelled = false;
    const load = () =>
      fetchSummary()
        .then((s) => !cancelled && Object.keys(s).length && setSummary(s))
        .catch(() => {});
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return summary;
}

/**
 * A market view with its daily change measured against the previous close,
 * and a month of daily closes for its sparkline.
 *
 * The oracle's own history is too short to answer "how has this moved today"
 * until it has run for a full day, which is why every market read 0.00%. The
 * previous session's official close is the standard basis for that figure.
 */
export function withSummary<
  T extends { oracle: { symbol: string; price: bigint; lastUpdateTs: number }; changePct24h: number; candles: Candle[] },
>(view: T, summary: MarketSummary | undefined): T & { spark?: Candle[] } {
  if (!summary) return view;
  const pc = summary.previousClose;
  const price = view.oracle.price;
  const changePct24h =
    pc && pc > 0n && price > 0n ? (Number(price - pc) / Number(pc)) * 100 : view.changePct24h;
  const spark: Candle[] = summary.closes.map((c, i) => ({
    t: i,
    o: c,
    h: c,
    l: c,
    c,
    v: 0n,
  }));
  if (price > 0n) spark.push({ t: spark.length, o: price, h: price, l: price, c: price, v: 0n });
  return { ...view, changePct24h, spark: spark.length >= 2 ? spark : undefined };
}
