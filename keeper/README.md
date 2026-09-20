# The keeper

Four daemons that keep a deployed market alive. Without them a deployment is a
set of accounts nobody can mark, trade out of, or liquidate against.

```bash
npm run keeper
```

| Loop | Default cadence | What it does |
|---|---|---|
| `oracle` | 10s | Publishes prices and sessions |
| `funding` | 60s | Calls `crank_funding` on every market |
| `liquidator` | 5s | Scans positions and liquidates the underwater ones |
| `corporate` | 1h | Applies splits and dividends on their ex-date, while shut |

All four are permissionless except the oracle, which needs the oracle
authority. The cranks are here so that somebody is definitely running them,
not because only this code may.

## The calendar is the load-bearing part

`src/calendar.ts` is a pure function from unix seconds to a `MarketSession`.
Everything equity-specific in the program reduces to that one answer, and the
program cannot compute it: it enforces the consequences, something off-chain
decides the fact.

Getting it wrong costs money in both directions. Saying **Open** while the
venue is shut lets somebody open a position against a frozen price, which is
the free weekend option the session design exists to refuse. Saying **Closed**
while it is open traps traders who want out and stops funding accruing on a
live imbalance.

So it has no network, no state, and no clock of its own, and 31 tests that each
name a real date:

- Regular hours, to the minute, on both sides of both bells.
- Weekends, midweek holidays, observed holidays (4 July 2026 falls on a
  Saturday, so the market shuts the Friday), and Good Friday, which follows the
  paschal full moon and no weekday rule would ever produce.
- Half days, which close at 13:00 and still open at 09:30.
- Both daylight-saving transitions. The bell is 14:30 UTC in winter and 13:30
  in summer; a fixed offset runs the market an hour late for half the year.

Holidays and half days are **tables, not derivations**, because several of them
are not rule-based and a table can be checked line by line against the NYSE's
published calendar. `KNOWN_THROUGH` is the honest edge: past it the calendar
returns `Halted`, which permits nothing, and the keeper refuses to start rather
than publishing that forever.

The calendar never invents a halt. A real halt is an exchange event that
arrives from the price feed, and a calendar that could fabricate one could
freeze a market by being wrong about a date.

## Write order, which is not the obvious one

The session goes on-chain **before** the price when opening, and **after** it
when closing.

- **Opening.** Publish `Open` first. The standing price is the previous close,
  stale by definition, and `Open` applies the strict 60-second budget to it, so
  the gap between the two writes is a gap where nobody can act on it.
- **Closing.** Publish the final print first, then `Closed`. That print is the
  settlement price for the entire weekend, so it has to be the one standing
  when the session flips. The other order settles the weekend against the
  second-to-last trade.

## What it refuses to do

**Publish a price it did not receive.** A provider outage leaves the chain
alone and logs. It never extrapolates, never republishes a stale quote under a
fresh timestamp, and never silently fails over to a second provider. The
on-chain staleness rules exist precisely to catch a dead feed, and a keeper
that papers over an outage disarms them.

**Publish simulated prices to a real cluster.** With no provider configured and
a non-local RPC, the keeper refuses to start. `ALLOW_SIMULATED_FEED=yes`
overrides it, deliberately verbosely.

**Republish the same print.** Doing so resets the on-chain timestamp and
launders a stale price into a fresh one.

## Configuration

```bash
KEEPER_KEYPAIR=/path/to/keeper.json   # required; also accepts a JSON array or base64
RPC_URL=https://api.devnet.solana.com
MARKETS=AAPL,NVDA,MSFT,TSLA,GOOGL
QUOTE_MINT=<mint>                     # without it the liquidator does not run

# One of these. Without any, and only on a local RPC, prices are simulated.
POLYGON_API_KEY=...                   # also enables the corporate-action feed
FINNHUB_API_KEY=...
ALPACA_KEY_ID=... ALPACA_SECRET_KEY=...

PRICE_INTERVAL_MS=10000
FUNDING_INTERVAL_MS=60000
LIQUIDATOR_INTERVAL_MS=5000
CORPORATE_INTERVAL_MS=3600000
```

## Liquidation

`scanPositions` uses `getProgramAccounts` with a discriminator filter and a
server-side `memcmp` on the market. The filter is not an optimisation: without
it every pass downloads every position in every market, which is how a
liquidator gets itself rate limited off its own endpoint.

`marginRatioBps` duplicates the program's health formula because the scanner
needs it off-chain to decide what is worth submitting. The duplicate has its
own tests, and the scanner submits anything within 50 bps **above** maintenance
rather than only what is already underwater: the price moves between the scan
and the landing, so a scanner that waits is always one block late. Being early
costs a `PositionHealthy` rejection, which is a transaction fee. Being late
costs bad debt.

## Corporate actions

Applied on the **ex-date**, while `Closed`. Applying a dividend the day before
credits against a price that has not fallen yet, which is a straight transfer
from every short.

⚠️ The default applied-actions log is **in memory**. A restart forgets what it
applied, and a forgotten split is a split applied twice, which turns a
four-for-one into a sixteen-for-one. `AppliedLog` is an interface; back it with
a file or a row in a table before running this anywhere real.
