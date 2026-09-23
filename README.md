# Arclis

Arclis is a Solana protocol for tokenized equities. It has two parts: a
registry that discloses what each tokenized stock on Solana is backed by, and
an oracle-priced perpetual futures engine that handles equity market
mechanics: trading sessions, halts, stock splits and cash dividends.

On top of the perpetuals engine, Arclis provides hedged treasuries for AI
agents. An agent that raises capital in a tokenized stock can short the
matching perpetual and hold the dollar value of its treasury steady.

## Live deployment

| Component | Location |
|---|---|
| Interface | [arclis.timioni1490.workers.dev](https://arclis.timioni1490.workers.dev) |
| Program (devnet) | [`BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP`](https://explorer.solana.com/address/BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP?cluster=devnet) |
| Keeper | [arclis-keeper.fly.dev/health](https://arclis-keeper.fly.dev/health) |
| Markets | AAPL, NVDA, MSFT, TSLA, GOOGL, AMZN, META, AVGO, PLTR, AMD, COIN, HOOD, MSTR, SPY, QQQ |

The deployment runs on Solana devnet. Prices are published by the keeper from
Finnhub quotes. Orders that increase risk are accepted only while the
underlying US market is open.

The Registry requires no wallet. Trading requires a devnet wallet holding the
deployment's test USDC, which the operator provides with
`npm run seed -- --url <rpc> --airdrop <address>`.

## Components

| Path | Purpose |
|---|---|
| `programs/arclis/` | Anchor program: markets, positions, liquidity pools, oracles, agent treasuries. 28 instructions. |
| `app/` | React and TypeScript interface. Reads the program directly; builds and signs transactions in the browser. |
| `keeper/` | Operational daemons: price and session publisher, funding crank, liquidator, treasury rebalancer, corporate actions, price-history service. |
| `pipeline/` | Builds the registry's live dataset: mint authorities, token extensions, and exit depth from Jupiter quotes. |
| `src/dbc/` | Meteora Dynamic Bonding Curve configuration and monitoring for pools quoted in a tokenized stock. |
| `tools/clawpump/` | Agent token launches through the ClawPump partner API, paired against a tokenized stock. |
| `scripts/` | Deployment seeding, IDL generation, toolchain setup, verification. |

## Architecture

### Perpetuals engine

Markets are cash-settled against an oracle price; there is no order book or
AMM. Each market has a liquidity pool that takes the other side of net open
interest and earns fees, funding and trader losses in return.

Equity behaviour is enforced on chain:

- **Sessions.** Each oracle carries a session state (pre-open, open, closed,
  halted). Risk-increasing instructions are refused outside the open session;
  risk-reducing instructions remain available against a bounded-staleness
  price.
- **Corporate actions.** Splits and cash dividends are applied through
  cumulative indices, and positions are normalised lazily on their next
  interaction.
- **Price safety.** Oracle updates are bounded by staleness, confidence and a
  per-update deviation cap of 10%.
- **Solvency.** Losses are allocated through an explicit waterfall: trader
  collateral, insurance fund, LP capital, then recorded bad debt.

Custody is program-owned. The protocol authority can pause markets and
nothing else; there is no instruction that moves user funds to an
authority-chosen address.

### Accounts

Two sign-in methods share one session model (`app/src/lib/auth/`):

- **Wallets**, discovered through the Wallet Standard (Phantom, Solflare,
  Backpack and others). On Android, the Solana Mobile Wallet Adapter hands
  signing to an installed wallet app. On iOS, the interface offers to open the
  page in the wallet's in-app browser.
- **Passkey accounts**: an Ed25519 key generated in the browser and encrypted
  under a secret derived from the device's platform authenticator. There is no
  seed phrase, no password and no server-side account.

### Trading

The order ticket (`app/src/components/protocol/OrderTicket.tsx`) is the only
component that requests a signature for an order. Before it does, it checks:

1. the interface is connected to a deployment;
2. the session holds a key that can sign;
3. the market's liquidity pool can take the order;
4. the wallet's quote-token balance covers collateral plus fees.

The user then reviews side, size, deposit and liquidation price. On
confirmation, the transaction is simulated against current chain state before
the wallet is opened, so a rejected order produces a readable error and no
signature.

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
   is permissionless; the keeper runs it every five minutes.
3. **Monitoring.** The Treasuries screen lists launchable stocks, identifies
   the fifteen that Arclis can hedge, and shows each on-chain treasury with its
   hedge, drift from target and NAV per token.

`src/dbc/` covers custom bonding-curve shapes, which Pump.fun launches do not
support.

### Price data and charts

The keeper records each price it publishes and backfills from the chain at
startup. It serves the most recent 3,000 prints per market at
`GET /history?symbol=<ticker>`. The interface merges this with live on-chain
reads and renders it with TradingView Lightweight Charts. Because history is
retained by count rather than by time, a closed market still shows its most
recent session.

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
and an existing oracle keeps its current price. Set `FINNHUB_API_KEY` so new
markets start at the live price.

**Keeper.** Deployed on Fly.io (`fly.toml`). Configuration:

| Variable | Kind | Purpose |
|---|---|---|
| `RPC_URL` | secret | Dedicated RPC endpoint. The public devnet endpoint rate-limits a fifteen-market keeper. |
| `FINNHUB_API_KEY` | secret | Price feed. |
| `KEEPER_KEYPAIR` | secret | Oracle authority and fee payer. |
| `MARKETS` | env | Symbols to operate; must match `markets.json`. |
| `PRICE_INTERVAL_MS` | env | Publish interval; 20 s keeps fifteen markets within Finnhub's free tier. |

The health endpoint reports each loop's liveness and redacts the RPC URL.

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
| Interface | `npm run app:test` | 210 passing |
| Keeper, pipeline, ClawPump | `npm run keeper:test` | 168 passing |
| Meteora DBC tooling | `npm run test:dbc` | 37 passing |

CI runs formatting, Clippy, unit tests, the DBC suite, a lockfile audit
against the platform-tools compiler, and the full Anchor build and
integration suite.

## Security

- No instruction transfers user funds to an authority-chosen address. The
  authority's complete powers are listed in
  `programs/arclis/src/instructions/admin.rs`.
- Wallet keys never reach the interface; the wallet signs. Passkey account
  keys are stored in the browser only in encrypted form.
- API keys (Anthropic, ClawPump, Finnhub, RPC) are server-side only. Nothing
  prefixed `VITE_` is secret.
- The original program keypair was exposed in git history and has been
  rotated; see [`BUILD.md`](BUILD.md).
- The program has not been audited.

## Limitations

- **Oracle trust.** Prices come from a single keeper key, bounded by
  staleness, confidence and deviation checks. A Pyth integration would remove
  this trust assumption.
- **Gap risk.** A large move across a market close can exceed the insurance
  fund before liquidation is possible. The loss waterfall makes the outcome
  ordered and visible; it does not prevent it.
- **Test collateral.** Markets settle in a devnet test token; there is no
  public faucet.
- **Two clusters.** ClawPump launches run on mainnet and the treasury program
  on devnet, so a launched agent cannot yet be hedged end to end.
- **Indexing.** Corporate actions and the activity feed are emitted events and
  require an indexer, which this deployment does not run.
- **Unsupported corporate actions.** Mergers and delistings are not handled.
- **DBC graduation** cannot be gated on market hours; the monitor warns but
  cannot enforce.

## Roadmap

1. Pyth price feeds in place of the keeper oracle authority.
2. An event indexer for corporate actions, activity and volume.
3. Mainnet deployment of the treasury program, so ClawPump-launched agents can
   be hedged end to end.
4. Third-party security audit.

## Further reading

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): accounts, instructions, PDA
  seeds and the read model.
- [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md): viability analysis and open
  risks.
- [`docs/HACKATHON.md`](docs/HACKATHON.md): mapping to the Stocklana tracks.
- [`docs/REGISTRY.md`](docs/REGISTRY.md): registry methodology.
- [`docs/ENGINEERING-HISTORY.md`](docs/ENGINEERING-HISTORY.md): defects in the
  original draft and how they were fixed.
- [`DESIGN.md`](DESIGN.md): interface design system.

## License

MIT. See [`LICENSE`](LICENSE).
