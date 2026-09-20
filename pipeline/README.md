# The registry pipeline

Turns the modelled dataset into a live one.

```bash
npm run registry:build       # writes app/public/registry.json
npm run app:build
npm run registry:prerender   # writes dist/registry/<token>/index.html + sitemap
```

## The split between read and curated

Two kinds of fact, held apart on purpose.

**Read from the chain or a router, every run:** supply, mint authority, freeze
authority, Token-2022 extensions, exit depth, exit impact, and the price a
holder would actually fill at.

**Curated in `curated.json`, with a `disclosureUrl` beside each claim:** legal
structure, custody, redemption rights, dividend treatment. None of these are
on-chain and none of them can be. They live in a PDF an issuer publishes.

That split is the product's honesty claim in one sentence: the on-chain facts
are verifiable by anyone, and the legal facts are a citation to a document
anyone can read. Neither is "trust us".

## Depth is measured, not read

Every other dashboard reports TVL. TVL is the wrong number: a $10m pool that is
95% one-sided will not let you out, and a $400k balanced pool will.

So `depth.ts` quotes a **ladder** of real sells, $1k, $5k, $25k, $100k, $250k
- and measures the degradation from the best rate on the ladder. A single probe
hides the shape of the book: a token can look fine at $1,000 and be untradeable
at $50,000, and the holder who matters is the one with $50,000.

Two details that are easy to get wrong and are tested:

- **The sell side.** Token in, quote out, which is the direction a holder
  leaves in. Pools are frequently asymmetric and the side that is easy to enter
  is often the side that is hard to leave.
- **Impact against the ladder's best rate**, not against an oracle. Comparing
  to a reference price would fold the token's NAV deviation into its liquidity
  score, and those are two separate risks the registry reports separately.

## Mint parsing is by hand

`@solana/spl-token` will decode a mint, but not usefully surface the
extensions, and the extensions are the part that matters most: a transfer hook
or a permanent delegate is a power over a holder's balance that no price chart
shows and no disclosure is obliged to mention. `mint.ts` walks the TLV directly
and separates housekeeping extensions (a metadata pointer) from ones with power
over a balance (a permanent delegate, a transfer hook, a pause authority).

17 tests against hand-built buffers, because byte offsets are the kind of thing
that looks right and is off by four.

## A token that cannot be read is left out

Not filled in from the modelled dataset. Ever. A real claim score beside an
invented supply is exactly what this registry exists to stop other people
doing, so a failure is recorded with a reason, the snapshot is marked
`partial`, and the interface names what is missing.

The app applies the same rule in the other direction: a snapshot that is
absent, malformed, or older than six hours falls back to the modelled dataset
and its banner. A failed pipeline degrades to a clearly-labelled demo, never to
an empty page and never to stale numbers presented as current.

**`app/public/registry.json` is gitignored.** A committed snapshot is a
recording shipping as live data.

## Prerendering

The registry's distribution plan is that a link opens into the answer and
search does the marketing. A client-rendered SPA cannot do that: link
unfurlers (Slack, Discord, X, iMessage) run no JavaScript at all.

`prerender.ts` writes a real HTML file per token into `dist/`, carrying the
same app bundle plus per-token metadata, JSON-LD, and a `<noscript>` block with
the full answer: the claim, who can redeem, the custodian, the legal structure,
whether balances can be frozen, what a $25,000 sell costs, and a link to the
disclosure. Plus a sitemap and robots.txt.

The JSON-LD is `FinancialProduct` and deliberately carries no `Rating` or
`Review`. The claim score is not a review, and marking it up as one would
invite exactly the league-table reading the scoring is built to avoid.
