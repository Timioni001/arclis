/**
 * Portfolio: everything the connected wallet holds, across markets.
 *
 * Equity here is always net of unsettled funding — a position that looks
 * healthy on collateral alone can be liquidatable once funding is applied, and
 * a portfolio screen that ignores it is lying by omission.
 */
import { useMemo } from "react";
import type { ActivityEvent, MarketView, Position } from "../lib/protocol/types";
import * as m from "../lib/protocol/math";
import { Card, Delta, Empty, Metric, Meter, StatTile } from "../components/ui";
import { PriceChart } from "../components/charts/PriceChart";
import { ago, pct, shares as fmtShares, usd, usdSigned, pctPlain } from "../lib/format";

export function Portfolio({
  positions,
  markets,
  activity,
  now,
  onOpen,
}: {
  positions: Position[];
  markets: MarketView[];
  activity: ActivityEvent[];
  now: number;
  onOpen: (symbol: string) => void;
}) {
  const rows = useMemo(
    () =>
      positions
        .map((p) => {
          const view = markets.find((mv) => mv.market.address === p.market);
          if (!view) return null;
          const n = m.normalizeForSplits(
            p.size,
            p.entryPrice,
            p.entryFundingIndex,
            p.entrySplitFactor,
            view.oracle.splitFactor,
          );
          const notional = m.notional(n.size, view.oracle.price);
          const pnl = m.unrealizedPnl(n.size, n.entryPrice, view.oracle.price);
          const funding = m.fundingOwed(n.size, n.entryFundingIndex, view.market.cumulativeFundingIndex);
          const eq = m.equity(
            p.collateral,
            n.size,
            n.entryPrice,
            view.oracle.price,
            n.entryFundingIndex,
            view.market.cumulativeFundingIndex,
          );
          return {
            symbol: view.oracle.symbol,
            view,
            size: n.size,
            entry: n.entryPrice,
            mark: view.oracle.price,
            notional,
            pnl,
            funding,
            equity: eq,
            marginBps: m.marginRatioBps(eq, notional),
            collateral: p.collateral,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null),
    [positions, markets],
  );

  const totalEquity = rows.reduce((a, r) => a + r.equity, 0n);
  const totalPnl = rows.reduce((a, r) => a + r.pnl, 0n);
  const totalNotional = rows.reduce((a, r) => a + r.notional, 0n);
  const totalCollateral = rows.reduce((a, r) => a + r.collateral, 0n);
  const marginUsed = totalEquity > 0n ? Number(totalNotional) / Number(totalEquity) : 0;
  const pnlPct = totalCollateral > 0n ? (Number(totalPnl) / Number(totalCollateral)) * 100 : 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Portfolio</h1>
          <p className="page-sub">Equity is net of unsettled funding, the same way the program computes it.</p>
        </div>
      </header>

      <div className="grid grid-4">
        <Card>
          <Metric label="Total equity" value={usd(totalEquity)} size="xl" />
        </Card>
        <Card>
          <Metric
            label="Unrealised P&L"
            value={<Delta value={totalPnl}>{usdSigned(totalPnl)}</Delta>}
            sub={pct(pnlPct)}
            size="lg"
          />
        </Card>
        <Card>
          <Metric label="Notional exposure" value={usd(totalNotional)} sub={`${marginUsed.toFixed(1)}× equity`} size="lg" />
          <div style={{ marginTop: "var(--space-3)" }}>
            <Meter value={marginUsed} max={10} tone={marginUsed < 5 ? "positive" : "warning"} ariaLabel="Leverage against equity" />
          </div>
        </Card>
        <Card>
          <Metric label="Open positions" value={String(rows.length)} sub={`${markets.length} markets available`} size="lg" />
        </Card>
      </div>

      <div className="split-2">
        <Card title="Positions">
          {rows.length === 0 ? (
            <Empty title="No open positions">Your active positions will appear here.</Empty>
          ) : (
            <table className="table num">
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="right">Size</th>
                  <th className="right">Entry</th>
                  <th className="right">Mark</th>
                  <th className="right">P&L</th>
                  <th className="right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol} onClick={() => onOpen(r.symbol)} style={{ cursor: "pointer" }}>
                    <td>
                      <strong>{r.symbol}</strong>
                      <div className="metric-sub">{r.size > 0n ? "Long" : "Short"}</div>
                    </td>
                    <td className="right">{fmtShares(r.size)}</td>
                    <td className="right">{usd(r.entry, { compact: false })}</td>
                    <td className="right">{usd(r.mark, { compact: false })}</td>
                    <td className="right">
                      <Delta value={r.pnl}>{usdSigned(r.pnl, { compact: false })}</Delta>
                    </td>
                    <td className="right">
                      {r.marginBps === null ? "—" : pctPlain(Number(r.marginBps) / 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent activity">
          <div className="timeline">
            {activity.map((e) => (
              <div className="tl-item" key={e.id}>
                <span className="tl-dot" aria-hidden />
                <div>
                  <div className="tl-title">{e.summary}</div>
                  <div className="tl-meta">
                    {e.detail ? `${e.detail} · ` : ""}
                    {ago(e.ts, now)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {rows.length > 0 && (
        <Card title={`${rows[0].symbol} price`} note="Your largest position">
          <PriceChart candles={rows[0].view.candles.slice(-48)} height={240} mode="area" />
        </Card>
      )}

      <div className="stat-tiles">
        <StatTile label="Collateral posted" value={usd(totalCollateral)} />
        <StatTile
          label="Unsettled funding"
          value={<Delta value={-Number(rows.reduce((a, r) => a + r.funding, 0n))}>
            {usdSigned(-rows.reduce((a, r) => a + r.funding, 0n), { compact: false })}
          </Delta>}
        />
        <StatTile label="Markets traded" value={String(new Set(rows.map((r) => r.symbol)).size)} />
      </div>
    </div>
  );
}
