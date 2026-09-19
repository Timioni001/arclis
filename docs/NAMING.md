# On changing the name

## What "Stocklana" costs you

It is a clear name — Stock + Solana, instantly parseable. Three problems, in
descending order of seriousness:

**1. It contradicts the product.** The README's own positioning is "a
general-purpose engine, not hardcoded to stocks", and `create_market` is
permissionless over any oracle. The name asserts the opposite. Right now the
only thing in this repository that is stock-specific *is the name* — the Rust
crate is already called `perp_engine`.

**2. It advertises the regulatory exposure.** Per `FEASIBILITY.md`, the strongest
recommendation is to run this on crypto or FX first and treat tokenized equities
as a later, jurisdiction-scoped phase. A name with "stock" in it makes that pivot
read as a retreat rather than a plan, and puts the most legally loaded word in
the project at the top of every page — including for anyone screening it.

**3. `-lana` is a crowded, dated suffix.** Solana-derived names were a 2021–22
convention and now read as chain-locked and of their moment. It also ties the
brand to one chain, which is a real cost if this ever deploys elsewhere.

## What a rename costs

Very little, which is the good news, and the reason to decide now rather than
later:

- The Rust crate is `perp_engine` — already brand-neutral.
- The program ID does not encode the name.
- The on-chain seeds (`config`, `oracle`, `market`, `vault`, `position`) do not
  encode the name.

A rename touches the repository name, the README, `package.json`, and the docs.
It does not touch a single line of program logic. That stops being true the
moment you have a deployed frontend, a domain, or users.

## Candidates

Each is checked against: says what the thing does, survives the pivot to other
assets, not obviously taken in this space, and pronounceable by someone reading
it aloud at a demo.

### Contango — strongest pick

A futures term: the state where forward price sits above spot. Immediately
signals *derivatives* to anyone in the field, signals nothing about which
underlying, and is a real word with no chain lock-in. Sounds like a venue rather
than a toy.

Risk: it names a market condition that is not specifically what the protocol
does, and it is a recognisable enough term that some variant is probably in use
somewhere. Check before committing.

### Datum — strongest if you want to lead on the oracle design

A datum is the fixed reference point everything else is measured from. That is
precisely the architecture: every position is valued against an oracle price,
and the whole design follows from having one reference rather than an order
book. Short, clean, unhyphenated, easy to say.

Risk: fairly generic as a word; harder to defend as a trademark.

### Skew — names the actual mechanism

The funding rate here is driven by open-interest skew, which is a genuinely
distinctive design choice and the one thing a technical audience will ask about.
Short, memorable, and it makes the mechanism the brand.

Risk: "skew" is established terminology in derivatives analytics and has been
used as a product name before; the collision is adjacent rather than direct, but
diligence it.

### Continuum — leans on "perpetual"

Perpetuals have no expiry; a continuum has no breaks. Elegant fit, no chain
lock-in, sounds like infrastructure.

Risk: abstract enough that it does not tell anyone what you do. Needs a tagline
carrying the weight.

### If you want to keep continuity with "Stocklana"

**Lana Markets** keeps the sound people already associate with the project,
drops the "stock", and drops the explicit Solana tie. Weakest option on
distinctiveness, but the cheapest if the name already has any recognition
attached to it.

## Recommendation

**Contango**, with **Datum** as the alternate if you would rather lead on the
oracle-priced architecture than on the derivatives category.

Either way, decide before the frontend and the domain exist. Before committing,
do the boring checks — domain, the handle on whichever platforms matter, a
trademark search in your jurisdiction, and a scan of DefiLlama and the Solana
program registry for a protocol already using it.

And whatever you pick: leave the crate named `perp_engine`. Keeping the code's
internal name generic and the brand separate is what made this rename cheap, and
it is worth preserving for the next one.
