/**
 * Clawpump: watching stock-quoted launches.
 *
 * # The use case, concretely
 *
 * Clawpump is where a token launches. Meteora's Dynamic Bonding Curve is what
 * it launches on. Arclis already builds DBC configs whose **quote token is a
 * tokenized stock** (`src/dbc/`), which is the interesting part: contributors
 * pay in AAPLx rather than SOL, and the treasury that results is long one
 * company's earnings.
 *
 * That creates a risk nobody currently surfaces. If a launch is quoted in a
 * tokenized stock, then **the launch inherits that stock token's backing**. A
 * project raising into a redeemable, custodied certificate is in a different
 * position from one raising into a synthetic tracker that holds nothing, and
 * on a price chart the two look identical. Contributors cannot see the
 * difference, and the launchpad has no reason to show it.
 *
 * Arclis can, because it already scores those instruments. So the integration
 * is not "display Clawpump's feed". It is: **pull the launches, resolve each
 * one's quote token to its registry entry, and publish the backing strength of
 * the thing people are paying in.** That is a judgement only a neutral party
 * holding both datasets can make, and it is the same reason the registry
 * exists.
 *
 * # State of this file
 *
 * The API shape below is the adapter's own, not Clawpump's. The developer docs
 * at clawpump.tech/developers were not reachable from the environment this was
 * written in, so `parseLaunches` is isolated as the single function to change
 * once the real response shape is known, and everything else is written
 * against `Launch`. With no key configured this returns an empty list and the
 * interface says the feed is not connected, which is the same honesty rule the
 * registry follows: no invented data, ever.
 */

export interface Launch {
  /** The launching token. */
  symbol: string;
  name: string;
  mint: string;
  /** The token contributors pay in. The point of the whole integration. */
  quoteSymbol: string;
  quoteMint: string;
  /** Raised so far, in quote units. */
  raised: number;
  /** Unix seconds. */
  launchedAt: number;
  url: string | null;
}

const BASE_URL = process.env.CLAWPUMP_BASE_URL ?? "https://api.clawpump.tech";
const API_KEY = process.env.CLAWPUMP_API_KEY;

export function isConfigured(): boolean {
  return Boolean(API_KEY);
}

/**
 * The one function to rewrite against the real API.
 *
 * Written defensively because it parses a response shape that has not been
 * seen: every field is coerced, every missing field has a default, and a row
 * that cannot produce a symbol is dropped rather than rendered as `undefined`.
 */
export function parseLaunches(payload: unknown): Launch[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray((payload as { launches?: unknown })?.launches)
        ? (payload as { launches: unknown[] }).launches
        : [];

  const out: Launch[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const symbol = String(r.symbol ?? r.ticker ?? r.tokenSymbol ?? "").trim();
    if (!symbol) continue;

    out.push({
      symbol,
      name: String(r.name ?? r.tokenName ?? symbol),
      mint: String(r.mint ?? r.tokenMint ?? r.address ?? ""),
      quoteSymbol: String(
        r.quoteSymbol ??
          r.quoteTicker ??
          (r.quote as Record<string, unknown>)?.symbol ??
          "",
      ),
      quoteMint: String(
        r.quoteMint ?? (r.quote as Record<string, unknown>)?.mint ?? "",
      ),
      raised: Number(r.raised ?? r.raisedAmount ?? 0) || 0,
      launchedAt:
        Number(r.launchedAt ?? r.createdAt ?? 0) ||
        Math.floor(Date.parse(String(r.created_at ?? "")) / 1000) ||
        0,
      url: typeof r.url === "string" ? r.url : null,
    });
  }
  return out;
}

/**
 * Fetch recent launches, keeping only the stock-quoted ones.
 *
 * Returns an empty array rather than throwing when the feed is unconfigured or
 * unreachable. The assistant and the interface both treat empty as "no data",
 * which is true, and neither of them invents a fallback.
 */
export async function listLaunches(limit = 10): Promise<Launch[]> {
  if (!API_KEY) return [];

  try {
    const response = await fetch(
      `${BASE_URL}/v1/launches?limit=${Math.min(50, Math.max(1, limit))}`,
      {
        headers: {
          authorization: `Bearer ${API_KEY}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return [];
    return parseLaunches(await response.json()).filter((l) => l.quoteSymbol);
  } catch {
    // A launchpad being down must never take the assistant down with it.
    return [];
  }
}
