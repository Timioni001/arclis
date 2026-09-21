/**
 * The trading terminal.
 *
 * Chart-first, with the order panel beside it. The part that matters most is
 * not the layout: it is that every restriction is explained *before* the user
 * reaches a disabled button, and that every number in the panel (collateral,
 * liquidation, fee) is computed by the same maths the program runs.
 */
import { useMemo, useState } from "react";
import type { MarketView, Position } from "../lib/protocol/types";
import * as m from "../lib/protocol/math";
import { sessionAllows } from "../lib/protocol/session";
import {
  Button,
  Card,
  Delta,
  Icon,
  Metric,
  Notice,
  NumberField,
  Row,
  Segmented,
  StatTile,
} from "../components/ui";
import {
  CorporateActionCard,
  MarginHealth,
  OracleStatus,
  SessionBadge,
  SessionNotice,
} from "../components/protocol";
import {
  PriceChart,
  type EventMarker,
  type PriceMarker,
} from "../components/charts/PriceChart";
import {
  bpsToPct,
  leverage,
  pct,
  shares as fmtShares,
  usd,
  usdSigned,
} from "../lib/format";
import type { CorporateAction } from "../lib/protocol/types";

const TIMEFRAMES = ["1H", "4H", "1D", "1W", "1M", "ALL"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

const TF_BARS: Record<Timeframe, number> = {
  "1H": 12,
  "4H": 24,
  "1D": 36,
  "1W": 56,
  "1M": 78,
  ALL: 90,
};

export function Trade({
  view,
  position,
  corporateActions,
  now,
  onBack,
}: {
  view: MarketView;
  position?: Position;
  corporateActions: CorporateAction[];
  now: number;
  onBack: () => void;
}) {
  const { market, oracle, pool } = view;
  const [side, setSide] = useState<"long" | "short">("long");
  const [sizeInput, setSizeInput] = useState("2");
  const [lev, setLev] = useState(5);
  const [tf, setTf] = useState<Timeframe>("1D");
  const [chartMode, setChartMode] = useState<"candles" | "area">("candles");

  const canIncrease = sessionAllows(oracle.session, "IncreaseRisk");
  const canReduce = sessionAllows(oracle.session, "ReduceRisk");

  // Positions rescale lazily on-chain, so a freshly-read account can still be
  // pre-split. Normalise before showing anything.
  const pos = useMemo(() => {
    if (!position) return undefined;
    const n = m.normalizeForSplits(
      position.size,
      position.entryPrice,
      position.entryFundingIndex,
      position.entrySplitFactor,
      oracle.splitFactor,
    );
    return { ...position, ...n };
  }, [position, oracle.splitFactor]);

  const derived = useMemo(() => {
    if (!pos || pos.size === 0n) return null;
    const notional = m.notional(pos.size, oracle.price);
    const pnl = m.unrealizedPnl(pos.size, pos.entryPrice, oracle.price);
    const funding = m.fundingOwed(
      pos.size,
      pos.entryFundingIndex,
      market.cumulativeFundingIndex,
    );
    const eq = m.equity(
      pos.collateral,
      pos.size,
      pos.entryPrice,
      oracle.price,
      pos.entryFundingIndex,
      market.cumulativeFundingIndex,
    );
    return {
      notional,
      pnl,
      funding,
      equity: eq,
      marginBps: m.marginRatioBps(eq, notional),
      liq: m.liquidationPrice(
        pos.collateral,
        pos.size,
        pos.entryPrice,
        pos.entryFundingIndex,
        market.cumulativeFundingIndex,
        market.maintenanceMarginBps,
      ),
    };
  }, [pos, oracle.price, market]);

  // Order preview, computed the same way the program will.
  const preview = useMemo(() => {
    const qty = Number(sizeInput) || 0;
    const size =
      BigInt(Math.round(qty * Number(m.BASE_SCALE))) *
      (side === "short" ? -1n : 1n);
    const notional = m.notional(size, oracle.price);
    const collateral = lev > 0 ? notional / BigInt(lev) : 0n;
    const fee = m.feeOnNotional(notional, market.takerFeeBps);
    const liq = m.liquidationPrice(
      collateral,
      size,
      oracle.price,
      0n,
      0n,
      market.maintenanceMarginBps,
    );
    return { size, notional, collateral, fee, liq, qty };
  }, [
    sizeInput,
    side,
    lev,
    oracle.price,
    market.takerFeeBps,
    market.maintenanceMarginBps,
  ]);

  const poolNav = m.poolNav(
    pool.vaultBalance,
    m.netTraderPnl(
      market.openInterestLong,
      market.longEntryNotional,
      market.openInterestShort,
      market.shortEntryNotional,
      oracle.price,
    ),
  );
  const util = m.utilizationBps(
    m.netExposureNotional(
      market.openInterestLong,
      market.openInterestShort,
      oracle.price,
    ),
    poolNav,
  );
  const fundingRate = m.fundingRateBps(
    m.skewBps(market.openInterestLong, market.openInterestShort),
    market.fundingSensitivityBps,
    util ?? 0n,
  );

  const markers: PriceMarker[] = [];
  if (pos && pos.size !== 0n) {
    markers.push({ price: pos.entryPrice, label: "Entry", tone: "entry" });
    if (derived?.liq)
      markers.push({
        price: derived.liq,
        label: "Liquidation",
        tone: "liquidation",
      });
  }
  const events: EventMarker[] = corporateActions.map((c) => ({
    t: c.ts,
    label: `${c.numerator}:${c.denominator} SPLIT`,
    detail: "Positions rescaled",
  }));

  const candles = view.candles.slice(-TF_BARS[tf]);
  const blockedReason = !canIncrease.allowed ? canIncrease.reason : null;

  return (
    <div className="page">
      <button
        className="btn btn-sm btn-back"
        style={{ alignSelf: "flex-start" }}
        onClick={onBack}
      >
        <Icon name="arrowLeft" size={15} />
        Overview
      </button>

      {/* --- market header --- */}
      <Card large>
        <div
          className="card-head market-head"
          style={{ alignItems: "flex-start" }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                flexWrap: "wrap",
              }}
            >
              <h1 className="page-title">{oracle.symbol}</h1>
              <SessionBadge session={oracle.session} />
            </div>
            <div className="page-sub">{oracle.name}</div>
            <div
              style={{
                marginTop: "var(--space-3)",
                display: "flex",
                alignItems: "baseline",
                gap: "var(--space-4)",
              }}
            >
              <span className="metric-value num metric-value-xl">
                {usd(oracle.price, { compact: false })}
              </span>
              <Delta value={view.changePct24h}>
                {pct(view.changePct24h)} today
              </Delta>
            </div>
          </div>
          <div className="market-head-oracle">
            <OracleStatus oracle={oracle} now={now} />
          </div>
        </div>

        <div className="stat-tiles" style={{ marginTop: "var(--space-4)" }}>
          <StatTile
            label="Open interest"
            value={usd(
              m.notional(
                market.openInterestLong + market.openInterestShort,
                oracle.price,
              ),
            )}
          />
          <StatTile
            label="Funding / 1h"
            value={bpsToPct(fundingRate, 3)}
            sub={
              fundingRate > 0n
                ? "longs pay shorts"
                : fundingRate < 0n
                  ? "shorts pay longs"
                  : "balanced"
            }
          />
          <StatTile label="24h volume" value={usd(view.volume24h)} />
          <StatTile label="Max leverage" value={leverage(market.maxLeverage)} />
          <StatTile
            label="Pool utilisation"
            value={
              util === null ? "n/a" : `${(Number(util) / 100).toFixed(1)}%`
            }
            sub={`cap ${(market.maxUtilizationBps / 100).toFixed(0)}%`}
          />
        </div>
      </Card>

      <SessionNotice oracle={oracle} />

      {corporateActions.length > 0 && (
        <CorporateActionCard
          symbol={oracle.symbol}
          numerator={corporateActions[0].numerator}
          denominator={corporateActions[0].denominator}
          priceBefore={corporateActions[0].priceBefore}
          priceAfter={corporateActions[0].priceAfter}
        />
      )}

      {/* --- chart + order panel --- */}
      <div className="trade-layout">
        <Card
          title="Price"
          action={
            <div className="chart-controls">
              <Segmented
                options={["candles", "area"] as const}
                value={chartMode}
                onChange={setChartMode}
                label="Chart type"
              />
              <Segmented
                options={TIMEFRAMES}
                value={tf}
                onChange={setTf}
                label="Timeframe"
              />
            </div>
          }
        >
          <PriceChart
            candles={candles}
            markers={markers}
            events={events}
            mode={chartMode}
          />
        </Card>

        <Card className="order-panel" title="Trade">
          <div className="btn-group" style={{ marginBottom: "var(--space-4)" }}>
            <button
              className="btn-toggle"
              data-side="long"
              aria-pressed={side === "long"}
              onClick={() => setSide("long")}
            >
              Long
            </button>
            <button
              className="btn-toggle"
              data-side="short"
              aria-pressed={side === "short"}
              onClick={() => setSide("short")}
            >
              Short
            </button>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
            }}
          >
            <NumberField
              label="Size"
              value={sizeInput}
              onChange={setSizeInput}
              suffix="shares"
              disabled={!canIncrease.allowed}
            />
            <div className="field">
              <span className="field-label">Leverage · {leverage(lev)}</span>
              <input
                type="range"
                min={1}
                max={market.maxLeverage}
                step={1}
                value={lev}
                disabled={!canIncrease.allowed}
                onChange={(e) => setLev(Number(e.target.value))}
                aria-label="Leverage"
              />
            </div>
          </div>

          <dl style={{ margin: "var(--space-4) 0 0" }}>
            <Row
              label="Collateral required"
              value={usd(preview.collateral, { compact: false })}
            />
            <Row label="Notional" value={usd(preview.notional)} />
            <Row
              label="Entry price"
              value={usd(oracle.price, { compact: false })}
            />
            <Row
              label="Liquidation"
              value={preview.liq ? usd(preview.liq, { compact: false }) : "n/a"}
            />
            <Row
              label="Estimated fee"
              value={usd(preview.fee, { compact: false })}
            />
            <Row label="Funding / 1h" value={bpsToPct(fundingRate, 3)} />
          </dl>

          <div style={{ marginTop: "var(--space-4)" }}>
            {blockedReason ? (
              <>
                <Button block disabled title={blockedReason}>
                  {oracle.session === "Closed"
                    ? "Market closed"
                    : `Market ${oracle.session.toLowerCase()}`}
                </Button>
                <div
                  className="metric-sub"
                  style={{ marginTop: "var(--space-2)" }}
                >
                  {blockedReason}
                </div>
              </>
            ) : (
              <Button block variant="primary">
                Review trade
              </Button>
            )}
          </div>
        </Card>
      </div>

      {/* --- position --- */}
      <div className="split-2">
        <Card title="Your position">
          {!pos || pos.size === 0n || !derived ? (
            <div className="empty">
              <div className="empty-title">No open position</div>
              <div>Your position in {oracle.symbol} will appear here.</div>
            </div>
          ) : (
            <>
              <div className="card-head">
                <div>
                  <span
                    className="pill"
                    data-tone={pos.size > 0n ? "open" : "halted"}
                    style={{ marginRight: "var(--space-2)" }}
                  >
                    <span className="dot" aria-hidden />
                    {pos.size > 0n ? "LONG" : "SHORT"}
                  </span>
                  <span className="num" style={{ fontWeight: 600 }}>
                    {fmtShares(pos.size, { unit: true })}
                  </span>
                </div>
                <Button
                  disabled={!canReduce.allowed}
                  title={canReduce.allowed ? undefined : canReduce.reason}
                >
                  Close position
                </Button>
              </div>

              <div
                className="grid grid-3"
                style={{ marginBottom: "var(--space-4)" }}
              >
                <Metric
                  label="Entry"
                  value={usd(pos.entryPrice, { compact: false })}
                />
                <Metric
                  label="Mark"
                  value={usd(oracle.price, { compact: false })}
                />
                <Metric
                  label="Unrealised P&L"
                  value={
                    <Delta value={derived.pnl}>
                      {usdSigned(derived.pnl, { compact: false })}
                    </Delta>
                  }
                />
              </div>

              <dl style={{ margin: 0 }}>
                <Row
                  label="Notional"
                  value={usd(derived.notional, { compact: false })}
                />
                <Row
                  label="Unsettled funding"
                  value={
                    <Delta value={-Number(derived.funding)}>
                      {usdSigned(-derived.funding, { compact: false })}
                    </Delta>
                  }
                />
                <Row
                  label="Equity (after funding)"
                  value={usd(derived.equity, { compact: false })}
                />
              </dl>

              {!canReduce.allowed && (
                <div style={{ marginTop: "var(--space-3)" }}>
                  <Notice tone="danger" title="Closing unavailable">
                    {canReduce.reason}
                  </Notice>
                </div>
              )}
            </>
          )}
        </Card>

        <Card title="Risk">
          {derived ? (
            <MarginHealth
              marginBps={derived.marginBps}
              maintenanceBps={market.maintenanceMarginBps}
              liquidationPrice={derived.liq}
            />
          ) : (
            <div className="metric-sub">
              Open a position to see margin health, the maintenance threshold
              and your liquidation price.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
