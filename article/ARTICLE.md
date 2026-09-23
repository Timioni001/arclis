# Arclis: public equities on Solana, with the rules that make them equities

*Built for the Stocklana hackathon. Live on Solana devnet.*
*Demo: [arclis.timioni1490.workers.dev](https://arclis.timioni1490.workers.dev) | [arclistrade.world](https://arclistrade.world)*
*Code: [github.com/Timioni001/arclis](https://github.com/Timioni001/arclis)*

---

## Who it is for

Every protocol claims to serve "users". Arclis was designed around five
specific people, and each part of it exists because one of them needed it.

### 1. The holder who wants to know what they own

Maya buys a token called AAPL on a Solana DEX. It has the Apple logo, it
tracks Apple's price, and her wallet shows it next to her SOL. What she does
not know is whether that token is a claim on a real share held by a
custodian, a note against an issuer's balance sheet, or a price tracker that
holds nothing at all. She also does not know whether someone can mint more of
it tomorrow, whether her balance can be frozen, or how much of it she could
sell before the price falls.

**With Arclis**, Maya opens the Registry, with no wallet or sign-in, and
reads it in one screen: the legal structure, the custodian, whether and how
she can redeem, who holds the mint and freeze authorities, how far the token
trades from the real share price, and how much she could actually sell,
measured from live Jupiter quotes.

### 2. The trader who wants equity exposure with leverage, safely

Daniel wants to go long NVDA into an earnings week, with leverage, from a
Solana wallet. Existing on-chain perpetuals would let him, but they would also
let him and everyone else keep trading NVDA at 3 a.m. on a Sunday against a
price that has not moved since Friday's close. Whoever knows where Monday
opens is trading against a stale price, and the liquidity pool pays for it.

**With Arclis**, Daniel trades an NVDA perpetual whose program knows the US
market's session. While the market is open he can open, add to and close
positions. When it closes, the program refuses new risk but lets him reduce
or close, so he is never locked in. If NVDA splits, his position is
normalised on chain rather than liquidated by a price that appears to crash.

### 3. The liquidity provider who wants to know what they are underwriting

Priya has idle USDC and is looking for a return. She is wary of anything
labelled "yield", because it usually hides what is being sold.

**With Arclis**, Priya deposits into the NVDA market's pool and the screen is
explicit about what she holds: the pool is the counterparty to net trader
open interest. Her return is fees, funding and trader losses; her risk is
trader profits and the market direction the pool is exposed to. Withdrawals
have a cooldown and a utilisation cap, both shown before she deposits. If
losses exceed a trader's collateral, the program applies an explicit
waterfall: the trader's collateral, then the insurance fund, then LP capital,
then recorded bad debt.

### 4. The AI agent whose revenue is paid in a stock

An autonomous agent launches its token through ClawPump. ClawPump can quote
the launch curve in a tokenized stock instead of SOL, so the agent's creator
fees arrive in, say, SPY. That is useful: the agent is paid in an asset
people understand. It is also a problem, because the agent's runway, the
money it spends on compute and services, now rises and falls with the S&P
500.

**With Arclis**, the agent deposits its SPY into an on-chain treasury. The
treasury posts margin and shorts the SPY perpetual. The stock and the short
offset each other, so the treasury's dollar value holds steady while the
agent keeps earning. A rebalancer keeps the hedge sized to the holding;
anyone can run it, and the Arclis keeper does so every five minutes.

### 5. The builder who needs honest equity primitives

A developer building a portfolio app, a lending market or a structured
product on tokenized stocks needs two things the ecosystem does not provide:
reliable metadata about what each token is, and a derivative that behaves
like an equity derivative. Arclis provides both as open infrastructure: a
reproducible registry pipeline and an on-chain program whose rules can be
read, tested and built on.

---

## What is new about it

Tokenized stocks, perpetual futures and AI agents all exist on Solana
already. What Arclis adds is the set of rules that make them fit together
correctly.

### Market hours as an on-chain rule, not an interface warning

Most venues that list equity exposure either stop the interface when the
market closes (the chain keeps accepting transactions) or keep trading
around the clock. Arclis puts the session on the oracle account itself:
pre-open, open, closed or halted. Every instruction declares whether it
increases or reduces risk, and the program checks the session before running
it. No interface, bot or direct transaction can open new leverage while the
market is closed.

### Corporate actions applied, not ignored

A 4:1 split makes the share price fall by 75% overnight. To a perpetual that
does not know about it, that is a crash, and every long is liquidated. Arclis
applies splits and cash dividends through cumulative indices stored on
chain. Each position records the index it was opened at, and is normalised
the next time it is touched. A split costs one write per position, spread
over time, and nobody is liquidated by an accounting event.

### Oracle updates with bounds

Every price update is checked for staleness and confidence, and **no single
update may move the price by more than 10%**. A faulty data source cannot
teleport the mark price and trigger mass liquidations in one transaction.

### Disclosure as infrastructure

The Registry turns questions that normally need a prospectus and a block
explorer into a single reproducible dataset: legal structure, custody,
redemption rights, authorities, token extensions, NAV deviation and exit
depth. It is built by a pipeline in the repository, so anyone can re-run it
and check the result.

### A hedge designed for agents

Agent treasuries connect an agent paid in a tokenized stock directly to a
perpetual that hedges it, on chain, with a permissionless rebalancer so the
hedge does not depend on the agent's own infrastructure staying online.

### Custody the authority cannot touch

User funds are held by the program. The protocol authority can pause a
market and nothing else. There is **no instruction that moves user funds to
an address the authority chooses**, and the complete list of its powers is
one short file in the repository.

---

## The problem, in more detail

### A ticker is not a claim

On a brokerage account, "AAPL" means one thing. On-chain it can mean several.
Some tokenized equities are issued against shares held by a regulated
custodian and carry a redemption path for eligible holders. Others are
structured notes against an issuer. Others simply track a price feed. In a
wallet or on a DEX screener they look identical: a ticker, a logo, a price.

The difference matters at the moment it is tested: when an issuer pauses
redemptions, when a mint authority is used, or when a holder tries to exit a
position larger than the available liquidity.

### DeFi assumes an asset that never sleeps

On-chain derivatives were designed for crypto assets, which trade
continuously, never halt and never split. US equities trade about 6.5 hours a
day, five days a week; they halt on news and volatility; they split, pay
dividends and restructure. Tokenized stocks inherit all of these properties.
Until now, the infrastructure around them did not.

---

## How Arclis works

### The Registry

A public lookup, no wallet required. For each tokenized equity:

| Field | Source |
|---|---|
| Legal structure, custodian, redemption rights | Issuer documentation, reviewed |
| Mint and freeze authorities | Read from the mint account on chain |
| Token extensions (Token-2022) | Read from chain |
| NAV deviation | Token price against the underlying share |
| Exit depth | Measured from live Jupiter quotes at increasing sizes |

### The perpetuals engine

An Anchor program running cash-settled perpetual futures on **15 markets**:
AAPL, NVDA, MSFT, TSLA, GOOGL, AMZN, META, AVGO, PLTR, AMD, COIN, HOOD, MSTR,
SPY and QQQ.

- **Pricing.** Oracle-priced; no order book. A keeper publishes each
  market's price and session every 20 seconds from market data.
- **Counterparty.** Each market has a liquidity pool that takes the other side
  of net open interest, with a utilisation cap and a withdrawal cooldown.
- **Funding.** Accrues hourly on skew and utilisation, cranked
  permissionlessly.
- **Liquidation.** Permissionless, with a liquidator reward, an insurance cut
  and the loss waterfall described above.
- **Sessions, corporate actions, oracle bounds and custody** as described in
  the previous section.

The program has **28 instructions**, covering markets, positions, liquidity
pools, the insurance fund, oracles, corporate actions and agent treasuries.

### Agent treasuries

1. **Launch.** The agent's token is launched through ClawPump on a Pump.fun
   curve quoted in one of **79 tokenized stocks and ETFs**. A creator fee of
   1% to 3% of volume accrues in that stock, 75% of which is paid to the
   agent's wallet.
2. **Deposit.** The agent deposits the stock into its Arclis treasury.
3. **Hedge.** The treasury posts margin and shorts the matching perpetual.
4. **Rebalance.** A permissionless instruction resizes the short when the
   holding changes beyond a tolerance band.
5. **Report.** The Treasuries screen shows each treasury's holding, hedge,
   drift from target and NAV per agent token.

Fifteen of the 79 launchable stocks have an Arclis market today, and the
interface marks which ones can be hedged.

### The keeper

A single TypeScript service on Fly.io that operates the deployment:

- publishes prices and sessions;
- cranks funding;
- liquidates underwater positions;
- rebalances agent hedges;
- indexes program events for the activity feed and corporate-action log;
- serves years of daily price history for the charts;
- runs a rate-limited devnet faucet for test USDC.

Its health endpoint reports whether each loop is running rather than whether
prices are fresh, because a closed market publishing nothing is correct
behaviour, not a failure.

### The interface

- **Charts** on TradingView Lightweight Charts, combining years of daily
  history for the underlying with the live on-chain oracle price as the
  newest bar, across timeframes from one hour to the full listing history.
- **Daily change** measured against the previous session's close.
- **Sign-in** with Phantom, Solflare, Backpack or any Wallet Standard wallet,
  the Solana Mobile Wallet Adapter on Android, or a passkey account with no
  seed phrase.
- **Simulation before signature.** Every transaction is simulated against
  current chain state before the wallet opens. A refused order produces a
  readable reason and no signature.
- **Self-service test funds.** Any devnet wallet can request test USDC and a
  little SOL for fees from inside the app.
- **Live activity** from the keeper's event indexer: trades, closes,
  liquidations, liquidity flows, splits and hedge rebalances.

---

## Engineering

| Component | Stack |
|---|---|
| Program | Rust, Anchor 0.30, Solana devnet |
| Keeper | TypeScript on Fly.io |
| Interface | React and TypeScript on Cloudflare |
| Registry pipeline | TypeScript; mint accounts, Token-2022 extensions, Jupiter quotes |
| Agent tooling | ClawPump partner API; Meteora Dynamic Bonding Curve configuration |

More than **600 automated tests** cover the program's math, an integration
suite against a local validator, the keeper, the registry pipeline, the
ClawPump tooling and the interface. CI runs formatting, Clippy, the unit
tests and the full Anchor build.

---

## Limits, stated plainly

- **Devnet only.** Mainnet requires a third-party audit, Pyth price feeds in
  place of the keeper's oracle key, and legal review.
- **Oracle trust.** Prices come from a single keeper key, bounded by the
  checks above. Pyth removes that assumption.
- **Gap risk.** A large move across a market close can exceed the insurance
  fund before liquidation is possible. The waterfall makes the outcome
  ordered and visible; it does not prevent it.
- **Two clusters.** ClawPump launches run on mainnet and the treasury program
  on devnet, so an agent cannot yet be hedged end to end.
- **Unsupported corporate actions.** Mergers, spin-offs and delistings are
  not handled.

---

## Roadmap

1. Pyth price feeds.
2. A persistent event store with volume and P&L history.
3. A third-party security audit.
4. Mainnet deployment of the treasury program, so ClawPump agents can be
   hedged end to end.
5. More markets, following the Registry's coverage of tokenized equities.

---

## Try it

1. Open [arclis.timioni1490.workers.dev](https://arclis.timioni1490.workers.dev) | [arclistrade.world](https://arclistrade.world).
2. Browse the **Registry**. No wallet needed.
3. Open any market to see its chart, session and order ticket.
4. Connect a devnet wallet, press **Get test USDC**, and place a trade while
   the US market is open.
5. Open **Treasuries** to see an agent treasury and its hedge.

**Program (devnet):** `BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP`

*Arclis is experimental software on a test network. Nothing here is an offer
of securities or investment advice.*
