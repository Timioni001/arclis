# Name

**Arclis**: *On-chain access to public markets.*

Decided. This document records what was chosen and why, so the reasoning does
not have to be reconstructed later.

## The name

Previously "Stocklana" (Stock + Solana). Three problems with it, all now moot:

1. It contradicted the product. The engine takes an oracle, not a ticker;
   nothing on-chain is equity-specific. The name asserted the opposite.
2. It put the most legally loaded word in the project at the top of every page.
3. `-lana` tied the brand to one chain and read as a 2021 convention.

**Arclis** carries none of that. Short, pronounceable, no chain lock-in, and it
does not box the product into equities if indices, ETFs or commodities follow.

## The tagline

**Primary: "On-chain access to public markets."**

*Access* is the honest verb. Arclis is the access layer, the oracle, the
sessions, the corporate actions, the hedging and the launch tooling, not the
venue where price is discovered. "The on-chain market for stocks" claims to *be*
the market, which would be an overclaim while price comes from an external
oracle. "Public markets" also survives the product extending past single
equities, where "stocks" would not.

**Variant: "Public markets, built on Solana."**

For Solana-ecosystem contexts, the hackathon submission, ecosystem directories,
anywhere naming the chain is the point rather than a constraint.

Rejected: *"Stocks, reimagined on-chain"* ("reimagined" says nothing),
*"Bringing global equities on-chain"* (weaker gerund), *"The on-chain market for
stocks"* (overclaims, see above).

## What the rename touched

The on-chain program crate is now `arclis`, not `perp_engine`. That was a
judgement call: the earlier advice in this file was to keep the crate
brand-neutral so a rename stayed cheap, and while the program was only a perp
engine that was right. It is no longer only a perp engine, it carries the
equity calendar, agent treasuries and the liquidity pool, so `perp_engine`
described a subset and `arclis` describes the program.

Unchanged: the program ID, and every PDA seed (`config`, `oracle`, `market`,
`vault`, `position`, `treasury`, `lp_pool`). Seeds are deliberately generic, so
the name is not baked into any address.

## Still to do

- Rename the GitHub repository (owner action; the clone URL changes).
- Check the domain, the handle on whichever platforms matter, and run a
  trademark search in your jurisdiction before the name goes on anything
  printed or signed.
