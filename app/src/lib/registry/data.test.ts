/**
 * The fallback dataset tells the same story as the live registry.
 *
 * The keeper builds the live page from `pipeline/curated.json`; this app ships
 * a copy of the same issuer facts for when the keeper is unreachable. If the
 * two ever disagreed, the page would say one thing about a token while live
 * and another while degraded, which is the failure this registry exists to
 * catch in others.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHECKED_AT, ISSUERS, TOKENIZED_STOCKS } from "./data";

const curated = JSON.parse(
  readFileSync(
    new URL("../../../../pipeline/curated.json", import.meta.url),
    "utf8",
  ),
) as {
  checkedAt: string;
  issuers: Array<Record<string, unknown>>;
  tokens: Array<Record<string, unknown>>;
};

const ISSUER_FACTS = [
  "id",
  "name",
  "issuingEntity",
  "jurisdiction",
  "structure",
  "regulator",
  "website",
  "disclosureUrl",
  "attestationUrl",
  "attestation",
] as const;

const TOKEN_FACTS = [
  "symbol",
  "underlying",
  "referenceSymbol",
  "name",
  "issuerId",
  "backing",
  "redemption",
  "custodian",
  "dividendTreatment",
  "corporateActionPolicy",
  "issuerRisk",
  "arclisSymbol",
] as const;

describe("fallback dataset", () => {
  it("carries the curated check date", () => {
    expect(CHECKED_AT).toBe(curated.checkedAt);
  });

  it("matches the curated issuer facts field for field", () => {
    expect(ISSUERS.map((i) => i.id)).toEqual(curated.issuers.map((i) => i.id));
    for (const issuer of ISSUERS) {
      const source = curated.issuers.find((i) => i.id === issuer.id)!;
      for (const key of ISSUER_FACTS) {
        expect(issuer[key], `${issuer.id}.${key}`).toEqual(source[key]);
      }
    }
  });

  it("matches the curated token facts and mints", () => {
    expect(TOKENIZED_STOCKS.map((t) => t.symbol)).toEqual(
      curated.tokens.map((t) => t.symbol),
    );
    for (const token of TOKENIZED_STOCKS) {
      const source = curated.tokens.find((t) => t.symbol === token.symbol)!;
      for (const key of TOKEN_FACTS) {
        expect(token[key], `${token.symbol}.${key}`).toEqual(source[key]);
      }
      expect(token.mint.mint, `${token.symbol}.mint`).toBe(source.mint);
    }
  });
});

describe("curated list", () => {
  it("files every token under an issuer that exists", () => {
    const ids = new Set(curated.issuers.map((i) => i.id));
    for (const t of curated.tokens)
      expect(ids.has(t.issuerId as string)).toBe(true);
  });

  it("uses real-looking mint addresses, never placeholders", () => {
    // Base58, 32 to 44 characters, and none of the `…1111111` padding that
    // marked the old invented rows.
    for (const t of curated.tokens) {
      const mint = t.mint as string;
      expect(mint, t.symbol as string).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(mint, t.symbol as string).not.toMatch(/1{8,}/);
    }
  });

  it("files no mint twice", () => {
    const mints = curated.tokens.map((t) => t.mint);
    expect(new Set(mints).size).toBe(mints.length);
  });

  it("links every issuer to an https source and a home page", () => {
    for (const i of curated.issuers) {
      expect(i.disclosureUrl as string).toMatch(/^https:\/\//);
      expect(i.website as string).toMatch(/^https:\/\//);
    }
  });
});
