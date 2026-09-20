/**
 * Loading a live registry snapshot, with the modelled dataset as the floor.
 *
 * `pipeline/src/run.ts` writes `public/registry.json` on a schedule. This
 * fetches it and, if it is there and readable, becomes the source. If it is
 * absent, stale beyond usefulness, or malformed, the modelled dataset stands
 * and the interface keeps saying so.
 *
 * The fallback direction matters: a failed pipeline degrades to a page that is
 * clearly labelled a demo, never to an empty page or, worse, to live-looking
 * numbers that stopped being live on Tuesday.
 */

import type { RegistrySource } from "./data";
import { ISSUERS, modelledRegistry, TOKENIZED_STOCKS } from "./data";
import type { Issuer, TokenizedStock } from "./types";
import type { MarketSession } from "../protocol/types";

/**
 * How old a snapshot may be before it is treated as absent.
 *
 * Six hours. The pipeline is expected to run far more often than that, so this
 * only trips when it has been failing for a while, which is exactly when the
 * interface should stop claiming its numbers are live.
 */
const MAX_AGE_SECS = 6 * 60 * 60;

interface RawToken {
  symbol: string;
  underlying: string;
  name: string;
  issuerId: string;
  backing: TokenizedStock["backing"];
  redemption: TokenizedStock["redemption"];
  custodian: string | null;
  dividendTreatment: string;
  corporateActionPolicy: string;
  issuerRisk: string;
  arclisSymbol: string | null;
  mint: {
    mint: string;
    decimals: number;
    supply: string;
    mintAuthority: string | null;
    freezeAuthority: string | null;
    extensions: string[];
  };
  pools: Array<{
    venue: string;
    poolAddress: string;
    quoteLiquidity: string;
    baseLiquidity: string;
    sellImpactBps: number;
    depthProbeQuote: string;
    volume24h: string;
  }>;
  onChainPrice: string;
  referencePrice: string;
  referenceTs: number;
  referenceSession: string;
  sources?: Record<string, string>;
}

interface RawSnapshot {
  kind: "live" | "partial";
  generatedAt: number;
  tokens: RawToken[];
  failures?: Array<{ symbol: string; reason: string }>;
  issuers?: Issuer[];
}

const SESSIONS: MarketSession[] = ["Open", "Closed", "PreOpen", "Halted"];

function toSession(raw: string): MarketSession {
  // An unrecognised session is treated as Halted, which permits nothing. That
  // is the right default for a value the interface does not understand.
  return (SESSIONS.find((s) => s === raw) ?? "Halted") as MarketSession;
}

/** The JSON carries bigints as strings; the read model wants bigints. */
function hydrate(raw: RawToken): TokenizedStock {
  return {
    symbol: raw.symbol,
    underlying: raw.underlying,
    name: raw.name,
    issuerId: raw.issuerId,
    backing: raw.backing,
    redemption: raw.redemption,
    custodian: raw.custodian,
    dividendTreatment: raw.dividendTreatment,
    corporateActionPolicy: raw.corporateActionPolicy,
    issuerRisk: raw.issuerRisk,
    arclisSymbol: raw.arclisSymbol,
    mint: {
      mint: raw.mint.mint,
      decimals: raw.mint.decimals,
      supply: BigInt(raw.mint.supply),
      mintAuthority: raw.mint.mintAuthority,
      freezeAuthority: raw.mint.freezeAuthority,
      extensions: raw.mint.extensions,
    },
    pools: raw.pools.map((p) => ({
      venue: p.venue,
      poolAddress: p.poolAddress,
      quoteLiquidity: BigInt(p.quoteLiquidity),
      baseLiquidity: BigInt(p.baseLiquidity),
      sellImpactBps: p.sellImpactBps,
      depthProbeQuote: BigInt(p.depthProbeQuote),
      volume24h: BigInt(p.volume24h),
    })),
    onChainPrice: BigInt(raw.onChainPrice),
    referencePrice: BigInt(raw.referencePrice),
    referenceTs: raw.referenceTs,
    referenceSession: toSession(raw.referenceSession),
  };
}

export interface LiveRegistry extends RegistrySource {
  /** Tokens the pipeline could not assemble, and why. Shown, not hidden. */
  failures: Array<{ symbol: string; reason: string }>;
}

/**
 * Fetch the snapshot, or fall back.
 *
 * Never throws. Every failure path ends at the modelled registry, because an
 * interface that renders nothing when its data pipeline hiccups is worse than
 * one that renders a clearly-labelled demo.
 */
export async function loadRegistry(
  fetchImpl: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1000),
): Promise<LiveRegistry> {
  const fallback = (): LiveRegistry => ({
    ...modelledRegistry(),
    failures: [],
  });

  try {
    const response = await fetchImpl("/registry.json", {
      headers: { accept: "application/json" },
      cache: "no-cache",
    });
    if (!response.ok) return fallback();

    const raw = (await response.json()) as RawSnapshot;
    if (!Array.isArray(raw.tokens) || raw.tokens.length === 0)
      return fallback();

    // A snapshot old enough to mislead is worse than no snapshot.
    if (!raw.generatedAt || now - raw.generatedAt > MAX_AGE_SECS)
      return fallback();

    let tokens: TokenizedStock[];
    try {
      tokens = raw.tokens.map(hydrate);
    } catch {
      // A malformed row means the whole snapshot is suspect: the pipeline
      // writes it atomically, so a bad field is a bug rather than a blip.
      return fallback();
    }

    const issuers = raw.issuers?.length ? raw.issuers : ISSUERS;

    return {
      kind: "live",
      issuers: () => issuers,
      stocks: () => tokens,
      stock: (symbol) =>
        tokens.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase()),
      asOf: () => raw.generatedAt,
      failures: raw.failures ?? [],
    };
  } catch {
    // Offline, blocked, CORS, malformed JSON. All the same answer.
    return fallback();
  }
}

/** Exported for the tests, so the fallback path can be asserted on. */
export const MODELLED_TOKEN_COUNT = TOKENIZED_STOCKS.length;
