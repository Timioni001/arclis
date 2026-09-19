/**
 * Agent treasuries.
 *
 * The screen that explains the product: an agent raised in tokenized stock and
 * is now levered to one company's earnings it never chose. The hedge turns that
 * into an operating budget. The dial shows whether it is actually working.
 */
import type { MarketView, Position, Treasury as TreasuryAccount } from "../lib/protocol/types";
import * as m from "../lib/protocol/math";
import { Card, Delta, Metric, Notice, Row, StatTile } from "../components/ui";
import { HedgeHealth } from "../components/protocol";
import { ago, shares as fmtShares, usd, pctPlain } from "../lib/format";

export function Treasury({
  treasuries,
  markets,
  positionFor,
  now,
}: {
  treasuries: TreasuryAccount[];
  markets: MarketView[];
  positionFor: (treasuryAddress: string) => Position | undefined;
  now: number;
}) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Treasuries</h1>
          <p className="page-sub">
            Agents that raised in tokenized stock, holding the asset and shorting the matching perp
            so their runway stops moving with one company's earnings.
          </p>
        </div>
      </header>

      {treasuries.map((t) => {
        const view = markets.find((mv) => mv.market.address === t.market);
        if (!view) return null;
        const pos = positionFor(t.address);
        const perpSize = pos?.size ?? 0n;

        const exp = m.treasuryExposure(
          t.stockQty,
          perpSize,
          pos?.collateral ?? 0n,
          pos?.entryPrice ?? 0n,
          pos?.entryFundingIndex ?? 0n,
          view.market.cumulativeFundingIndex,
          view.oracle.price,
        );
        const target = m.targetDelta(t.stockQty, t.hedgeRatioBps);
        const drift = exp.netDelta - target;
        const navPerToken = m.navPerToken(exp.nav, t.tokensOutstanding);

        // What the treasury would be worth unhedged, for the comparison that
        // makes the product legible.
        const unhedged = m.treasuryExposure(t.stockQty, 0n, 0n, 0n, 0n, 0n, view.oracle.price);

        return (
          <Card key={t.address} large>
            <div className="card-head" style={{ alignItems: "flex-start" }}>
              <div>
                <h2 style={{ fontSize: 20 }}>{t.agentName}</h2>
                <div className="card-note">
                  {view.oracle.symbol} treasury · hedge target {pctPlain(t.hedgeRatioBps / 100, 0)} ·
                  tolerance ±{pctPlain(t.rebalanceToleranceBps / 100, 1)}
                </div>
              </div>
              <div className="card-note">Last rebalance {ago(t.lastNavTs, now)}</div>
            </div>

            <div className="grid grid-4" style={{ marginBottom: "var(--space-5)" }}>
              <Metric label="Stock holdings" value={`${fmtShares(t.stockQty, { dp: 0 })}`} sub={`${view.oracle.symbol} shares`} size="lg" />
              <Metric label="Stock value" value={usd(exp.stockValue)} size="lg" />
              <Metric label="Perp position" value={fmtShares(perpSize, { dp: 0 })} sub={perpSize < 0n ? "short" : perpSize > 0n ? "long" : "flat"} size="lg" />
              <Metric label="NAV" value={usd(exp.nav)} sub={`${usd(navPerToken, { compact: false, dp: 4 })} / token`} size="lg" />
            </div>

            <div className="split-2">
              <div>
                <HedgeHealth
                  netDelta={drift}
                  stockQty={t.stockQty}
                  toleranceBps={t.rebalanceToleranceBps}
                />
                <dl style={{ margin: "var(--space-4) 0 0" }}>
                  <Row label="Net delta" value={`${fmtShares(exp.netDelta, { dp: 0 })} shares`} />
                  <Row label="Target delta" value={`${fmtShares(target, { dp: 0 })} shares`} />
                  <Row
                    label="Drift from target"
                    value={<Delta value={drift}>{fmtShares(drift, { dp: 0 })} shares</Delta>}
                  />
                  <Row label="Perp equity" value={usd(exp.perpEquity)} />
                </dl>
              </div>

              <div>
                <div className="stat-tiles" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
                  <StatTile label="Hedged NAV" value={usd(exp.nav)} sub="what the agent actually has" />
                  <StatTile
                    label="If unhedged"
                    value={usd(unhedged.nav)}
                    sub={`moves with ${view.oracle.symbol}`}
                  />
                  <StatTile label="Tokens outstanding" value={usd(t.tokensOutstanding, { compact: true }).replace("$", "")} />
                  <StatTile
                    label="Funding carry"
                    value={
                      <Delta value={perpSize < 0n ? 1 : -1}>
                        {perpSize < 0n ? "receiving" : "paying"}
                      </Delta>
                    }
                    sub={perpSize < 0n ? "book is skewed long" : "—"}
                  />
                </div>
                <div style={{ marginTop: "var(--space-4)" }}>
                  <Notice tone="info" title="Why this treasury is hedged">
                    {t.agentName} raised in {view.oracle.symbol} on a stock-quoted bonding curve,
                    which left it {usd(unhedged.nav)} of exposure to one company it has no view on.
                    Shorting the matching perp holds the dollar value of the runway steady — and
                    while the book is skewed long, the short receives funding rather than paying it.
                  </Notice>
                </div>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
