/**
 * Market discovery.
 *
 * Equity context first: session state is as prominent as price, because on
 * Arclis it determines what you can actually do. A generic token dashboard
 * would put volume there.
 */
import type { MarketView } from "../lib/protocol/types";
import * as m from "../lib/protocol/math";
import { Card, Delta, StatTile } from "../components/ui";
import { SessionBadge } from "../components/protocol";
import { Sparkline } from "../components/charts/PriceChart";
import { bpsToPct, confidencePct, pct, usd } from "../lib/format";

export function Markets({
  markets,
  onOpen,
}: {
  markets: MarketView[];
  onOpen: (symbol: string) => void;
}) {
  const totalOi = markets.reduce(
    (a, mv) => a + m.notional(mv.market.openInterestLong + mv.market.openInterestShort, mv.oracle.price),
    0n,
  );
  const openCount = markets.filter((mv) => mv.oracle.session === "Open").length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Markets</h1>
          <p className="page-sub">
            Oracle-priced perpetuals on tokenized equities. Sessions, halts and corporate actions
            are enforced on-chain.
          </p>
        </div>
        <div className="stat-tiles" style={{ minWidth: 320 }}>
          <StatTile label="Markets open" value={`${openCount} / ${markets.length}`} />
          <StatTile label="Total open interest" value={usd(totalOi)} />
        </div>
      </header>

      <div className="grid grid-markets">
        {markets.map((mv) => {
          const { market, oracle } = mv;
          const oi = m.notional(market.openInterestLong + market.openInterestShort, oracle.price);
          const nav = m.poolNav(
            mv.pool.vaultBalance,
            m.netTraderPnl(
              market.openInterestLong,
              market.longEntryNotional,
              market.openInterestShort,
              market.shortEntryNotional,
              oracle.price,
            ),
          );
          const util = m.utilizationBps(
            m.netExposureNotional(market.openInterestLong, market.openInterestShort, oracle.price),
            nav,
          );
          const rate = m.fundingRateBps(
            m.skewBps(market.openInterestLong, market.openInterestShort),
            market.fundingSensitivityBps,
            util ?? 0n,
          );

          return (
            <Card
              key={oracle.symbol}
              className="card-interactive"
              style={{ cursor: "pointer" }}
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => onOpen(oracle.symbol)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(oracle.symbol);
                  }
                }}
                aria-label={`Open ${oracle.symbol} market`}
              >
                <div className="card-head" style={{ marginBottom: "var(--space-3)" }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em" }}>
                      {oracle.symbol}
                    </div>
                    <div className="card-note">{oracle.name}</div>
                  </div>
                  <SessionBadge session={oracle.session} />
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "space-between",
                    gap: "var(--space-3)",
                  }}
                >
                  <div>
                    <div className="metric-value num metric-value-lg">
                      {usd(oracle.price, { compact: false })}
                    </div>
                    <Delta value={mv.changePct24h}>{pct(mv.changePct24h)}</Delta>
                  </div>
                  <Sparkline candles={mv.candles.slice(-40)} />
                </div>

                <div className="stat-tiles" style={{ marginTop: "var(--space-4)" }}>
                  <StatTile label="24h volume" value={usd(mv.volume24h)} />
                  <StatTile label="Open interest" value={usd(oi)} />
                  <StatTile
                    label="Funding / 1h"
                    value={bpsToPct(rate, 3)}
                    sub={rate > 0n ? "longs pay" : rate < 0n ? "shorts pay" : "balanced"}
                  />
                  <StatTile
                    label="Oracle confidence"
                    value={`${confidencePct(oracle.price, oracle.confidence).toFixed(1)}%`}
                  />
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
