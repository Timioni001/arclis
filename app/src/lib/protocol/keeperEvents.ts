/**
 * The activity feed and corporate-action log, from the keeper's event indexer.
 *
 * Program events leave no account behind, so the chain-backed data source
 * cannot read them; the keeper indexes them (`keeper/src/indexer.ts`) and
 * serves them at `/events`. This turns those records into the interface's
 * `ActivityEvent` and `CorporateAction` shapes.
 */
import { useEffect, useState } from "react";
import { DATA_SOURCE, KEEPER_URL } from "../config";
import { usd, usdSigned } from "../format";
import type { ActivityEvent, ActivityKind, CorporateAction } from "./types";

export interface KeeperEvent {
  id: string;
  kind: string;
  ts: number;
  symbol: string | null;
  signature: string;
  data: Record<string, string | boolean | null>;
}

const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? 0));
  } catch {
    return 0n;
  }
};

/** Base size at 1e6 as a share count: `2`, `0.5`. */
const shares = (v: bigint) => {
  const n = Number(v < 0n ? -v : v) / 1e6;
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
};

const short = (a: unknown) => {
  const s = String(a ?? "");
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
};

/** One indexed event as a feed row, or null for kinds the feed does not show. */
export function toActivity(ev: KeeperEvent): ActivityEvent | null {
  const d = ev.data;
  const sym = ev.symbol ?? "";
  const base = {
    id: ev.id,
    ts: ev.ts,
    symbol: ev.symbol ?? undefined,
    signature: ev.signature,
  };
  const row = (
    kind: ActivityKind,
    summary: string,
    detail?: string,
  ): ActivityEvent => ({
    ...base,
    kind,
    summary,
    detail,
  });
  switch (ev.kind) {
    case "PositionOpened": {
      const delta = big(d.size_delta);
      return row(
        "PositionOpened",
        `${delta >= 0n ? "Long" : "Short"} ${shares(delta)} ${sym} at ${usd(big(d.fill_price), { compact: false })}`,
        `by ${short(d.owner)}`,
      );
    }
    case "PositionClosed":
      return row(
        "PositionClosed",
        `Closed ${shares(big(d.reduce_size))} ${sym} at ${usd(big(d.fill_price), { compact: false })}`,
        `P&L ${usdSigned(big(d.realized_pnl), { compact: false })}`,
      );
    case "PositionLiquidated":
      return row(
        "PositionLiquidated",
        `Liquidated ${shares(big(d.size_closed))} ${sym} at ${usd(big(d.mark_price), { compact: false })}`,
        `owner ${short(d.owner)}`,
      );
    case "CollateralDeposited":
      return row(
        "CollateralDeposited",
        `${usd(big(d.amount))} collateral deposited on ${sym}`,
      );
    case "CollateralWithdrawn":
      return row(
        "CollateralWithdrawn",
        `${usd(big(d.amount))} collateral withdrawn from ${sym}`,
      );
    case "LiquidityDeposited":
      return row(
        "LiquidityDeposited",
        `${usd(big(d.amount))} liquidity added to ${sym}`,
      );
    case "LiquidityWithdrawn":
      return row(
        "LiquidityWithdrawn",
        `${usd(big(d.amount))} liquidity withdrawn from ${sym}`,
      );
    case "CorporateActionApplied":
      return row(
        "CorporateActionApplied",
        `${d.numerator}:${d.denominator} split applied to ${sym}`,
      );
    case "SessionChanged":
      return row(
        "SessionChanged",
        `${sym} session ${d.previous} to ${d.current}`,
      );
    case "TreasuryHedgeRebalanced":
      return row(
        "TreasuryHedgeRebalanced",
        `Agent treasury hedge rebalanced`,
        `NAV ${usd(big(d.nav))}`,
      );
    default:
      return null;
  }
}

export function toCorporateAction(ev: KeeperEvent): CorporateAction | null {
  if (ev.kind !== "CorporateActionApplied" || !ev.symbol) return null;
  return {
    ts: ev.ts,
    symbol: ev.symbol,
    numerator: Number(ev.data.numerator),
    denominator: Number(ev.data.denominator),
    priceBefore: big(ev.data.price_before),
    priceAfter: big(ev.data.price_after),
    sequence: Number(ev.data.sequence),
  };
}

export async function fetchEvents(
  limit = 100,
  fetchImpl: typeof fetch = fetch,
): Promise<KeeperEvent[]> {
  const res = await fetchImpl(
    `${KEEPER_URL.replace(/\/$/, "")}/events?limit=${limit}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { events?: KeeperEvent[] };
  return Array.isArray(body.events) ? body.events : [];
}

/** Indexed events, refreshed every thirty seconds. Empty off-chain. */
export function useKeeperEvents(): KeeperEvent[] {
  const [events, setEvents] = useState<KeeperEvent[]>([]);
  useEffect(() => {
    if (!KEEPER_URL || DATA_SOURCE !== "rpc") return;
    let cancelled = false;
    const load = () =>
      fetchEvents()
        .then((e) => !cancelled && setEvents(e))
        .catch(() => {});
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return events;
}
