# Arclis

Arclis is a Solana protocol for tokenized equities. It has two parts: a
**registry** that discloses what each tokenized stock on Solana is backed by,
and an oracle-priced **perpetual futures engine** that follows equity market
rules on chain: trading sessions, halts, stock splits and cash dividends.

Built on the perpetuals engine, **hedged treasuries** let an AI agent that
earns in a tokenized stock short the matching perpetual and keep the dollar
value of its runway steady.

## Live deployment

| Component | Location |
|---|---|
| Interface | [arclis.timioni1490.workers.dev](https://arclis.timioni1490.workers.dev) \| arclistrade.world (connecting) |
| Program (devnet) | [`BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP`](https://explorer.solana.com/address/BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP?cluster=devnet) |
| Keeper | [arclis-keeper.fly.dev/health](https://arclis-keeper.fly.dev/health) |
| Activity feed | [arclis-keeper.fly.dev/events](https://arclis-keeper.fly.dev/events) |
| Markets | 30 on US market hours: AAPL, NVDA, MSFT, TSLA, GOOGL, AMZN, META, AVGO, PLTR, AMD, COIN, HOOD, MSTR, SPY, QQQ, MU, CRCL, LLY, JNJ, KO, MCD, COST, INTC, BA, SHOP, ARM, GME, RDDT, IONQ, GLD. 5 around the clock: AAPLx, NVDAx, TSLAx, SPYx, QQQx |

The deployment runs on Solana devnet with prices published every 20 seconds.
The Registry needs no wallet. To trade or provide liquidity, connect a devnet
wallet and press **Get test USDC**. The keeper's faucet sends 10,000 test
USDC, plus devnet SOL for fees if the wallet has none.

## What sets it apart

| | The risk | How Arclis handles it |
|---|---|---|
| What a token represents | Two tokens with one ticker can carry very different claims | Legal structure, custody, redemption rights, authorities and exit depth, disclosed per token |
| Market hours | Leverage opened against a stale weekend price | Enforced by the program: no new risk while the market is closed or halted; exits always allowed |
| Splits and dividends | A 4:1 split reads as a 75% crash and liquidates longs | Applied through cumulative indices on chain; positions normalised, not liquidated |
| Bad oracle prints | One faulty print moves the mark price and cascades into liquidations | Bounded by staleness, confidence and a 10% per-update cap |
| Losses beyond collateral | Unclear who absorbs them | An explicit waterfall: collateral, insurance fund, LP capital, recorded bad debt |
| Operator powers | Funds movable by an admin key | Pause a market, nothing else; no instruction moves user funds to an operator-chosen address |
| AI agents paid in stocks | Runway rises and falls with the stock | On-chain treasury with a permissionless short hedge |

## Who it is for

- **Holders** who want to know whether a token called AAPL is a claim on a
  share, a note against an issuer, or a price tracker, before they buy it.
- **Traders** who want leveraged equity exposure from a Solana wallet without
  trading against stale weekend prices.
- **Liquidity providers** who want to know exactly what they underwrite: the
  pool is the counterparty to net trader open interest, shown as such.
- **AI agents** launched through ClawPump whose creator fees arrive in a
  tokenized stock, and whose runway should not move with that stock.
- **Builders** who need reliable token metadata and an equity-aware
  derivative to compose with.

## Components

| Path | Purpose |
|---|---|
| `programs/arclis/` | Anchor program: markets, positions, liquidity pools, oracles, insurance, corporate actions, agent treasuries. 28 instructions. |
| `app/` | React and TypeScript interface. Reads the program directly; builds, simulates and signs transactions in the browser. |
| `keeper/` | Operations service: price and session publisher, funding crank, liquidator, treasury rebalancer, corporate actions, event indexer, market data and devnet faucet. |
| `pipeline/` | Builds the Registry dataset: mint authorities, token extensions, and exit depth from Jupiter quotes. |
| `src/dbc/` | Meteora Dynamic Bonding Curve configuration and monitoring for pools quoted in a tokenized stock. |
| `tools/clawpump/` | Agent token launches through the ClawPump partner API, paired against a tokenized stock. |
| `scripts/` | Deployment seeding, IDL generation, toolchain setup, verification. |

## Architecture

### Registry

A public lookup of tokenized equities on Solana. For each token: legal
structure, custodian, redemption rights, mint and freeze authorities read from
chain, Token-2022 extensions, NAV deviation, and exit depth measured from live
Jupiter quotes at increasing sizes. The dataset is built by `pipeline/`, so
anyone can re-run it and check the result. See
[`docs/REGISTRY.md`](docs/REGISTRY.md).

### Perpetuals engine

Markets are cash-settled against an oracle price; there is no order book or
AMM. Each market has a liquidity pool that takes the other side of net open
interest and earns fees, funding and trader losses in return.

Equity behaviour is enforced on chain:

- **Sessions.** Each oracle carries a session state (pre-open, open, closed,
  halted). Risk-increasing instructions are refused outside the open session;
  risk-reducing instructions stay available against a bounded-staleness
  price, so no one is locked into a position.
- **Corporate actions.** Splits and cash dividends are applied through
  cumulative indices. Positions are normalised lazily on their next
  interaction, so a split costs one write per position rather than a
  migration.
- **Price safety.** Oracle updates are bounded by staleness, confidence and a
  per-update deviation cap of 10%.
- **24/7 markets.** AAPLx, NVDAx, TSLAx, SPYx and QQQx trade around the clock
  on the xStock itself. While the US market is open they follow the listed
  stock; nights, weekends and holidays they follow the xStock's own market on
  Solana, priced from two live Jupiter quotes (the mid is the price, half the
  spread is the confidence). When neither source gives a firm price, or the
  round trip costs more than 3%, the keeper closes the market: exits stay
  open, new risk waits. They carry 5x leverage and a 10% maintenance margin,
  half and double the hours-bound markets. The program needs no special case:
  a market's session is whatever its oracle says.
- **Funding.** Accrues on skew and pool utilisation, cranked permissionlessly.
- **Liquidation.** Permissionless, with a liquidator reward and an insurance
  cut.
- **Solvency.** Losses are allocated through an explicit waterfall: trader
  collateral, insurance fund, LP capital, then recorded bad debt.
- **Liquidity pools.** Withdrawals have a cooldown and are capped by
  utilisation, and both limits are shown before a deposit.

Custody is program-owned. The protocol authority can pause markets and
nothing else; the complete list of its powers is
`programs/arclis/src/instructions/admin.rs`.

### Agent treasuries

An agent's lifecycle spans three systems:

1. **Launch** (`tools/clawpump/launch.ts`). The agent's token is launched on
   Pump.fun through ClawPump, quoted in a tokenized stock chosen from
   ClawPump's catalogue of 79 stocks and ETFs. A creator fee of 1% to 3% of
   volume accrues in that stock; 75% is paid to the agent's wallet. The tool
   runs as a dry run unless `--execute` is given, validates the pair, fee and
   payout wallet, and never retries a launch.
2. **Treasury** (`programs/arclis/src/instructions/treasury.rs`). The agent
   deposits the stock, posts margin with `fund_treasury_hedge`, and
   `rebalance_hedge` maintains a short in the matching perpetual. Rebalancing
   is permissionless; the keeper runs it every five minutes, so the hedge does
   not depend on the agent's own infrastructure.
3. **Monitoring.** The Treasuries screen lists launchable stocks, identifies
   the thirty Arclis can hedge, and shows each on-chain treasury with its
   hedge, drift from target and NAV per token.

`src/dbc/` covers custom bonding-curve shapes, which Pump.fun launches do not
support.

### Event indexer

Trades, closes, liquidations, liquidity flows, splits, dividends and hedge
rebalances are emitted as Anchor events, which leave no account to read. The
keeper indexes them (`keeper/src/indexer.ts`) and serves them at `/events`;
the interface's activity feed and corporate-action log read from there.

- It polls each **market** account's signatures, not the program's, so the
  keeper's own oracle updates (about 45 a minute) are never fetched.
- Funding cranks carry a memo, and signatures are returned with their memo,
  so cranks are skipped without being fetched. This keeps a deep backfill
  cheap enough for a free-tier RPC plan.
- The chain is the store. On restart the indexer rebuilds its history from
  the last 300 signatures per market (`INDEXER_BACKFILL`), so there is no
  database to provision, migrate or lose.

### Accounts

Two sign-in methods share one session model (`app/src/lib/auth/`):

- **Wallets**, discovered through the Wallet Standard (Phantom, Solflare,
  Backpack and others). On Android, the Solana Mobile Wallet Adapter hands
  signing to an installed wallet app. On iOS, the interface offers to open the
  page in the wallet's in-app browser.
- **Passkey accounts**: an Ed25519 key generated in the browser and encrypted
  under a secret derived from the device's platform authenticator. There is no
  seed phrase, no password and no server-side account.

### Transactions

Every action that moves funds (opening, closing, withdrawing collateral,
providing and withdrawing liquidity) checks, in order: a real deployment, a
session that can sign, and the market's liquidity and the wallet's balance
where they apply. The order ticket then shows side, size, deposit and
liquidation price for review. Every transaction is **simulated against current
chain state before the wallet opens**, so a refusal is a readable sentence and
nothing is signed.

### Price data and charts

Charts combine three series, each covering a different span:

| Series | Source | Span |
|---|---|---|
| Oracle prints | Every price the keeper publishes, recorded by the keeper and read live from the chain | About one trading day |
| Intraday bars | 15-minute bars for the underlying stock, from Yahoo Finance | Last month |
| Daily bars | Daily bars for the underlying stock, from Yahoo Finance with Stooq as fallback | Full listing history |

Each timeframe (1H, 4H, 1D, 1W, 1M, 1Y, 5Y, ALL) draws from the finest series
that covers it, resampled to a readable bar width, and the newest bar always
carries the live oracle price. Daily change on every market is measured
against the previous session's close. Charts are rendered with TradingView
Lightweight Charts. The keeper fetches and caches market data server-side and
serves it at `/history`, `/candles` and `/summary`.

## Getting started

Requirements: Node 22, Rust, and for on-chain work the Solana CLI 1.18 and
Anchor 0.30.1. See [`QUICKSTART.md`](QUICKSTART.md) for a guided setup and
[`BUILD.md`](BUILD.md) for toolchain details.

```bash
bash scripts/setup-ubuntu.sh    # toolchain install (Ubuntu/Debian)
bash scripts/verify.sh          # runs every test level and prints a summary

npm install
npm --prefix app install
npm run app:dev                 # interface at http://localhost:5173, modelled data
```

To run against a local validator:

```bash
solana-test-validator --reset
anchor build --no-idl && anchor deploy
npm run seed -- --write-env     # config, markets, pools, open positions
npm run app:dev
```

`anchor build --no-idl` avoids an Anchor 0.30.1 IDL-generation failure on
current Rust. The IDL is generated by `npm run idl` and committed under
`idl/`.

## Operating a deployment

**Seed.** `npm run seed -- --url <rpc>` creates every market listed in
`app/src/lib/markets.json`. It is idempotent: existing accounts are skipped,
and a market that is already listed is left untouched, so re-running it to
add markets never disturbs live ones. Set `FINNHUB_API_KEY` so new markets
start at the live price (a 24/7 market starts at its underlying's).

**Keeper.** Deployed on Fly.io (`fly.toml`). Configuration:

| Variable | Kind | Purpose |
|---|---|---|
| `RPC_URL` | secret | Dedicated RPC endpoint. The public devnet endpoint rate-limits a multi-market keeper. |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | secret | Price feed: every market in one request (free account, IEX data). |
| `FINNHUB_API_KEY` | secret | Fills any market Alpaca could not price, capped to its free tier; alone it keeps about eighteen markets fresh. |
| `JUPITER_API_KEY` | secret, optional | 24/7 markets use the keyless Jupiter endpoint without it. |
| `KEEPER_KEYPAIR` | secret | Oracle authority and fee payer. |
| `MARKETS` | env | Symbols to operate; must match `markets.json`. |
| `PRICE_INTERVAL_MS` | env | Publish interval, 20 s: inside the program's 60 s staleness bound. |
| `INDEXER_INTERVAL_MS` | env | Event indexer poll interval, default 60 s. |
| `INDEXER_BACKFILL` | env | Signatures per market read on start, default 300. |
| `FAUCET_ENABLED` | env | `yes` serves test USDC at `POST /faucet?address=`. Limited per wallet, per client IP and per day; SOL is given only while the keeper holds more than 2 SOL. Starts only if the keeper key is the quote mint's authority. |

The health endpoint reports whether each loop is running rather than whether
prices are fresh, because a closed market publishing nothing is correct. It
redacts the RPC URL.

**Corporate actions** are applied between sessions from a provider feed.
Each applied action's transaction carries a memo with the action's id, and the
keeper checks that on-chain record before applying anything, so a restart can
never apply a split twice.

**Agent treasury.** `npm run seed:treasury -- --url <rpc>` opens a complete
treasury on devnet: agent mint with metadata, stock deposit, hedge margin and
the first rebalance.

**ClawPump.** `npm run clawpump -- pairs | snapshot | agents | launch`. The
`cpk_` key is read from `CLAWPUMP_API_KEY` and is never shipped to the
interface.

## Testing

| Suite | Command | Result |
|---|---|---|
| Program unit tests | `cargo test --lib` | 129 passing |
| Integration (local validator) | `npm run test:integration` | 25 passing |
| Interface | `npm run app:test` | 237 passing |
| Keeper, pipeline, ClawPump | `npm run keeper:test` | 202 passing |
| Meteora DBC tooling | `npm run test:dbc` | 37 passing |

630 tests in total. CI runs formatting, Clippy, unit tests, the DBC suite, a
lockfile audit against the platform-tools compiler, and the full Anchor build
and integration suite.

## Security

- No instruction transfers user funds to an authority-chosen address. The
  authority's complete powers are listed in
  `programs/arclis/src/instructions/admin.rs`.
- Every transaction is simulated before it is signed.
- Wallet keys never reach the interface; the wallet signs. Passkey account
  keys are stored in the browser only in encrypted form.
- API keys (ClawPump, Finnhub, RPC) are server-side only. Nothing prefixed
  `VITE_` is secret.
- The faucet mints only a devnet test token and refuses to start unless the
  keeper holds that mint's authority.
- The original program keypair was exposed in git history and has been
  rotated; see [`BUILD.md`](BUILD.md).
- The program has not been audited.

## Limitations

These remain, and each needs more than a code change in this repository:

- **Oracle trust.** Prices come from a single keeper key, bounded by
  staleness, confidence and deviation checks. Pyth equity feeds would remove
  this trust assumption; it is the first item on the roadmap.
- **24/7 pricing.** Overnight, a 24/7 market is only as good as the xStock's
  Solana liquidity. The spread limit, the 10% per-update cap and the lower
  leverage bound the damage a thin or pushed book can do; they do not make a
  thin book deep.
- **Gap risk.** A large move across a market close can exceed the insurance
  fund before liquidation is possible. This is inherent to equities, which
  gap; the loss waterfall makes the outcome ordered and visible.
- **Two clusters.** ClawPump launches run on mainnet and the treasury program
  on devnet, so a launched agent cannot yet be hedged end to end. That needs
  a mainnet deployment, which in turn needs an audit.
- **Unsupported corporate actions.** Mergers, spin-offs and delistings are
  not handled.
- **DBC graduation** cannot be gated on market hours; the monitor warns but
  cannot enforce.

## Roadmap

1. Pyth price feeds in place of the keeper oracle authority.
2. Third-party security audit.
3. Mainnet deployment of the treasury program, so ClawPump-launched agents can
   be hedged end to end.
4. Volume and P&L history on top of the event indexer.
5. More markets, following the Registry's coverage.

## Further reading

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): accounts, instructions, PDA
  seeds and the read model.
- [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md): viability analysis and open
  risks.
- [`docs/HACKATHON.md`](docs/HACKATHON.md): mapping to the Stocklana tracks.
- [`docs/REGISTRY.md`](docs/REGISTRY.md): registry methodology.
- [`docs/ENGINEERING-HISTORY.md`](docs/ENGINEERING-HISTORY.md): defects in the
  original draft and how they were fixed.
- [`article/ARTICLE.md`](article/ARTICLE.md): the long-form write-up.
- [`DESIGN.md`](DESIGN.md): interface design system.

## License

MIT. See [`LICENSE`](LICENSE).
