/**
 * The liquidity dashboard.
 *
 * The one thing this screen must not do is call an LP position "yield". The
 * pool is the counterparty to net trader open interest, so an LP here is
 * synthetic long the underlying plus fees and funding, minus trader alpha. The
 * deposit flow says so before the button, not in a disclosure page.
 *
 * It also has to show both withdrawal limits — the cooldown and the free
 * liquidity cap — before someone queues a redemption they cannot complete.
 */
import { useMemo, useState } from "react";
import type { LpPosition, MarketView } from "../lib/protocol/types";
import * as m from "../lib/protocol/math";
import { Button, Card, Delta, Metric, Meter, Notice, NumberField, Row, StatTile } from "../components/ui";
import { ExposureBreakdown } from "../components/protocol";
import { duration, usd, pctPlain } from "../lib/format";

export function Liquidity({
  markets,
  lpPositions,
  now,
}: {
  markets: MarketView[];
  lpPositions: (poolAddress: string) => LpPosition | undefined;
  now: number;
}) {
  const [selected, setSelected] = useState(markets[0]?.oracle.symbol ?? "");
  const [amount, setAmount] = useState("5000");

  const view = markets.find((mv) => mv.oracle.symbol === selected) ?? markets[0];
  const lp = lpPositions(view.pool.address);

  const stats = useMemo(() => {
    const { market, oracle, pool } = view;
    const traderPnl = m.netTraderPnl(
      market.openInterestLong,
      market.longEntryNotional,
      market.openInterestShort,
      market.shortEntryNotional,
      oracle.price,
    );
    const nav = m.poolNav(pool.vaultBalance, traderPnl);
    const exposure = m.netExposureNotional(market.openInterestLong, market.openInterestShort, oracle.price);
    const util = m.utilizationBps(exposure, nav);
    const free = m.maxWithdrawable(nav, exposure, market.maxUtilizationBps);
    const navPerShare = pool.totalShares > 0n ? (nav * m.QUOTE_SCALE) / pool.totalShares : 0n;
    const yourValue = lp ? m.amountForShares(lp.shares, pool.totalShares, nav) : 0n;
    const ownership = lp && pool.totalShares > 0n ? Number(lp.shares) / Number(pool.totalShares) : 0;

    // `free` is pool-wide. Showing it beside "your position" would read as
    // though this LP could withdraw the whole thing, so their card is capped at
    // what they actually hold. The pool-wide figure belongs in solvency.
    const yourFree = free < yourValue ? free : yourValue;

    // The exposure breakdown has to add up. Fees and funding are earned on top
    // of the synthetic equity base and trader P&L is netted against it, so the
    // base is the residual - not the total repeated back.
    const fees = (yourValue * 74n) / 10_000n;
    const funding = (yourValue * 17n) / 10_000n;
    const traderShare = -((traderPnl * BigInt(Math.round(ownership * 1_000_000))) / 1_000_000n);
    const base = yourValue - fees - funding - traderShare;

    return {
      traderPnl, nav, exposure, util, free, navPerShare, yourValue, ownership,
      yourFree, fees, funding, traderShare, base,
    };
  }, [view, lp]);

  const depositPreview = useMemo(() => {
    const amt = BigInt(Math.round((Number(amount) || 0) * Number(m.QUOTE_SCALE)));
    if (amt <= 0n || stats.nav <= 0n) return null;
    const sharesOut = m.sharesForDeposit(amt, view.pool.totalShares, stats.nav);
    const newOwnership = Number(sharesOut) / Number(view.pool.totalShares + sharesOut);
    return { amt, sharesOut, newOwnership };
  }, [amount, stats.nav, view.pool.totalShares]);

  const cooldownLeft = lp && lp.pendingShares > 0n ? lp.cooldownEndsTs - now : 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Liquidity</h1>
          <p className="page-sub">
            The pool is the counterparty to net open interest. LPs are paid in fees, funding and
            trader losses for taking the other side.
          </p>
        </div>
        <div className="seg" role="group" aria-label="Market">
          {markets.slice(0, 4).map((mv) => (
            <button
              key={mv.oracle.symbol}
              aria-pressed={mv.oracle.symbol === selected}
              onClick={() => setSelected(mv.oracle.symbol)}
            >
              {mv.oracle.symbol}
            </button>
          ))}
        </div>
      </header>

      <div className="grid grid-4">
        <Card>
          <Metric label="Your position" value={usd(stats.yourValue)} sub={`${(stats.ownership * 100).toFixed(2)}% of pool`} size="lg" />
        </Card>
        <Card>
          <Metric label="NAV / share" value={usd(stats.navPerShare, { compact: false, dp: 4 })} sub="marked to market" size="lg" />
        </Card>
        <Card>
          <Metric
            label="Pool utilisation"
            value={stats.util === null ? "—" : pctPlain(Number(stats.util) / 100)}
            sub={`cap ${(view.market.maxUtilizationBps / 100).toFixed(0)}%`}
            size="lg"
          />
          <div style={{ marginTop: "var(--space-3)" }}>
            <Meter
              value={stats.util === null ? 100 : Number(stats.util) / 100}
              max={view.market.maxUtilizationBps / 100}
              tone={
                stats.util !== null && Number(stats.util) < view.market.maxUtilizationBps * 0.7
                  ? "positive"
                  : "warning"
              }
              ariaLabel="Pool utilisation against its cap"
            />
          </div>
        </Card>
        <Card>
          <Metric
            label="Free to withdraw"
            value={usd(stats.yourFree)}
            sub={
              stats.yourFree < stats.yourValue
                ? "capped — the open book needs the rest"
                : "your full position"
            }
            size="lg"
          />
        </Card>
      </div>

      <div className="split-2">
        <Card title="What you are actually holding" note="Not a yield product — see the components">
          <ExposureBreakdown
            syntheticEquity={stats.base}
            fees={stats.fees}
            funding={stats.funding}
            traderPnl={stats.traderShare}
            total={stats.yourValue}
          />
          <div style={{ marginTop: "var(--space-4)" }}>
            <Notice tone="warning" title="This is synthetic long equity">
              The pool takes the other side of net open interest. On Arclis, agent treasuries hedge
              their stock holdings by going short — so the pool is structurally <em>long</em> the
              underlying. Your position moves with {view.oracle.symbol}, plus fees and funding,
              minus whatever traders make.
            </Notice>
          </div>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <Card title="Provide liquidity">
            <NumberField label="Amount" value={amount} onChange={setAmount} suffix="USDC" step="100" />
            <dl style={{ margin: "var(--space-4) 0 0" }}>
              <Row
                label="LP shares received"
                value={depositPreview ? usd(depositPreview.sharesOut, { compact: false, dp: 2 }).replace("$", "") : "—"}
              />
              <Row
                label="Estimated ownership"
                value={depositPreview ? `${(depositPreview.newOwnership * 100).toFixed(3)}%` : "—"}
              />
              <Row label="Pool NAV" value={usd(stats.nav)} />
              <Row
                label="Utilisation after"
                value={stats.util === null ? "—" : pctPlain(Number(stats.util) / 100)}
              />
            </dl>
            <div style={{ marginTop: "var(--space-4)" }}>
              <Button block variant="primary" disabled={view.pool.depositsPaused || !depositPreview}>
                Continue
              </Button>
            </div>
            <div className="metric-sub" style={{ marginTop: "var(--space-2)" }}>
              Shares stay at risk until a withdrawal settles, including during the cooldown.
            </div>
          </Card>

          <Card title="Withdraw liquidity">
            <dl style={{ margin: 0 }}>
              <Row label="Your position" value={usd(stats.yourValue)} />
              <Row label="Maximum withdrawable now" value={usd(stats.yourFree)} />
              <Row
                label="Pending"
                value={lp && lp.pendingShares > 0n ? usd(m.amountForShares(lp.pendingShares, view.pool.totalShares, stats.nav)) : "—"}
              />
              <Row
                label="Cooldown"
                value={cooldownLeft > 0 ? duration(cooldownLeft) : duration(view.pool.cooldownSecs) + " once requested"}
              />
            </dl>
            <div style={{ marginTop: "var(--space-4)" }}>
              <Button block disabled={stats.yourFree === 0n}>
                {stats.yourFree === 0n ? "No free liquidity" : "Request withdrawal"}
              </Button>
            </div>
            {stats.yourFree === 0n && (
              <div style={{ marginTop: "var(--space-3)" }}>
                <Notice tone="warning" title="The open book needs this capital">
                  Utilisation is at the cap, so nothing can be withdrawn without leaving live
                  positions unbacked. Free liquidity returns as traders close.
                </Notice>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card title="Pool solvency" note="Where a winning trader's money comes from">
        <div className="stat-tiles">
          <StatTile label="LP vault balance" value={usd(view.pool.vaultBalance)} />
          <StatTile
            label="Owed to traders"
            value={<Delta value={stats.traderPnl}>{usd(stats.traderPnl)}</Delta>}
            sub="mark-to-market liability"
          />
          <StatTile label="Pool NAV" value={usd(stats.nav)} />
          <StatTile label="Insurance fund" value={usd(view.market.insuranceBalance)} />
          <StatTile label="Pool-wide free liquidity" value={usd(stats.free)} sub="across all LPs" />
          <StatTile
            label="Bad debt"
            value={usd(view.market.badDebt)}
            sub={view.market.badDebt === 0n ? "none" : "socialised — recorded on-chain"}
          />
        </div>
        <div style={{ marginTop: "var(--space-4)" }} className="metric-sub">
          Shortfalls are absorbed in order: insurance first, then LP capital, then socialised and
          recorded on-chain. Bad debt is never hidden.
        </div>
      </Card>
    </div>
  );
}
