/**
 * Protocol-aware components.
 *
 * These are the pieces that make Arclis look like a public-markets terminal
 * rather than a generic DeFi dashboard: session state, oracle freshness,
 * corporate actions, margin health, and the pool's exposure breakdown.
 */
import type { ReactNode } from "react";
import type { MarketSession, Oracle } from "../../lib/protocol/types";
import { SESSION_LABEL } from "../../lib/protocol/session";
import {
  StatusPill,
  Notice,
  SegBar,
  Legend,
  Chip,
  Icon,
  ListRow,
  type Tone,
} from "../ui";
import {
  ago,
  confidencePct,
  pctPlain,
  sessionOpensAt,
  usd,
  shares,
} from "../../lib/format";

const SESSION_TONE: Record<MarketSession, Tone> = {
  Open: "open",
  Closed: "closed",
  PreOpen: "preopen",
  Halted: "halted",
};

export function SessionBadge({ session }: { session: MarketSession }) {
  return (
    <StatusPill tone={SESSION_TONE[session]}>
      {SESSION_LABEL[session]}
    </StatusPill>
  );
}

/**
 * The closed/halted explanation.
 *
 * DESIGN.md §30: never surface a generic transaction error when the frontend
 * already knows the market state. This renders *before* the user reaches for a
 * disabled button, not after a failed transaction.
 */
export function SessionNotice({ oracle }: { oracle: Oracle }) {
  if (oracle.session === "Open") return null;

  if (oracle.session === "Closed") {
    return (
      <Notice tone="info" title={`${oracle.symbol} is closed`}>
        Opens {sessionOpensAt(oracle.nextOpenTs)}. The price has not moved since
        the last session, so new positions are unavailable. They would be a free
        bet on the next open.{" "}
        <strong>You can still reduce or close what you hold.</strong>
      </Notice>
    );
  }

  if (oracle.session === "PreOpen") {
    return (
      <Notice
        tone="warning"
        title={`${oracle.symbol} is in the opening auction`}
      >
        Indications are moving and are not firm prices. Trading resumes at{" "}
        {sessionOpensAt(oracle.nextOpenTs)}.
      </Notice>
    );
  }

  return (
    <Notice tone="danger" title={`${oracle.symbol} is halted`}>
      There is no price to mark against, so opening and closing are both
      unavailable. Settling against the pre-halt print would be guesswork.
      Positions are held until the halt lifts.
    </Notice>
  );
}

export function OracleStatus({ oracle, now }: { oracle: Oracle; now: number }) {
  const age = now - oracle.lastUpdateTs;
  const stale = oracle.session === "Open" && age > 60;
  const conf = confidencePct(oracle.price, oracle.confidence);

  return (
    <div>
      <div className="row-item" style={{ background: "var(--surface-sunken)" }}>
        <Chip small>
          <Icon name="target" size={15} />
        </Chip>
        <div className="row-main">
          <div className="row-title num">
            {usd(oracle.price, { compact: false })}
          </div>
          <div className="row-sub">
            Oracle · {conf.toFixed(1)}% confidence ·{" "}
            {ago(oracle.lastUpdateTs, now)}
          </div>
        </div>
      </div>
      {stale && (
        <div style={{ marginTop: "var(--space-2)" }}>
          <Notice tone="warning" title="Oracle update delayed">
            Last update {ago(oracle.lastUpdateTs, now)}. Trading is restricted
            until a fresh price lands.
          </Notice>
        </div>
      )}
    </div>
  );
}

/**
 * Margin health.
 *
 * The bar carries the maintenance threshold as a tick, so "how close am I" is
 * spatial rather than a number the user has to compare in their head. Risk gets
 * clearer, not louder. DESIGN.md §28.
 */
export function MarginHealth({
  marginBps,
  maintenanceBps,
  liquidationPrice,
}: {
  marginBps: bigint | null;
  maintenanceBps: number;
  liquidationPrice: bigint | null;
}) {
  if (marginBps === null) {
    return <div className="metric-sub">No open position.</div>;
  }
  const margin = Number(marginBps) / 100;
  const maintenance = maintenanceBps / 100;
  const ratio = margin / maintenance;
  const tone =
    ratio >= 2.5 ? "positive" : ratio >= 1.4 ? "warning" : "negative";
  const label =
    ratio >= 2.5 ? "Healthy" : ratio >= 1.4 ? "Thin" : "Near liquidation";

  return (
    <div>
      <div className="card-head" style={{ marginBottom: "var(--space-2)" }}>
        <span className="metric-label">Margin health</span>
        <span
          className="num"
          style={{
            fontWeight: 600,
            color:
              tone === "positive"
                ? "var(--positive)"
                : tone === "warning"
                  ? "var(--warning)"
                  : "var(--negative)",
          }}
        >
          {label}
        </span>
      </div>
      <SegBar
        value={margin}
        max={Math.max(margin * 1.2, maintenance * 4)}
        segments={14}
        tone={
          tone === "positive"
            ? "positive"
            : tone === "warning"
              ? "warning"
              : "negative"
        }
        ariaLabel={`Margin ratio ${margin.toFixed(1)} percent, maintenance ${maintenance.toFixed(1)} percent`}
      />
      <dl style={{ margin: "var(--space-3) 0 0" }}>
        <div className="metric-row">
          <dt>Current margin</dt>
          <dd className="num">{pctPlain(margin)}</dd>
        </div>
        <div className="metric-row">
          <dt>Maintenance</dt>
          <dd className="num">{pctPlain(maintenance)}</dd>
        </div>
        <div className="metric-row">
          <dt>Liquidation price</dt>
          <dd className="num">
            {liquidationPrice
              ? usd(liquidationPrice, { compact: false })
              : "n/a"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * A corporate action, explained.
 *
 * The one thing this must never do is let a split look like a crash. It states
 * the P&L impact explicitly, because zero is the surprising answer.
 */
export function CorporateActionCard({
  symbol,
  numerator,
  denominator,
  priceBefore,
  priceAfter,
  sizeBefore,
  sizeAfter,
}: {
  symbol: string;
  numerator: number;
  denominator: number;
  priceBefore: bigint;
  priceAfter: bigint;
  sizeBefore?: bigint;
  sizeAfter?: bigint;
}) {
  return (
    <section className="card" style={{ borderLeft: "4px solid var(--lime)" }}>
      <div className="card-head">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
          }}
        >
          <Chip accent>
            <Icon name="swap" />
          </Chip>
          <div>
            <h3 className="card-title">
              {symbol} · {numerator}:{denominator} stock split
            </h3>
            <div className="card-note">
              Applied on-chain, positions rescaled automatically
            </div>
          </div>
        </div>
        <StatusPill tone="lime" dot={false}>
          NO P&amp;L IMPACT
        </StatusPill>
      </div>

      <div className="rows">
        <ListRow
          title="Quoted price"
          sub="Historical prices on the chart are adjusted"
          value={
            <span>
              {usd(priceBefore, { compact: false })} →{" "}
              {usd(priceAfter, { compact: false })}
            </span>
          }
        />
        {sizeBefore !== undefined && sizeAfter !== undefined && (
          <ListRow
            title="Your position"
            sub="Exposure and cost basis unchanged"
            value={
              <span>
                {shares(sizeBefore)} → {shares(sizeAfter)} shares
              </span>
            }
          />
        )}
        <ListRow
          title="P&L impact"
          sub="A split changes the share count, not the value"
          value={<span style={{ color: "var(--positive)" }}>$0.00</span>}
        />
      </div>
    </section>
  );
}

/**
 * What an LP position actually is.
 *
 * DESIGN.md §23: do not reduce this to a yield label. The pool is the
 * counterparty to net open interest, so an LP is synthetic long the underlying
 * plus fees and funding, minus trader alpha. Showing the components is the
 * difference between an informed depositor and a surprised one.
 */
export function ExposureBreakdown({
  syntheticEquity,
  fees,
  funding,
  traderPnl,
  total,
}: {
  syntheticEquity: bigint;
  fees: bigint;
  funding: bigint;
  traderPnl: bigint;
  total: bigint;
}) {
  const parts = [
    {
      label: "Synthetic long equity",
      value: syntheticEquity,
      color: "var(--chart-1)",
    },
    { label: "Fees earned", value: fees, color: "var(--chart-2)" },
    { label: "Funding received", value: funding, color: "var(--chart-3)" },
    { label: "Trader P&L", value: traderPnl, color: "var(--chart-4)" },
  ];
  const magnitude =
    parts.reduce((a, p) => a + Math.abs(Number(p.value)), 0) || 1;

  return (
    <div>
      <div className="bar" style={{ height: 10 }}>
        {parts.map((p) => (
          <span
            key={p.label}
            style={{
              width: `${(Math.abs(Number(p.value)) / magnitude) * 100}%`,
              background: p.color,
            }}
          />
        ))}
      </div>
      <div style={{ marginTop: "var(--space-3)" }}>
        <Legend
          items={parts.map((p) => ({ label: p.label, color: p.color }))}
        />
      </div>
      <dl style={{ margin: "var(--space-3) 0 0" }}>
        {parts.map((p) => (
          <div className="metric-row" key={p.label}>
            <dt>{p.label}</dt>
            <dd className="num">{usd(p.value, { compact: false })}</dd>
          </div>
        ))}
        <div className="metric-row" style={{ fontWeight: 700 }}>
          <dt style={{ color: "var(--text-primary)" }}>Current value</dt>
          <dd className="num">{usd(total, { compact: false })}</dd>
        </div>
      </dl>
    </div>
  );
}

/** The hedge dial: where net delta sits against its target band. */
export function HedgeHealth({
  netDelta,
  stockQty,
  toleranceBps,
}: {
  netDelta: bigint;
  stockQty: bigint;
  toleranceBps: number;
}) {
  const full = Number(stockQty) || 1;
  const pos = Math.max(-1, Math.min(1, Number(netDelta) / full));
  const band = toleranceBps / 10_000;
  // Drawn width only: a narrow band would otherwise be indistinguishable from
  // the centre line. The stated tolerance above is the real value.
  const drawnBand = Math.max(band, 0.06);
  const within = Math.abs(pos) <= band;

  return (
    <div>
      <div className="card-head" style={{ marginBottom: "var(--space-2)" }}>
        <span className="metric-label">Hedge health</span>
        <StatusPill tone={within ? "open" : "preopen"}>
          {within ? "WITHIN TOLERANCE" : "REBALANCE DUE"}
        </StatusPill>
      </div>
      <div
        style={{
          position: "relative",
          height: 34,
          background: "var(--surface-sunken)",
          borderRadius: "var(--radius-pill)",
        }}
      >
        {/* the tolerance band */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: `${50 - drawnBand * 50}%`,
            width: `${drawnBand * 100}%`,
            top: 0,
            bottom: 0,
            background: "var(--lime-wash)",
            borderRadius: "var(--radius-pill)",
          }}
        />
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: "50%",
            top: 4,
            bottom: 4,
            width: 2,
            background: "var(--text-muted)",
          }}
        />
        <div
          role="meter"
          aria-valuenow={Number(netDelta)}
          aria-label="Net delta against target"
          style={{
            position: "absolute",
            left: `calc(${50 + pos * 50}% - 7px)`,
            top: 10,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: within ? "var(--lime)" : "var(--warning)",
            border: "2px solid var(--surface)",
            transition: "left var(--standard) var(--ease-out)",
          }}
        />
      </div>
      <div
        className="legend"
        style={{ marginTop: "var(--space-2)", justifyContent: "space-between" }}
      >
        <span>Short perp</span>
        <span className="metric-label">TARGET</span>
        <span>Long stock</span>
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="metric-label">{label}</div>
      <div className="num" style={{ fontWeight: 600, marginTop: 2 }}>
        {children}
      </div>
    </div>
  );
}
