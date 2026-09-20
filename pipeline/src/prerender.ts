#!/usr/bin/env node
/**
 * Make the registry indexable.
 *
 * # Why this exists
 *
 * The registry's distribution plan is that a link opens straight into the
 * answer and search does the marketing. A client-rendered SPA cannot do that:
 * crawlers that do execute JavaScript do it inconsistently and late, and the
 * ones that matter for a link preview (Slack, Discord, X, iMessage) do not
 * execute any.
 *
 * Rather than adopt a framework for one page, this writes real HTML for each
 * token into the built `dist/`. Each file carries the app exactly as the SPA
 * build produced it, plus per-token metadata and a `<noscript>` summary
 * containing the facts that matter. A crawler gets a real document; a browser
 * gets the app and hydrates over the top.
 *
 *   npx ts-node pipeline/src/prerender.ts
 *
 * Run after `npm run app:build`, and after the snapshot exists.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(ROOT, "app/dist");
const SNAPSHOT = join(ROOT, "app/public/registry.json");
const SITE = process.env.SITE_URL ?? "https://arclis.xyz";

const BACKING_LABEL: Record<string, string> = {
  Redeemable: "Redeemable",
  CustodyBacked: "Custody backed",
  IssuerAttested: "Issuer attested",
  Synthetic: "Synthetic",
};

const REDEMPTION_LABEL: Record<string, string> = {
  AnyHolder: "Any holder",
  VerifiedHolders: "Verified holders",
  AuthorizedParticipants: "Authorized participants",
  None: "Not redeemable",
};

/** Escape for HTML text and attribute contexts. */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Token {
  symbol: string;
  underlying: string;
  name: string;
  issuerId: string;
  backing: string;
  redemption: string;
  custodian: string | null;
  issuerRisk: string;
  dividendTreatment: string;
  mint: {
    mint: string;
    freezeAuthority: string | null;
    mintAuthority: string | null;
  };
  pools: Array<{ venue: string; sellImpactBps: number }>;
}

interface Issuer {
  id: string;
  name: string;
  jurisdiction: string;
  structure: string;
  disclosureUrl: string;
}

function description(token: Token, issuer: Issuer | undefined): string {
  const claim =
    token.backing === "Synthetic"
      ? `${token.symbol} holds no shares. It tracks the price of ${token.underlying}.`
      : `${token.symbol} is a ${BACKING_LABEL[token.backing]?.toLowerCase()} claim on ${token.underlying}` +
        (token.custodian ? `, custodied at ${token.custodian}.` : ".");
  const redeem = `Redemption: ${REDEMPTION_LABEL[token.redemption] ?? token.redemption}.`;
  const who = issuer
    ? ` Issued by ${issuer.name} (${issuer.jurisdiction}).`
    : "";
  return `${claim} ${redeem}${who}`.slice(0, 300);
}

/**
 * The `<noscript>` body.
 *
 * Not a teaser. A crawler, a reader-mode user and anyone on a text browser
 * gets the actual answer: what the claim is, who can redeem, what the mint's
 * authorities allow, and a link to the disclosure. The registry's whole claim
 * is that this information should be easy to get, so it would be absurd to
 * gate it behind a bundle.
 */
function noscript(token: Token, issuer: Issuer | undefined): string {
  const impact = token.pools[0]
    ? `${(token.pools[0].sellImpactBps / 100).toFixed(2)}% on ${esc(token.pools[0].venue)}`
    : "no route found";

  return `
<article>
  <h1>${esc(token.symbol)}: ${esc(token.name)}</h1>
  <p>${esc(description(token, issuer))}</p>
  <dl>
    <dt>References</dt><dd>${esc(token.underlying)}</dd>
    <dt>Claim</dt><dd>${esc(BACKING_LABEL[token.backing] ?? token.backing)}</dd>
    <dt>Who can redeem</dt><dd>${esc(REDEMPTION_LABEL[token.redemption] ?? token.redemption)}</dd>
    <dt>Custodian</dt><dd>${esc(token.custodian ?? "None named")}</dd>
    <dt>Legal structure</dt><dd>${esc(issuer?.structure ?? "Not disclosed")}</dd>
    <dt>Mint</dt><dd>${esc(token.mint.mint)}</dd>
    <dt>Balances can be frozen</dt><dd>${token.mint.freezeAuthority ? "Yes" : "No"}</dd>
    <dt>Supply can be increased</dt><dd>${token.mint.mintAuthority ? "Yes" : "No"}</dd>
    <dt>Cost to sell $25,000</dt><dd>${impact}</dd>
    <dt>Dividends</dt><dd>${esc(token.dividendTreatment)}</dd>
    <dt>If the issuer disappears</dt><dd>${esc(token.issuerRisk)}</dd>
  </dl>
  ${issuer ? `<p><a href="${esc(issuer.disclosureUrl)}">Issuer disclosure</a></p>` : ""}
  <p>Arclis does not custody assets, issue tokenized shares, or provide investment advice.</p>
</article>`.trim();
}

/**
 * Schema.org markup.
 *
 * `FinancialProduct` rather than a made-up type, so a search engine has
 * something it recognises. Deliberately no `Rating` or `Review`: the claim
 * score is not a review, and marking it up as one would invite exactly the
 * league-table reading the scoring is designed to avoid.
 */
function jsonLd(token: Token, issuer: Issuer | undefined): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FinancialProduct",
    name: `${token.symbol} (${token.name})`,
    description: description(token, issuer),
    url: `${SITE}/registry/${token.symbol.toLowerCase()}`,
    ...(issuer
      ? {
          provider: {
            "@type": "Organization",
            name: issuer.name,
            url: issuer.disclosureUrl,
          },
        }
      : {}),
  });
}

function pageFor(
  shell: string,
  token: Token,
  issuer: Issuer | undefined,
): string {
  const title = `${token.symbol}: what you actually own | Arclis`;
  const desc = description(token, issuer);
  const url = `${SITE}/registry/${token.symbol.toLowerCase()}`;

  const head = `
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}" />
    <link rel="canonical" href="${esc(url)}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:url" content="${esc(url)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <script type="application/ld+json">${jsonLd(token, issuer)}</script>`;

  return (
    shell
      // Replace the SPA's own title and description rather than appending, or
      // every page ends up with two of each and crawlers pick arbitrarily.
      .replace(/<title>.*?<\/title>/s, "")
      .replace(/<meta\s+name="description"[^>]*>/s, "")
      .replace("</head>", `${head}\n  </head>`)
      .replace(
        '<div id="root"></div>',
        `<div id="root"></div>\n    <noscript>${noscript(token, issuer)}</noscript>`,
      )
  );
}

function main() {
  if (!existsSync(DIST)) {
    console.error(
      "[prerender] app/dist not found. Run `npm run app:build` first.",
    );
    process.exit(1);
  }
  if (!existsSync(SNAPSHOT)) {
    console.error(
      "[prerender] app/public/registry.json not found. Run `npx ts-node pipeline/src/run.ts` first.",
    );
    process.exit(1);
  }

  const shell = readFileSync(join(DIST, "index.html"), "utf8");
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
    tokens: Token[];
    issuers?: Issuer[];
  };
  const issuers = new Map((snapshot.issuers ?? []).map((i) => [i.id, i]));

  const urls: string[] = [`${SITE}/`];

  for (const token of snapshot.tokens) {
    const slug = token.symbol.toLowerCase();
    const dir = join(DIST, "registry", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.html"),
      pageFor(shell, token, issuers.get(token.issuerId)),
    );
    urls.push(`${SITE}/registry/${slug}`);
    console.log(`[prerender] registry/${slug}/index.html`);
  }

  writeFileSync(
    join(DIST, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join("\n") +
      `\n</urlset>\n`,
  );

  writeFileSync(
    join(DIST, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`,
  );

  console.log(
    `[prerender] ${snapshot.tokens.length} pages, sitemap.xml, robots.txt`,
  );
}

main();
