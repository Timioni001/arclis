# Stocklana submission: copy for each field

Copy each block into the matching field on hackathons.solana.com.

## Step 1: Project Info

**Project Name**

```
Arclis
```

**Short Description** (254/280)

```
Arclis brings public equities on-chain with integrity. A registry discloses what each tokenized stock on Solana is backed by, and an oracle-priced perpetuals engine respects market hours, halts, splits and dividends, with hedged treasuries for AI agents.
```

**Full Description (Markdown)** (2993/5000)

```markdown
## The problem

Tokenized stocks are among the fastest-growing assets on Solana, but two things are missing. Holders cannot easily tell what a given token represents: a redeemable claim on a share, a note against custody they cannot reach, or a tracker holding nothing. And the DeFi primitives around them assume an asset that trades around the clock, never halts and never splits. A stock does all three.

## What Arclis does

**Registry.** A public lookup for every tokenized equity on Solana. For each token it shows the legal structure, custody, redemption rights, mint authorities, NAV deviation and real exit depth measured from Jupiter quotes. No wallet is required.

**Perpetuals engine.** An Anchor program for cash-settled perpetual futures on 15 equities and ETFs (AAPL, NVDA, MSFT, TSLA, SPY, QQQ and more), with equity mechanics enforced on chain:

- Trading sessions: risk-increasing orders are refused while the US market is closed or halted.
- Corporate actions: splits and cash dividends are applied through cumulative indices, so a 4:1 split is not a 75% loss.
- Price safety: oracle updates are bounded by staleness, confidence and a 10% per-update deviation cap.
- Solvency: each market has an LP pool as counterparty and an explicit loss waterfall (collateral, insurance, LP capital, recorded bad debt).
- Custody: program-owned. The authority can pause markets and nothing else.

**Agent treasuries.** An AI agent can launch its token through ClawPump on a Pump.fun curve quoted in a tokenized stock rather than SOL, earning creator fees in that stock. Its Arclis treasury then shorts the matching perpetual, so its runway holds its dollar value. Rebalancing is permissionless and cranked by the keeper.

## How it works

- **Program:** 28 instructions in Rust/Anchor, deployed on devnet.
- **Keeper:** publishes live prices and sessions from Finnhub, cranks funding, liquidates, rebalances treasury hedges, and serves price history for the charts.
- **Interface:** React and TypeScript. Wallet Standard sign-in (Phantom, Solflare, Backpack, and Mobile Wallet Adapter on Android) or a passkey account with no seed phrase. Every order is simulated against the chain before the wallet is asked to sign. Charts use TradingView Lightweight Charts, combining years of daily history with the live oracle price.
- **Meteora DBC tooling:** configuration and monitoring for bonding-curve pools quoted in a tokenized stock.

## Built with

Solana, Anchor, Meteora Dynamic Bonding Curve, ClawPump, Jupiter, TradingView Lightweight Charts, Fly.io and Cloudflare.

## Status

Live on devnet with 15 markets and prices updating in real time. More than 600 automated tests across the program, keeper and interface. Not audited, and devnet only by design: mainnet requires Pyth price feeds, an audit and legal review.

## Try it

Open the demo, browse the Registry without a wallet, then open any market to see its chart, session state and order ticket. The README documents the full architecture.
```

## Step 2: Links

| Field | Value |
|---|---|
| GitHub Repository | https://github.com/Timioni001/arclis |
| Demo URL | https://arclis.timioni1490.workers.dev (switch to https://arclistrade.world once it is live) |
| Pitch Video URL | your YouTube or Loom link (the product walkthrough) |
| Technical Video URL | your YouTube or Loom link (the code and architecture walkthrough) |

## Before pressing Submit

1. The GitHub repository is **public**, or judges cannot open it.
2. `main` contains the latest work (`git merge --ff-only origin/claude/quirky-faraday-tls27g && git push`), CI is green, and Cloudflare has redeployed.
3. `fly deploy` has run, and https://arclis-keeper.fly.dev/health shows `"ok": true`.
4. The Helius and Finnhub keys pasted in chat have been regenerated and set with `fly secrets set`.
5. Videos are set to **unlisted or public**, not private.
6. Open the demo in a private window and click through Registry, a market, and Treasuries once, as a judge would.

## Suggested video outlines

**Pitch video (2 to 3 minutes)**

1. The problem: tokenized stocks on Solana look identical but are not; DeFi ignores market hours, halts and splits.
2. The Registry: look up a token and read its backing, custody and exit depth.
3. A market: the chart with years of history and the live price, the session badge, the order ticket.
4. A trade on devnet: review, simulate, sign, and the position appearing.
5. Agent treasuries: launch against a stock on ClawPump, hedge on Arclis.
6. Close: live on devnet with 15 markets; next steps are Pyth, an audit, mainnet.

**Technical video (3 to 5 minutes)**

1. Repository layout (README "Components" table).
2. The program: sessions, split normalisation, the loss waterfall (`programs/arclis/src/math/`).
3. The keeper: price publishing, liquidation, treasury rebalancing, the market-data service.
4. The interface: data source, order ticket checks, simulation before signing.
5. Tests: `cargo test --lib`, `npm run app:test`, `npm run keeper:test`.
