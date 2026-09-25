/**
 * The trading terminal.
 *
 * Chart-first, with the order panel beside it. The part that matters most is
 * not the layout: it is that every restriction is explained *before* the user
 * reaches a disabled button, and that every number in the panel (collateral,
 * liquidation, fee) is computed by the same maths the program runs.
 */
import { roundTheClock } from "../lib/markets";
import { MarketPicker } from "../components/protocol/MarketPicker";
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
  NumberField,
  Row,
  Segmented,
  StatTile,
} from "../components/ui";
import {
  CorporateActionCard,
  MarginHealth,
  OracleStatus,
  ROUND_THE_CLOCK_CLOSED,
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
import type { Session } from "../lib/auth/session";
import { OrderTicket } from "../components/protocol/OrderTicket";
import { TxButton } from "../components/protocol/TxButton";
import { closePosition, withdrawCollateral } from "../lib/protocol/tx/actions";
import {
  mergePoints,
  useKeeperHistory,
  useMarketCandles,
} from "../lib/protocol/keeperHistory";
import {
  TIMEFRAMES,
  buildTimeframe,
  type Timeframe,
  type TimeframeView,
} from "../lib/protocol/timeframes";
import type { Candle } from "../lib/protocol/types";

/**
 * The candles for one timeframe, from a market view's own data alone.
 *
 * Kept for callers and tests that have only the view. The Trade screen itself
 * calls `buildTimeframe` with the keeper's market data as well, which is what
 * gives the longer tabs their years of history.
 */
export function candlesForTimeframe(
  view: MarketView,
  tf: Timeframe,
): TimeframeView {
  const points = view.points ?? [];
  return buildTimeframe(tf, {
    points,
    intraday: [],
    daily: [],
    fallback: points.length ? [] : view.candles,
    live: null,
  });
}

/** How much time a set of candles actually covers, in words. */
function spanLabel(candles: Candle[]): string {
  if (candles.length < 2) return "a single print";
  const secs = candles[candles.length - 1].t - candles[0].t;
  const hours = secs / 3_600;
  if (hours < 1) return `${Math.max(1, Math.round(secs / 60))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

export function Trade({
  view,
  position,
  corporateActions,
  now,
  onBack,
  session,
  onSignIn,
  onFilled,
  markets = [],
  onSelectMarket,
}: {
  view: MarketView;
  /** Every market, for the switcher in the header. */
  markets?: MarketView[];
  onSelectMarket?: (symbol: string) => void;
  position?: Position;
  corporateActions: CorporateAction[];
  now: number;
  onBack: () => void;
  session: Session;
  onSignIn: () => void;
  onFilled?: () => void;
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

  /*
   * The candles for the selected window, re-bucketed rather than sliced.
   *
   * Re-bucketing is what makes the tabs mean anything: an hour of prints and a
   * week of prints want different bar widths, and `candlesFrom` picks one from
   * the span and cadence of whatever it is given. Slicing the tail of a
   * series bucketed for the whole history gives every tab the same bar width.
   *
   * A source that does not carry its prints falls back to the old slice, so
   * this degrades to what it did before rather than to an empty chart.
   */
  // Oracle prints (keeper history plus live chain reads), a month of
  // 15-minute bars and the full daily history, combined per timeframe with
  // the live oracle price on the newest bar.
  const keeperPoints = useKeeperHistory(oracle.symbol);
  const bars = useMarketCandles(oracle.symbol);
  const { candles, coverage, source } = useMemo(() => {
    const points = keeperPoints.length
      ? mergePoints(keeperPoints, view.points ?? [])
      : (view.points ?? []);
    return buildTimeframe(tf, {
      points,
      intraday: bars.intraday,
      daily: bars.daily,
      fallback: points.length ? [] : view.candles,
      live:
        oracle.price > 0n
          ? { price: oracle.price, t: oracle.lastUpdateTs }
          : null,
    });
  }, [view, tf, keeperPoints, bars, oracle.price, oracle.lastUpdateTs]);
  const blockedReason = !canIncrease.allowed
    ? roundTheClock(oracle.symbol) && oracle.session === "Closed"
      ? ROUND_THE_CLOCK_CLOSED
      : canIncrease.reason
    : null;

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
              {onSelectMarket && markets.length > 1 ? (
                <MarketPicker
                  markets={markets}
                  current={oracle.symbol}
                  onSelect={onSelectMarket}
                />
              ) : (
                <h1 className="page-title">{oracle.symbol}</h1>
              )}
              <SessionBadge session={oracle.session} symbol={oracle.symbol} />
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
          {/*
            Said plainly rather than left for the reader to infer from an axis.
            The alternative is a "1M" chart showing an hour of prints stretched
            across the full width, which reads as a month of flat trading.
          */}
          {coverage !== null && coverage < 0.9 && (
            <div className="card-note" style={{ marginTop: "var(--space-3)" }}>
              Showing {spanLabel(candles)} of history. The oracle has not been
              publishing for a full {tf.toLowerCase()} yet.
            </div>
          )}
          {(source === "daily" || source === "intraday") && (
            <div className="card-note" style={{ marginTop: "var(--space-3)" }}>
              History: {oracle.symbol}{" "}
              {source === "daily" ? "daily" : "intraday"} bars from Yahoo
              Finance. Latest bar: the Arclis oracle, live.
            </div>
          )}
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
              <OrderTicket
                symbol={oracle.symbol}
                side={side}
                preview={preview}
                poolLiquidity={pool.vaultBalance}
                priceAgeSecs={now - oracle.lastUpdateTs}
                session={session}
                onSignIn={onSignIn}
                onFilled={onFilled}
              />
            )}
          </div>
        </Card>
      </div>

      {/* --- position --- */}
      <div className="split-2">
        <Card title="Your position">
          {!pos || pos.size === 0n || !derived ? (
            <>
              <div className="empty">
                <div className="empty-title">No open position</div>
                <div>Your position in {oracle.symbol} will appear here.</div>
              </div>
              {pos && pos.size === 0n && pos.collateral > 0n && (
                <div style={{ marginTop: "var(--space-4)" }}>
                  <dl style={{ margin: "0 0 var(--space-3)" }}>
                    <Row
                      label="Idle collateral"
                      value={usd(pos.collateral, { compact: false })}
                    />
                  </dl>
                  <TxButton
                    symbol={oracle.symbol}
                    session={session}
                    onDone={onFilled}
                    doneText="Collateral returned to your wallet."
                    action={(ctx) => withdrawCollateral(ctx, pos.collateral)}
                  >
                    Withdraw collateral
                  </TxButton>
                </div>
              )}
            </>
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

              <div style={{ marginTop: "var(--space-4)" }}>
                <TxButton
                  symbol={oracle.symbol}
                  session={session}
                  onSignIn={onSignIn}
                  onDone={onFilled}
                  blocker={
                    canReduce.allowed
                      ? null
                      : (canReduce.reason ?? "Closing is unavailable.")
                  }
                  doneText="Position closed. Your collateral and P&L stay in the position until withdrawn."
                  action={(ctx) =>
                    closePosition(ctx, pos.size < 0n ? -pos.size : pos.size)
                  }
                >
                  Close position
                </TxButton>
              </div>
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
