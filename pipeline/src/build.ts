/**
 * One registry snapshot: curated facts, read live, with every source link
 * checked.
 *
 * Shared by the keeper, which rebuilds it on a schedule and serves it at
 * `/registry`, and by `run.ts`, which writes it to a file. One definition of
 * what a snapshot is, so the two cannot drift.
 */

import { assemble, type CuratedEntry, type Snapshot } from "./assemble";
import type { Router } from "./depth";
import { checkLink, type LinkCheck } from "./links";
import type { AccountReader } from "./rpc";

export interface CuratedIssuer {
  id: string;
  name: string;
  issuingEntity?: string;
  jurisdiction: string;
  structure: string;
  regulator: string | null;
  website?: string;
  disclosureUrl: string;
  attestationUrl: string | null;
  attestation: string;
}

export interface CuratedFile {
  checkedAt?: string;
  issuers: CuratedIssuer[];
  tokens: CuratedEntry[];
}

export interface RegistrySnapshot extends Snapshot {
  issuers: Array<
    CuratedIssuer & {
      checkedAt?: string;
      links: { disclosure?: LinkCheck; attestation?: LinkCheck };
    }
  >;
}

export interface BuildOptions {
  curated: CuratedFile;
  getAccount: AccountReader;
  router: Router;
  quoteMint: string;
  /** Prices for listed tickers, keyed upper-case. */
  referencePrices: (
    symbols: string[],
  ) => Promise<Map<string, { price: bigint; at: number; session: string }>>;
  /** Injected for tests; the real check fetches each URL. */
  checkLink?: (url: string) => Promise<LinkCheck>;
  log?: (level: "info" | "warn", message: string, extra?: unknown) => void;
}

export async function buildRegistry(options: BuildOptions): Promise<RegistrySnapshot> {
  const { curated } = options;
  const check = options.checkLink ?? ((url: string) => checkLink(url));

  const listed = [
    ...new Set(
      curated.tokens
        .map((t) => (t.referenceSymbol === undefined ? t.underlying : t.referenceSymbol))
        .filter((s): s is string => !!s)
        .map((s) => s.toUpperCase()),
    ),
  ];
  const prices = await options.referencePrices(listed);

  const snapshot = await assemble({
    entries: curated.tokens,
    getAccount: options.getAccount,
    router: options.router,
    quoteMint: options.quoteMint,
    referencePrices: prices,
    log: options.log,
  });

  // Each distinct URL once, in turn: a handful of requests, none in a hurry.
  const checked = new Map<string, LinkCheck>();
  const urls = curated.issuers.flatMap((i) =>
    [i.disclosureUrl, i.attestationUrl].filter((u): u is string => !!u),
  );
  for (const url of new Set(urls)) checked.set(url, await check(url));
  for (const [url, result] of checked) {
    if (result.ok === false) {
      options.log?.("warn", "registry source link is unreachable", { url, status: result.status });
    }
  }

  return {
    ...snapshot,
    issuers: curated.issuers.map((issuer) => ({
      ...issuer,
      checkedAt: curated.checkedAt,
      links: {
        disclosure: checked.get(issuer.disclosureUrl),
        attestation: issuer.attestationUrl ? checked.get(issuer.attestationUrl) : undefined,
      },
    })),
  };
}
