# The keeper

Publishes oracle prices, cranks funding, runs the liquidator and watches for
corporate actions. It is the reason the site shows a live price instead of
"Oracle update delayed", and it has to stay up to do that.

## Why it is a process and not a cron job

An open market gives a published price **60 seconds** before the program
refuses to trade against it (`MAX_ORACLE_STALENESS_SECS`). The keeper
publishes every 10. The smallest interval a scheduler like GitHub Actions will
honour is five minutes and it is routinely later than that, so a scheduled
keeper would be stale more often than fresh.

## Read this before putting a key on a server

`oracle.authority` is fixed when the oracle is created and **there is no
instruction to change it**. The seed script set it to the wallet that ran the
seed, `~/.config/solana/id.json` - which is also the program's **upgrade
authority** and the wallet holding the funds.

So deploying the keeper as-is would put the key that can *replace the program*
on a cloud host. A compromise there would not cost bad prices, it would cost
the program.

Separate the two roles first. This needs no redeploy and no code change:

```bash
solana-keygen new --outfile ~/arclis-upgrade-authority.json   # keep offline
solana program set-upgrade-authority BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP \
  --new-upgrade-authority <pubkey of that new file>
```

Back that file up offline and do not put it anywhere else. After this,
`id.json` is the oracle authority and the fee payer and nothing more, and a
compromise of the host costs at most published prices and the SOL in that
wallet. The program already bounds the first of those with a per-update
deviation cap, so a stolen oracle key cannot reprice a market in one
transaction.

## Deploy to Fly

```bash
# 1. Create the app. Names are global; take the rename if it offers one.
fly launch --no-deploy --copy-config --name arclis-keeper

# 2. Secrets. Never in fly.toml, never in the repo.
#    loadKeypair accepts the CLI's JSON array directly, so this is a cat.
fly secrets set KEEPER_KEYPAIR="$(cat ~/.config/solana/id.json)"
fly secrets set ALPACA_KEY_ID=<key id> ALPACA_SECRET_KEY=<secret>   # every market, one request
fly secrets set FINNHUB_API_KEY=<your key>     # fills gaps; alone, ~18 markets

# 3. Ship it. `--ha=false` is not optional: Fly otherwise creates a second
#    machine for zero-downtime deploys, and two keepers on one key publish
#    every price twice, pay the fee twice, and fill the oracle's transaction
#    history - which the interface's chart reads - with duplicate prints.
fly deploy --ha=false

# 4. Watch it come up.
fly logs
curl https://arclis-keeper.fly.dev/health
```

Non-secret configuration lives in `fly.toml` under `[env]`: RPC, program ID,
quote mint and the symbol list. All of it is on-chain or already in the
frontend bundle.

### The one setting that matters

`auto_stop_machines = false`. Fly suspends machines with no inbound traffic and
wakes them on the next request, which is right for a web app and fatal here:
nothing ever calls the keeper, so it would be suspended within minutes and the
oracle would go stale exactly as before. It is a worker that answers a health
check, not a service.

## Health

`GET /health` returns the state of every loop, and **503 when a loop is
broken**, which is what Fly restarts on.

`fly status` should show exactly one machine. If it shows two, a deploy ran
without `--ha=false`; `fly scale count 1` fixes it.

The verdict is about the loops turning, never about price freshness. Markets
close: overnight and at weekends the correct behaviour is to publish nothing,
and a check built on freshness would restart the keeper every evening for
doing its job. `lastPublishedAt` is reported for a human to read and decides
nothing.

```json
{
  "ok": true,
  "rpc": "https://api.devnet.solana.com",
  "programId": "BuN69a1v...",
  "keeper": "<publishing pubkey>",
  "feed": "finnhub",
  "uptimeSecs": 3601,
  "tasks": { "oracle": { "ok": true, "secsSinceOk": 4, ... } },
  "lastPublishedAt": { "AAPL": 1790000000 }
}
```

`programId`, `rpc` and `keeper` are in there on purpose: a keeper running
happily against the wrong cluster or the wrong program publishes into a void
and looks perfectly healthy while it does it.

## Running it locally

```bash
export RPC_URL=https://api.devnet.solana.com
export PROGRAM_ID=BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP
export QUOTE_MINT=8nMZjpyLpGGtnCkdCotT8jWUDUpSnJeVjeuazyYVvqGu
export MARKETS=AAPL,NVDA,MSFT,TSLA,GOOGL
export KEEPER_KEYPAIR=~/.config/solana/id.json
export FINNHUB_API_KEY=<your key>
npm run keeper
```

Without a provider key the keeper falls back to a **simulated** feed, and it
refuses to do that against a non-local RPC unless `ALLOW_SIMULATED_FEED=yes`
is set explicitly. Do not set it against devnet: invented prices on a
deployment judges are looking at is the one failure that cannot be walked
back.

## Configuration

| Variable | Default | |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8899` | |
| `PROGRAM_ID` | from the IDL | |
| `QUOTE_MINT` | unset | liquidator is off without it |
| `MARKETS` | `AAPL,NVDA,MSFT,TSLA,GOOGL` | |
| `KEEPER_KEYPAIR` | **required** | path, JSON array, or base64 |
| `POLYGON_API_KEY` / `ALPACA_KEY_ID`+`ALPACA_SECRET_KEY` / `FINNHUB_API_KEY` | unset | first one set wins, else simulated; Finnhub also fills Alpaca's gaps |
| `ALPACA_DATA_FEED` | `iex` | `sip` needs a paid Alpaca plan |
| `JUPITER_API_KEY` | unset | 24/7 markets' off-hours quotes; keyless endpoint without it |
| `HEALTH_PORT` | off | no socket unless set |
| `PRICE_INTERVAL_MS` | `10000` | |
| `FUNDING_INTERVAL_MS` | `60000` | |
| `LIQUIDATOR_INTERVAL_MS` | `5000` | |
| `CORPORATE_INTERVAL_MS` | `3600000` | |
