/**
 * Agent treasuries.
 *
 * The screen that explains the product: an agent raised in tokenized stock and
 * is now levered to one company's earnings it never chose. The hedge turns that
 * into an operating budget. The dial shows whether it is actually working.
 */
import type {
  MarketView,
  Position,
  Treasury as TreasuryAccount,
} from "../lib/protocol/types";
import * as m from "../lib/protocol/math";
import {
  Card,
  Delta,
  Empty,
  Metric,
  Notice,
  Row,
  SkeletonList,
  StatTile,
} from "../components/ui";
import { HedgeHealth } from "../components/protocol";
import { AgentPairs } from "../components/clawpump/AgentPairs";
import { ago, shares as fmtShares, usd, pctPlain } from "../lib/format";

export function Treasury({
  treasuries,
  markets,
  positionFor,
  now,
  loading = false,
}: {
  treasuries: TreasuryAccount[];
  markets: MarketView[];
  positionFor: (treasuryAddress: string) => Position | undefined;
  now: number;
  /** True until the first read lands; see `App`. */
  loading?: boolean;
}) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Treasuries</h1>
          <p className="page-sub">
            Agents that raised in tokenized stock, holding the asset and
            shorting the matching perp so their runway stops moving with one
            company's earnings.
          </p>
        </div>
      </header>

      <AgentPairs />

      {/*
        An empty list rendered nothing at all, which reads as a broken screen
        rather than an empty one. It is neither, and the distinction is worth
        stating: the interface now enumerates every `AgentTreasury` the program
        owns on each scan, so an empty list is the chain's answer rather than a
        missing feature.
      */}
      {/*
        "None have been opened" is a claim about the chain, so it waits until
        the chain has actually been asked. Saying it during the first read
        would be asserting a scan result before the scan.
      */}
      {loading && treasuries.length === 0 && (
        <Card large>
          <SkeletonList rows={3} label="Scanning for agent treasuries" />
        </Card>
      )}

      {!loading && treasuries.length === 0 && (
        <Empty title="No agent treasuries on this deployment yet">
          Every treasury the program holds is listed here, found by scanning
          the program&apos;s accounts. None have been opened on this
          deployment. Launch an agent against one of the stocks above and
          open its treasury, and it appears here on the next scan.
        </Empty>
      )}

      {treasuries.map((t) => {
        const view = markets.find((mv) => mv.market.address === t.market);

        /*
         * A treasury whose market is not one of the symbols this interface
         * tracks used to be dropped silently. Dropping it is the worst of the
         * options: the scan found a real account and the screen showed
         * nothing, which is indistinguishable from the scan having failed.
         * The hedge maths needs the market's mark and funding index, so the
         * full card genuinely cannot be drawn; naming the treasury and saying
         * why can.
         */
        if (!view) {
          return (
            <Card key={t.address}>
              <div className="card-head">
                <h2 style={{ fontSize: 20 }}>{t.agentName}</h2>
              </div>
              <div className="card-note">
                This treasury hedges a market outside the symbols this
                interface tracks, so its exposure cannot be valued here. It
                holds {fmtShares(t.stockQty, { dp: 0 })} shares against market{" "}
                {t.market.slice(0, 8)}…
              </div>
            </Card>
          );
        }
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
        const unhedged = m.treasuryExposure(
          t.stockQty,
          0n,
          0n,
          0n,
          0n,
          0n,
          view.oracle.price,
        );

        return (
          <Card key={t.address} large>
            <div className="card-head" style={{ alignItems: "flex-start" }}>
              <div>
                <h2 style={{ fontSize: 20 }}>{t.agentName}</h2>
                <div className="card-note">
                  {view.oracle.symbol} treasury · hedge target{" "}
                  {pctPlain(t.hedgeRatioBps / 100, 0)} · tolerance ±
                  {pctPlain(t.rebalanceToleranceBps / 100, 1)}
                </div>
              </div>
              <div className="card-note">
                Last rebalance {ago(t.lastNavTs, now)}
              </div>
            </div>

            <div
              className="grid grid-4"
              style={{ marginBottom: "var(--space-5)" }}
            >
              <Metric
                label="Stock holdings"
                value={`${fmtShares(t.stockQty, { dp: 0 })}`}
                sub={`${view.oracle.symbol} shares`}
                size="lg"
              />
              <Metric
                label="Stock value"
                value={usd(exp.stockValue)}
                size="lg"
              />
              <Metric
                label="Perp position"
                value={fmtShares(perpSize, { dp: 0 })}
                sub={perpSize < 0n ? "short" : perpSize > 0n ? "long" : "flat"}
                size="lg"
              />
              <Metric
                label="NAV"
                value={usd(exp.nav)}
                sub={`${usd(navPerToken, { compact: false, dp: 4 })} / token`}
                size="lg"
              />
            </div>

            <div className="split-2">
              <div>
                <HedgeHealth
                  netDelta={drift}
                  stockQty={t.stockQty}
                  toleranceBps={t.rebalanceToleranceBps}
                />
                <dl style={{ margin: "var(--space-4) 0 0" }}>
                  <Row
                    label="Net delta"
                    value={`${fmtShares(exp.netDelta, { dp: 0 })} shares`}
                  />
                  <Row
                    label="Target delta"
                    value={`${fmtShares(target, { dp: 0 })} shares`}
                  />
                  <Row
                    label="Drift from target"
                    value={
                      <Delta value={drift}>
                        {fmtShares(drift, { dp: 0 })} shares
                      </Delta>
                    }
                  />
                  <Row label="Perp equity" value={usd(exp.perpEquity)} />
                </dl>
              </div>

              <div>
                <div
                  className="stat-tiles"
                  style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
                >
                  <StatTile
                    label="Hedged NAV"
                    value={usd(exp.nav)}
                    sub="what the agent actually has"
                  />
                  <StatTile
                    label="If unhedged"
                    value={usd(unhedged.nav)}
                    sub={`moves with ${view.oracle.symbol}`}
                  />
                  <StatTile
                    label="Tokens outstanding"
                    value={usd(t.tokensOutstanding, { compact: true }).replace(
                      "$",
                      "",
                    )}
                  />
                  <StatTile
                    label="Funding carry"
                    value={
                      <Delta value={perpSize < 0n ? 1 : -1}>
                        {perpSize < 0n ? "receiving" : "paying"}
                      </Delta>
                    }
                    sub={
                      perpSize < 0n ? "book is skewed long" : "no hedge open"
                    }
                  />
                </div>
                <div style={{ marginTop: "var(--space-4)" }}>
                  <Notice tone="info" title="Why this treasury is hedged">
                    {t.agentName} raised in {view.oracle.symbol} on a
                    stock-quoted bonding curve, which left it{" "}
                    {usd(unhedged.nav)} of exposure to one company it has no
                    view on. Shorting the matching perp holds the dollar value
                    of the runway steady, and while the book is skewed long, the
                    short receives funding rather than paying it.
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
