/**
 * The tokenized-stock registry, built live by the keeper.
 *
 * The registry used to depend on a pipeline script nobody scheduled, so the
 * page always showed its sample dataset. The keeper already holds everything
 * a live build needs (an equity feed, Jupiter access, a clock), so it builds
 * the snapshot itself on a slow schedule and serves it at `/registry`.
 *
 * Three properties matter more than freshness:
 *
 *   - **It never starves the oracle.** Mint reads go to a mainnet endpoint
 *     separate from the devnet publisher, and Jupiter quotes are spaced so
 *     the registry's ladder cannot crowd out the 24/7 price feed sharing the
 *     same rate limit.
 *   - **A failed build keeps the last good one.** A snapshot is replaced only
 *     by one that read at least one token.
 *   - **Every source link is checked** each build, so a document an issuer
 *     moves is reported instead of silently linking nowhere.
 */

import curatedJson from "../../pipeline/curated.json";
import { buildRegistry, type CuratedFile, type RegistrySnapshot } from "../../pipeline/src/build";
import { jupiterRouter } from "../../pipeline/src/depth";
import { accountReader } from "../../pipeline/src/rpc";
import { sessionAt } from "./calendar";
import type { PriceFeed } from "./prices/types";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface RegistryOptions {
  /** The equity feed the oracle already uses, for reference prices. */
  feed: PriceFeed;
  /** A mainnet endpoint: registry mints live on mainnet, the program does not. */
  rpcUrl: string;
  jupiterApiKey?: string;
  /** Least time between two Jupiter quotes. */
  spacingMs?: number;
  curated?: CuratedFile;
  /** Injected for tests. */
  build?: typeof buildRegistry;
  log?: (level: "info" | "warn", message: string, extra?: unknown) => void;
}

export class RegistryService {
  private snapshot: RegistrySnapshot | null = null;
  private lastError: string | null = null;
  private building = false;
  private readonly curated: CuratedFile;

  constructor(private readonly options: RegistryOptions) {
    this.curated = options.curated ?? (curatedJson as CuratedFile);
  }

  current(): RegistrySnapshot | null {
    return this.snapshot;
  }

  /** For `/health`: how old the snapshot is and what it is missing. */
  status() {
    const s = this.snapshot;
    return {
      generatedAt: s?.generatedAt ?? null,
      tokens: s?.tokens.length ?? 0,
      failures: s?.failures.map((f) => `${f.symbol}: ${f.reason}`) ?? [],
      deadLinks:
        s?.issuers.flatMap((i) =>
          [
            i.links.disclosure?.ok === false ? i.disclosureUrl : null,
            i.links.attestation?.ok === false ? i.attestationUrl : null,
          ].filter(Boolean),
        ) ?? [],
      lastError: this.lastError,
    };
  }

  async refresh(): Promise<void> {
    // A slow build must not overlap the next tick and double the quote rate.
    if (this.building) return;
    this.building = true;
    const log = this.options.log ?? (() => {});
    try {
      const build = this.options.build ?? buildRegistry;
      const next = await build({
        curated: this.curated,
        getAccount: accountReader(this.options.rpcUrl),
        router: jupiterRouter({
          apiKey: this.options.jupiterApiKey,
          spacingMs: this.options.spacingMs ?? 3_000,
        }),
        quoteMint: USDC_MINT,
        referencePrices: (symbols) => this.referencePrices(symbols),
        log,
      });
      if (next.tokens.length === 0) {
        this.lastError = "build read no tokens; keeping the previous snapshot";
        log("warn", "registry build read no tokens", { failures: next.failures });
        return;
      }
      this.snapshot = next;
      this.lastError = null;
      log("info", "registry built", {
        tokens: next.tokens.length,
        failures: next.failures.length,
      });
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err);
      log("warn", "registry build failed", { message: this.lastError });
    } finally {
      this.building = false;
    }
  }

  private async referencePrices(symbols: string[]) {
    const session = sessionAt(Math.floor(Date.now() / 1000));
    const quotes = symbols.length ? await this.options.feed.quote(symbols) : [];
    return new Map(
      quotes.map((q) => [
        q.symbol.toUpperCase(),
        { price: q.price, at: q.printedAt, session: q.halted ? "Halted" : session },
      ]),
    );
  }
}
