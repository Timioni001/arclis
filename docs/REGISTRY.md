# The tokenized-equity registry

A public, non-custodial lookup for what a tokenized stock on Solana actually
is. No wallet, no sign-in, no execution.

## The gap it fills

Solana now carries the large majority of tokenized-equity trading volume and
roughly two hundred thousand holders. Four issuer families are live, and their
products are structurally different in ways that do not show up anywhere a
holder looks:

| What it looks like | What it can actually be |
|---|---|
| A token called `AAPLx` | A certificate you can redeem for a share through a named custodian |
| A token called `AAPL` | A note issued by an SPV that holds shares you personally cannot demand |
| A token called `AAPL` | An exchange IOU where the issuer and the custodian are the same balance sheet |
| A token called `preOPENAI` | A price tracker holding nothing at all |

All four render as a line going up and to the right. None of the four issuers
publishes the comparison, because the comparison is not flattering to everyone
on it, and the venues that list them have no reason to: ambiguity keeps volume
flowing.

One issuer's break has already made the gap public. What made it legible after
the fact was on-chain the whole time. Nobody was looking, because nobody
published the ratio.

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
circulating value at the reference price. This is the ratio that would have
made the PreStocks break visible in advance.

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
| Mint authorities, supply, extensions | `getAccountInfo(mint)`, parsed |
| Pool depth and sell impact | Jupiter `/quote` at several sizes |
| On-chain price | The deepest pool's mid |
| Reference price and session | The same equity feed Arclis reads |
| Structure, custody, redemption rights | The issuer's own disclosure, linked on every row |

Only the last one needs a human, which is why it is the one with a link beside
it. Every issuer row carries a `disclosureUrl` and the tests assert it, because
a claim with no link is not checkable.

## Current state

The shipped dataset is **modelled, not live**, and the interface says so on
every screen that renders it, in a banner that cannot be dismissed. Shipping
modelled data as if it were live would be precisely the failure this product is
about.

`RegistrySource` in `app/src/lib/registry/data.ts` is the seam a real pipeline
implements. Its `kind` field is what drives the banner: a source that cannot
say where its numbers came from does not get to render without a label.

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
app/src/lib/registry/
  types.ts        the read model; scales, tiers, and the ordered BACKING_RANK
  scoring.ts      every number on the page: deviation, claim, liquidity, control
  data.ts         the modelled dataset and the RegistrySource seam
  scoring.test.ts 32 tests, including that the score breakdown sums to the score
app/src/screens/
  Registry.tsx    the lookup and the per-token detail sheet
app/src/styles/
  registry.css    its own stylesheet; denser and more editorial than the app
```
