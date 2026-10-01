# The tokenized-equity registry

A public, non-custodial lookup for what a tokenized stock on Solana actually
is. No wallet, no sign-in, no execution.

## The gap it fills

Solana now carries the large majority of tokenized-equity trading volume and
roughly two hundred thousand holders. Four issuer families are live, and their
products are structurally different in ways that do not show up anywhere a
holder looks:

| Token | Issuer | What it actually is |
|---|---|---|
| `AAPLx` | xStocks (Backed Assets (JE) Limited) | A tracker certificate, collateralised 1:1, redeemable by verified holders |
| `AAPLon` | Ondo Global Markets (BVI SPV) | A note backed 1:1 by shares at US broker-dealers, open only to eligible non-US investors |
| `SPCX` | Backpack Securities | A security entitlement to a SpaceX share at a US broker-dealer, redeemable by verified holders |
| `OPENAI` | PreStocks | Exposure to SPVs holding pre-IPO OpenAI shares; no share is owned and none can be redeemed |

All four render as a line going up and to the right. No issuer publishes the
comparison, and the venues that list them have no reason to.

## What it reports

Four things, kept separate on purpose. There is no combined score, no ranking
that mixes them, and no "buy" number. They are different risks, and collapsing
them into one figure is how a transparency product becomes a league table, and
a league table is a thing issuers pay to move.

### 1. Claim strength (0 to 100)

Built from four components, each published with its own bar and its own
sentence so the number can be argued with rather than trusted:

| Component | Max | What it measures |
|---|---|---|
| Claim | 40 | Redeemable, custody backed, issuer attested, or synthetic |
| Redemption | 25 | Any holder, verified holders, authorized participants, or nobody |
| Independent attestation | 25 | Continuous, daily, monthly, quarterly, or none |
| Named custodian | 10 | Whether there is anybody to ask |

Two rules the scoring follows:

- **Nothing is penalised for being what it says it is.** A disclosed synthetic
  scores low on *claim* because it is a weaker claim. It is not additionally
  penalised for dishonesty, because it was not dishonest.
- **A regulator cannot buy score.** A regulated wrapper around an unredeemable
  token is still unredeemable. The licence is reported in the structure line
  and adds zero points, because the moment a licence moves a number the badge
  scheme has become pay-to-rank.

### 2. NAV deviation, against the market calendar

The signed gap between the on-chain price and the reference stock, in basis
points, judged against what the reference venue is doing:

| Reference session | Tolerance | Why |
|---|---|---|
| Open | 50 bps | An arbitrageur can close this in one block, so a wide gap is real |
| PreOpen | 150 bps | Indications are moving; the token may front-run the print |
| Closed | 300 bps | The reference is frozen and the token is not. Most of the gap is the clock |
| Halted | not measurable | There is no reference price worth the name |

This is the same session matrix the perpetual engine enforces on-chain
(`programs/arclis/src/math/session.rs`), applied to a different question. It is
the part most price trackers get wrong: flagging a 90 bps gap at 2am Sunday as
a mispricing trains people to ignore the flag.

Past roughly 5% the verdict stops being "premium" and becomes **dislocated**: a
gap that wide usually means redemption is not working, not that the stock
moved.

### 3. Exit liquidity, measured as impact

Ranked by **price impact on a real sell**, not by TVL. A $10m pool that is 95%
one-sided will not let you out, and TVL will happily tell you it is the deepest
venue. Total pooled liquidity is reported beside the impact as context, never
in place of it.

Alongside it, **exit coverage**: pooled quote liquidity as a percentage of the
circulating value at the reference price (at the pool price, for a token with
no listed share). It matters most for tokens whose only exit is selling.

### 4. What the mint can do to your balance

Freeze authority, mint authority and Token-2022 extensions, read from the chain
rather than from the issuer. **Reported, never scored.** A freeze authority on
a regulated security token is required by the regulation; the same authority on
a token marketed as permissionless is a different fact entirely. The page's job
is to make sure the holder knows it is there, and the structure column beside
it says which case they are in.

## Where the numbers come from

| Field | Source |
|---|---|
| Mint authorities, supply, extensions | `getAccountInfo(mint)` on mainnet, parsed |
| Pool depth and sell impact | Jupiter `/swap/v1/quote`, a ladder of sell sizes |
| On-chain price | The best executable sell, per share |
| Reference price and session | The same equity feed the oracle reads; none for a private company |
| Structure, custody, redemption rights | `pipeline/curated.json`, checked against the issuer's documents |

Only the last needs a human, which is why it carries its sources: every issuer
has a documents link and a home page, and `checkedAt` records when the facts
were last checked. Where a fact could not be confirmed it says so: an
attestation schedule Arclis has not verified is shown as **not yet verified**
and scores zero, which is different from "none".

Three checks keep a live row honest:

- **Display multipliers.** Issuers that reinvest dividends or apply splits
  through Token-2022's Scaled UI amount extension leave raw balances alone, so
  one raw unit is worth the multiplier in shares. Supply and price are converted
  to shares before anything is compared.
- **Wrong-mint guard.** A token trading more than 50% away from the stock it is
  filed under is left out and reported, not scored: that is a mint pasted
  against the wrong ticker, not a premium.
- **Link checks.** Every documents link is fetched on each build. A page that is
  gone is reported on `/health`, and the interface sends readers to the
  issuer's home page instead. A site that refuses an automated visitor (401,
  403, 429) is not reported as broken.

## Current state

The keeper builds the registry every 30 minutes (`keeper/src/registry.ts`) and
serves it at `/registry`. The interface reads that first, then an optional
static `registry.json` written by `npm run registry:build`, and otherwise falls
back to a bundled dataset. The fallback carries the same curated facts (a test
holds them in step with `curated.json`) but sample market numbers, and the
interface labels it as sample data whenever it is shown.

| Setting (keeper) | Default | Purpose |
|---|---|---|
| `REGISTRY_ENABLED` | on | `no` turns the build off |
| `REGISTRY_RPC_URL` | public mainnet | Mainnet endpoint for mint reads; separate from the devnet publisher |
| `REGISTRY_INTERVAL_MS` | 1,800,000 | Time between builds |
| `JUPITER_API_KEY` | none | Shared with the 24/7 feed; quotes are spaced 3 s apart either way |

To add a token, add it to `pipeline/curated.json` and to the fallback in
`app/src/lib/registry/data.ts`; the tests fail until the two agree.

## Why it lives inside Arclis

The obvious objection is that a neutral registry should not sit inside a
trading venue. Two answers.

The technical one: the registry's central metric is NAV deviation, and NAV
deviation is meaningless without knowing whether the reference venue is open.
That is the same session logic the perpetual engine enforces on-chain, and
building it twice would mean maintaining two definitions of "is this price safe
to act on".

The product one: what has to stay separate is *endorsement*, not code. A
registry row linking to an Arclis market is a cross-reference, and a low claim
score does not remove the link. Arclis does not issue, custody or market any of
the tokens it reports on, which is the only neutrality that actually matters,
and it is structural rather than promised.

## Files

```
pipeline/
  curated.json    issuer facts and mints, with sources and a check date
  src/build.ts    one snapshot: curated facts, read live, links checked
  src/assemble.ts mint reads, depth, prices, multiplier and wrong-mint guard
keeper/src/
  registry.ts     the scheduled build behind GET /registry
app/src/lib/registry/
  types.ts        the read model; scales, tiers, and the ordered BACKING_RANK
  scoring.ts      every number on the page: deviation, claim, liquidity, control
  data.ts         the bundled fallback and the RegistrySource seam
  live.ts         keeper first, then a static snapshot, then the fallback
app/src/screens/
  Registry.tsx    the lookup and the per-token detail sheet
app/src/styles/
  registry.css    its own stylesheet; denser and more editorial than the app
```

## The assistant

`server/assistant.ts` puts Claude in front of the scoring above, with **tools
rather than a prompt full of pasted numbers**. `lookup_token` calls the same
`assessBacking` / `assessDeviation` / `assessLiquidity` functions this page
renders, so the assistant and the page cannot disagree. The model does
language; the scoring does arithmetic; the arithmetic is the part with tests.

It answers the question the registry exists for and a holder cannot answer
themselves: *what am I actually holding, and should this number worry me?* It
refuses to give investment advice, says when a price gap is the clock rather
than a mispricing, and says plainly when it has no data.

The API key lives on the server. Anything prefixed `VITE_` is compiled into the
JavaScript every visitor downloads, so a key there is a published key. With no
key configured the endpoint returns 503 and the interface does not render the
assistant at all, rather than rendering one that fails.

### The Clawpump tool

`list_launches` is the third tool and the one that is not obvious. Clawpump is
where a token launches, Meteora's DBC is what it launches on, and Arclis already
builds DBC configs whose **quote token is a tokenized stock**: contributors pay
in AAPLx rather than SOL.

So a stock-quoted launch inherits the backing of the thing people are paying in.
Raising into a redeemable, custodied certificate is materially different from
raising into a token with no claim on a share, and on a price chart those are
identical. Contributors cannot see it and the launchpad has no reason to show
it.

The tool resolves each launch's quote token to its registry entry and returns
that token's own backing tier and claim score alongside the launch. Clawpump to
Meteora to the registry, and the answer at the end is one only a neutral party
holding both datasets can give.

See `server/README.md` for deployment.
