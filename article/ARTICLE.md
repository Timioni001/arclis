# Arclis: public equities on Solana, with the rules that make them equities

*Built for the Stocklana hackathon. Live on Solana devnet at
[arclis.timioni1490.workers.dev](https://arclis.timioni1490.workers.dev).
Source at [github.com/Timioni001/arclis](https://github.com/Timioni001/arclis).*

---

## The short version

Tokenized stocks now trade on Solana, and they are moving faster than the
tools around them. Arclis is two pieces of infrastructure for that market:

1. **A registry** that discloses what each tokenized stock is actually backed
   by: its legal structure, its custody, its redemption rights, who controls
   the mint, and how much of it you could sell before the price moves.
2. **A perpetual futures engine** that treats a stock as a stock. It knows when
   the US market is closed or halted, applies splits and dividends on chain,
   and bounds every oracle update.

Built on the perpetuals engine, **hedged treasuries** let an AI agent that
earns its revenue in a tokenized stock short the matching perpetual and keep
the dollar value of its runway steady.

---

## The problem

### A ticker is not a claim

On a brokerage account, "AAPL" means one thing. On-chain it can mean several.
Some tokenized equities are issued against shares held by a regulated
custodian and carry a redemption path. Others are notes against an issuer.
Others simply track a price feed and hold nothing. In a wallet or on a DEX
screener they look identical: a ticker, a logo, a price.

The difference matters most at the moment someone needs it: when the issuer
pauses redemptions, when a mint authority is used, or when a holder tries to
exit a position larger than the pool can absorb.

### DeFi assumes an asset that never sleeps

Almost every on-chain derivative was designed for crypto assets, which trade
24 hours a day, 7 days a week, never halt, and never split. Equities do all
three:

- **Market hours.** The underlying trades roughly 6.5 hours a day, five days a
  week. Outside those hours there is no reference price, only a stale one.
  A perpetual that keeps accepting new leverage against a stale price is
  offering free options to whoever knows Monday's open first.
- **Halts.** A regulatory halt freezes the underlying. A venue that keeps
  trading through it is pricing blind.
- **Corporate actions.** A 4:1 split cuts the share price by 75%. A system that
  does not know about the split sees a crash and liquidates everyone long.

Tokenized stocks inherit all of these properties. The infrastructure around
them mostly does not.

---

## What Arclis does

### 1. The Registry

A public lookup for tokenized equities on Solana. No wallet, no sign-in. For
each token, Arclis shows:

- **Legal structure and custody**: who holds the underlying, and what the
  holder's claim actually is.
- **Redemption rights**: whether a holder can turn the token back into the
  share or its cash value, and who is eligible.
- **Mint and freeze authorities**, read directly from the chain: who can issue
  more, and who can freeze a holder's balance.
- **NAV deviation**: how far the token trades from the underlying.
- **Exit depth**: how much can be sold before the price moves, measured from
  live Jupiter quotes rather than quoted liquidity figures.

The dataset is built by a pipeline in the repository that reads mint accounts,
token-2022 extensions and Jupiter routes, so the numbers are reproducible.

### 2. The perpetuals engine

An Anchor program running cash-settled perpetual futures on **15 markets**:
AAPL, NVDA, MSFT, TSLA, GOOGL, AMZN, META, AVGO, PLTR, AMD, COIN, HOOD, MSTR,
SPY and QQQ. Prices are oracle-driven; there is no order book. Each market has
a liquidity pool that takes the other side of net open interest and earns
fees, funding and trader losses in return.

What makes it an *equity* perpetual is enforced on chain:

- **Sessions.** Every oracle carries a session state: pre-open, open, closed or
  halted. Instructions that increase risk are refused unless the market is
  open. Instructions that reduce risk (closing, adding margin) stay available,
  so nobody is trapped in a position over a weekend.
- **Corporate actions.** Splits and cash dividends are applied through
  cumulative indices. Positions are normalised lazily the next time they are
  touched, so a split costs one account write per position, not a migration.
- **Oracle safety.** Every update is bounded by staleness, by confidence, and
  by a **10% maximum move per update**. A bad print cannot move the mark
  price by more than that in one step.
- **Solvency.** Losses follow an explicit waterfall: the trader's collateral,
  then the insurance fund, then LP capital, then recorded bad debt. The order
  is written into the program and visible on chain.
- **Custody.** Funds are program-owned. The protocol authority can pause a
  market and nothing else; **no instruction moves user funds to an address the
  authority chooses.**

The program has **28 instructions**. A keeper publishes prices and session
state from market data every 20 seconds, cranks funding, liquidates
underwater positions and rebalances agent hedges.

### 3. Hedged treasuries for AI agents

AI agents are launching tokens and earning creator fees. ClawPump launches an
agent's token on a Pump.fun bonding curve, and it can quote that curve in a
tokenized stock instead of SOL: **79 stocks and ETFs** are available as
quote assets. The agent's creator fees then accrue in that stock.

That creates a treasury problem. An agent paid in NVDA has a runway that moves
with NVDA. Arclis solves it with a treasury account on chain:

1. The agent deposits its stock into its Arclis treasury.
2. The treasury posts margin and **shorts the matching perpetual**.
3. A permissionless rebalancer keeps the short sized to the holding. The keeper
   runs it every five minutes, but anyone can.

The stock and the short offset each other, so the treasury's dollar value
holds while the agent keeps earning. The Treasuries screen shows each
treasury's holding, hedge, drift from target and NAV per token.

---

## The interface

- **Charts** built on TradingView Lightweight Charts, combining years of daily
  history for the underlying with the live on-chain oracle price as the
  rightmost bar. Timeframes from one hour to the full listing history.
- **Daily change** measured against the previous session's close, not
  against whenever the page was opened.
- **Sign-in** with any Wallet Standard wallet (Phantom, Solflare, Backpack),
  the Solana Mobile Wallet Adapter on Android, or a passkey account with no
  seed phrase.
- **Every transaction is simulated against current chain state before the
  wallet is asked to sign.** A refused order produces a readable reason and no
  signature.
- **A devnet faucet**: any wallet can request test USDC and a little SOL for
  fees directly from the interface, so anyone can trade without contacting
  the team.

---

## Engineering

| Component | What it is |
|---|---|
| Program | Rust / Anchor, 28 instructions, deployed on Solana devnet |
| Keeper | TypeScript daemon on Fly.io: prices, sessions, funding, liquidation, hedge rebalancing, market data, faucet |
| Interface | React and TypeScript on Cloudflare; reads the program directly and builds transactions in the browser |
| Registry pipeline | Mint authorities, token extensions and Jupiter exit depth |
| Agent tooling | ClawPump launch CLI and Meteora Dynamic Bonding Curve configuration |

More than **600 automated tests** cover the program's math, an integration
suite against a local validator, the keeper, the registry pipeline and the
interface.

---

## What it is not, yet

Honesty about limits is part of the design:

- **Devnet only.** Mainnet requires a third-party audit, Pyth price feeds in
  place of the keeper's oracle key, and legal review.
- **Oracle trust.** Prices come from a single keeper key, bounded by the checks
  above. Pyth removes that assumption.
- **Gap risk.** A large move across a market close can exceed the insurance
  fund before liquidation is possible. The waterfall makes the outcome ordered
  and visible; it does not prevent it.
- **Two clusters.** ClawPump launches run on mainnet and the treasury program
  on devnet, so an agent cannot yet be hedged end to end.

## What comes next

1. Pyth price feeds.
2. An event indexer for corporate actions, activity and volume.
3. A third-party audit.
4. A mainnet deployment of the treasury program, so ClawPump agents can be
   hedged end to end.

---

## Try it

- **Demo:** [arclis.timioni1490.workers.dev](https://arclis.timioni1490.workers.dev)
- **Code:** [github.com/Timioni001/arclis](https://github.com/Timioni001/arclis)
- **Program (devnet):** `BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP`

Open the Registry without a wallet. Open any market to see its chart, session
state and order ticket. Connect a devnet wallet, request test USDC, and place
a trade.

*Arclis is experimental software on a test network. Nothing here is an offer
of securities or investment advice.*
