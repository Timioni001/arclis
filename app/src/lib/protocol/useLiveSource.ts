/**
 * Driving a `LiveDataSource` from React.
 *
 * Three jobs, all of which are easy to get subtly wrong inline in a component:
 *
 *  1. Poll on an interval, and stop polling while the tab is hidden. A
 *     background tab hammering an RPC endpoint is how a demo gets rate limited
 *     halfway through being judged.
 *  2. Re-point the source when the signed-in account changes, and clear the
 *     previous account's positions before the next fetch lands. Showing one
 *     account's positions to another for even one frame is not acceptable.
 *  3. Re-render when a refresh completes. The source holds a mutable snapshot
 *     by design, so React needs an explicit nudge.
 */

import { useEffect, useState } from "react";
import type { DataSource } from "./mock";
import type { LiveDataSource } from "./rpc/source";

function isLive(source: DataSource): source is LiveDataSource {
  return (
    source.kind === "rpc" &&
    typeof (source as LiveDataSource).refresh === "function"
  );
}

export interface LiveStatus {
  live: boolean;
  /** Unix seconds of the last successful read, or null before the first one. */
  loadedAt: number | null;
  lastError: string | null;
  refreshing: boolean;
  refresh: () => void;
}

export function useLiveSource(
  source: DataSource,
  address: string | null,
  intervalMs: number,
): LiveStatus {
  // A counter rather than the snapshot itself: the source owns the data and
  // copying it into state would mean two sources of truth.
  const [, bump] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const live = isLive(source);

  useEffect(() => {
    if (!isLive(source)) return;
    source.setOwner(address);
    bump((n) => n + 1);
  }, [source, address]);

  useEffect(() => {
    if (!isLive(source)) return;
    let cancelled = false;

    const tick = async () => {
      if (document.hidden) return;
      setRefreshing(true);
      await source.refresh();
      if (cancelled) return;
      setRefreshing(false);
      bump((n) => n + 1);
    };

    void tick();
    const id = setInterval(tick, Math.max(2_000, intervalMs));
    // A tab coming back to the foreground wants fresh data immediately, not at
    // the next interval boundary.
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [source, address, intervalMs]);

  return {
    live,
    loadedAt: live ? (source as LiveDataSource).loadedAt : null,
    lastError: live ? (source as LiveDataSource).lastError : null,
    refreshing,
    refresh: () => {
      if (isLive(source)) void source.refresh().then(() => bump((n) => n + 1));
    },
  };
}
