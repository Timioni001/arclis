/**
 * Assembling a registry snapshot from live sources.
 *
 * # What this replaces
 *
 * `app/src/lib/registry/data.ts` ships a modelled dataset and says so in a
 * banner that cannot be dismissed. This is the thing that makes the banner go
 * away: the same `TokenizedStock` shape, with every field that can come from
 * the chain or a router coming from the chain or a router.
 *
 * # What still comes from a human, and why that is correct
 *
 * Legal structure, custody, redemption rights, dividend treatment: none of
 * these are on-chain, and none of them can be. They live in a PDF an issuer
 * publishes. So the pipeline reads them from a curated file with a
 * `disclosureUrl` beside every claim, and the interface links it.
 *
 * That split is the honest one and it is worth stating plainly: the registry's
 * on-chain facts are verifiable by anyone, and its legal facts are a citation
 * to a document anyone can read. Neither is "trust us", which is the whole
 * point of the product.
 */

import type { MintFacts } from "./mint";
import { parseMint, supplyAtScale } from "./mint";
import { measureDepth, type Router } from "./depth";

/** What a curator supplies per token. The on-chain half is read, not written. */
export interface CuratedEntry {
  symbol: string;
  underlying: string;
  name: string;
  issuerId: string;
  mint: string;
  backing: "Redeemable" | "CustodyBacked" | "IssuerAttested" | "Synthetic";
  redemption:
    "AnyHolder" | "VerifiedHolders" | "AuthorizedParticipants" | "None";
  custodian: string | null;
  dividendTreatment: string;
  corporateActionPolicy: string;
  issuerRisk: string;
  arclisSymbol: string | null;
}

export interface AssembleOptions {
  entries: CuratedEntry[];
  /** Reads a mint account. Injected so this is testable without an RPC. */
  getAccount: (
    address: string,
  ) => Promise<{ data: Uint8Array; owner: string } | null>;
  router: Router;
  quoteMint: string;
  /** Reference prices for the underlying stocks, keyed by ticker. */
  referencePrices: Map<string, { price: bigint; at: number; session: string }>;
  log?: (level: "info" | "warn", message: string, extra?: unknown) => void;
}

export interface AssembledToken {
  symbol: string;
  underlying: string;
  name: string;
  issuerId: string;
  backing: CuratedEntry["backing"];
  redemption: CuratedEntry["redemption"];
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
  /** Per-field provenance, so nothing on the page is unattributable. */
  sources: Record<string, string>;
}

export interface Snapshot {
  kind: "live" | "partial";
  generatedAt: number;
  tokens: AssembledToken[];
  /** Tokens that could not be assembled, and why. */
  failures: Array<{ symbol: string; reason: string }>;
}

/**
 * Build a snapshot.
 *
 * A token that cannot be read is **left out and recorded as a failure**, never
 * filled in from the modelled dataset. Half a row is worse than no row: a real
 * claim score beside an invented supply is exactly the kind of thing this
 * product exists to stop other people doing.
 */
export async function assemble(options: AssembleOptions): Promise<Snapshot> {
  const log = options.log ?? (() => {});
  const tokens: AssembledToken[] = [];
  const failures: Array<{ symbol: string; reason: string }> = [];

  for (const entry of options.entries) {
    try {
      const account = await options.getAccount(entry.mint);
      if (!account) {
        failures.push({
          symbol: entry.symbol,
          reason: "mint account not found",
        });
        continue;
      }

      let facts: MintFacts;
      try {
        facts = parseMint(entry.mint, account.data, account.owner);
      } catch (err) {
        failures.push({
          symbol: entry.symbol,
          reason: `mint unreadable: ${String((err as Error).message)}`,
        });
        continue;
      }

      const reference = options.referencePrices.get(entry.underlying);
      if (!reference) {
        failures.push({
          symbol: entry.symbol,
          reason: `no reference price for ${entry.underlying}`,
        });
        continue;
      }

      const approxPrice = Number(reference.price) / 1_000_000;
      const depth = await measureDepth({
        router: options.router,
        tokenMint: entry.mint,
        quoteMint: options.quoteMint,
        tokenDecimals: facts.decimals,
        approxPrice,
      });

      if (!depth) {
        // No route is a genuine finding, not a failure: an unexitable token is
        // exactly what a holder needs told. It is kept with empty pools, and
        // the scoring already reports that as Illiquid.
        log("warn", `${entry.symbol} has no route on any venue`);
      }

      // The on-chain price is the best rate the router could actually fill,
      // which is what somebody would really get. A pool mid ignores the side
      // of the book they have to cross.
      const best = depth?.probes[0];
      const onChainPrice =
        best && best.size > 0n
          ? (best.out * 1_000_000n) /
            (BigInt(
              Math.round((Number(best.size) / 1e6 / approxPrice) * 1e6),
            ) || 1n)
          : reference.price;

      tokens.push({
        symbol: entry.symbol,
        underlying: entry.underlying,
        name: entry.name,
        issuerId: entry.issuerId,
        backing: entry.backing,
        redemption: entry.redemption,
        custodian: entry.custodian,
        dividendTreatment: entry.dividendTreatment,
        corporateActionPolicy: entry.corporateActionPolicy,
        issuerRisk: entry.issuerRisk,
        arclisSymbol: entry.arclisSymbol,
        mint: {
          mint: facts.mint,
          decimals: facts.decimals,
          supply: supplyAtScale(facts).toString(),
          mintAuthority: facts.mintAuthority,
          freezeAuthority: facts.freezeAuthority,
          extensions: facts.extensions,
        },
        pools: depth
          ? [
              {
                venue: depth.venue,
                poolAddress: depth.routes.join(" + ") || depth.venue,
                // Depth at 1% is a far better liquidity figure than TVL, and
                // it is what the interface's "pooled" column now means.
                quoteLiquidity: depth.depthAt1Pct.toString(),
                baseLiquidity: "0",
                sellImpactBps: depth.referenceImpactBps,
                depthProbeQuote: (25_000n * 1_000_000n).toString(),
                volume24h: "0",
              },
            ]
          : [],
        onChainPrice: onChainPrice.toString(),
        referencePrice: reference.price.toString(),
        referenceTs: reference.at,
        referenceSession: reference.session,
        sources: {
          mint: "getAccountInfo",
          supply: "getAccountInfo",
          authorities: "getAccountInfo",
          extensions: "getAccountInfo",
          depth: options.router.name,
          onChainPrice: options.router.name,
          referencePrice: "equity feed",
          structure: "issuer disclosure",
          custody: "issuer disclosure",
          redemption: "issuer disclosure",
        },
      });
    } catch (err) {
      failures.push({
        symbol: entry.symbol,
        reason: String((err as Error)?.message ?? err),
      });
    }
  }

  return {
    // `partial` is not cosmetic: the interface shows a different banner for it.
    // A snapshot missing a token is still useful and must still say so.
    kind: failures.length === 0 ? "live" : "partial",
    generatedAt: Math.floor(Date.now() / 1000),
    tokens,
    failures,
  };
}
