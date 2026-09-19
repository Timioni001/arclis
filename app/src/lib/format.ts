/**
 * The display boundary.
 *
 * Protocol values are `bigint` at fixed scales. Users think in shares, dollars
 * and percent. Every conversion happens here and nowhere else, so there is one
 * place to check when a number looks wrong.
 *
 * DESIGN.md §36: raw protocol integer scales are never shown as the primary
 * user-facing representation.
 */

import { BASE_SCALE, PRICE_SCALE, QUOTE_SCALE, BPS_SCALE } from "./protocol/math";

function toNumber(value: bigint, scale: bigint): number {
  // Split before converting so large values keep their precision: the integer
  // part can exceed Number.MAX_SAFE_INTEGER on its own for a big treasury.
  const whole = value / scale;
  const frac = value % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

export const toQuote = (v: bigint) => toNumber(v, QUOTE_SCALE);
export const toShares = (v: bigint) => toNumber(v, BASE_SCALE);
export const toPrice = (v: bigint) => toNumber(v, PRICE_SCALE);
export const toBps = (v: bigint) => Number(v) / Number(BPS_SCALE);

/** `$168.16`. Compacts to `$2.4M` past a million unless `compact` is false. */
export function usd(value: bigint | number, opts: { compact?: boolean; dp?: number } = {}): string {
  const n = typeof value === "bigint" ? toQuote(value) : value;
  const { compact = true, dp } = opts;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";

  if (compact && abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (compact && abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;

  const decimals = dp ?? (abs < 1 ? 4 : 2);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Signed dollars, always with an explicit `+` or `-`. */
export function usdSigned(value: bigint | number, opts?: { compact?: boolean }): string {
  const n = typeof value === "bigint" ? toQuote(value) : value;
  const body = usd(Math.abs(n), opts);
  return n < 0 ? `-${body}` : `+${body}`;
}

/** `2.50 shares`, or `2.50` when the unit is shown elsewhere. */
export function shares(value: bigint, opts: { unit?: boolean; dp?: number } = {}): string {
  const n = toShares(value);
  const { unit = false, dp = 2 } = opts;
  const body = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
  const signed = n < 0 ? `-${body}` : body;
  return unit ? `${signed} ${Math.abs(n) === 1 ? "share" : "shares"}` : signed;
}

/** `+1.24%`. Always signed, because colour alone must never carry the sign. */
export function pct(value: number, dp = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toFixed(dp)}%`;
}

/** Basis points as a percentage: `500n` -> `5.00%`. */
export function bpsToPct(value: bigint | number, dp = 2): string {
  const n = typeof value === "bigint" ? toBps(value) : value / 10_000;
  return `${(n * 100).toFixed(dp)}%`;
}

/** Unsigned percent for gauges and ratios. */
export function pctPlain(value: number, dp = 1): string {
  return `${value.toFixed(dp)}%`;
}

export function leverage(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}×`;
}

/** `12s ago`, `2m 18s ago`, `3h ago`. */
export function ago(ts: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.floor(now - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem ? `${m}m ${rem}s ago` : `${m}m ago`;
  }
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** `18h 24m` — for cooldowns counting down. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return "ready";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** `Monday · 09:30 ET` — when the venue next opens. */
export function sessionOpensAt(ts: number): string {
  const d = new Date(ts * 1000);
  const day = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/New_York",
  });
  return `${day} · ${time} ET`;
}

/** `7x4F...92A` */
export function shortAddress(address: string, lead = 4, tail = 3): string {
  if (address.length <= lead + tail + 3) return address;
  return `${address.slice(0, lead)}...${address.slice(-tail)}`;
}

/** Oracle confidence as a readability score: a tighter band is higher. */
export function confidencePct(price: bigint, confidence: bigint): number {
  if (price === 0n) return 0;
  const ratio = Number(confidence) / Number(price);
  return Math.max(0, Math.min(100, (1 - ratio) * 100));
}
