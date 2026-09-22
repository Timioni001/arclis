/**
 * The market chart: candles, volume, crosshair, and position markers.
 *
 * Inline SVG rather than a charting library, for three reasons that matter
 * here: the marks have to carry protocol meaning (entry, liquidation, a split),
 * the colours have to come from the design tokens so light and dark are each
 * validated rather than flipped, and a hackathon reviewer should be able to
 * read the whole chart in one file.
 *
 * Interaction follows the standard: crosshair snaps to a candle, one tooltip,
 * hit targets wider than the marks.
 */
import { useMemo, useRef, useState } from "react";
import type { Candle } from "../../lib/protocol/types";
import { usd } from "../../lib/format";

export interface PriceMarker {
  price: bigint;
  label: string;
  tone: "entry" | "liquidation" | "oracle";
}

export interface EventMarker {
  t: number;
  label: string;
  detail: string;
}

const PAD = { top: 12, right: 58, bottom: 20, left: 8 };

/**
 * Below this, there is no chart to draw and pretending otherwise is worse
 * than saying so.
 *
 * One published price renders as a single dot at the far left with the oracle
 * marker running across the plot beside it, which reads as a broken chart
 * rather than as a market that has not traded. And a market that has not
 * traded is the normal overnight state: the keeper refuses to republish an
 * unchanged print - doing so would launder a stale price into a fresh one -
 * so the series legitimately stops growing when the venue closes.
 */
const MIN_CANDLES = 3;
const VOL_H = 40;

/**
 * The vertical domain the chart is drawn against.
 *
 * Extracted from the component because the interesting case has no pixels in
 * it: a market that has not moved. Overnight, at a weekend, or in the minutes
 * after the keeper first catches up, every candle carries the same price, and
 * the naive domain is then zero wide.
 *
 * `priceMax - priceMin || 1` used to be the guard, which is worse than no
 * guard at all: prices are integers at 1e6 scale, so it produced a domain one
 * *millionth of a dollar* tall. Every axis label formatted to the same number,
 * the whole series sat on one line, and the chart read as broken rather than
 * as still.
 *
 * So a still market gets a floor: the domain is never narrower than
 * `MIN_SPAN_BPS` of the price itself, centred on it. The line still sits flat
 * in the middle - it should, nothing moved - but the axis around it is real,
 * and a move starting mid-session opens the scale out naturally.
 */
const MIN_SPAN_BPS = 40; // 0.4% of price, split either side
/** How far a marker may stretch the domain past the candles themselves. */
const MARKER_ALLOWANCE = 0.45;
/** Breathing room above and below, once the domain is settled. */
const PADDING = 0.06;

export function priceDomain(
  candles: Candle[],
  markers: PriceMarker[] = [],
): { min: number; max: number } {
  const priceMin = Math.min(...candles.map((c) => Number(c.l)));
  const priceMax = Math.max(...candles.map((c) => Number(c.h)));
  const priceSpan = priceMax - priceMin;

  // The price series owns the scale. A marker may widen the domain, but only
  // so far: a liquidation price 40% below spot would otherwise compress the
  // whole candle series into a few pixels at the top of the plot. Markers
  // outside the allowance are pinned to the edge and flagged instead.
  //
  // The allowance is measured against the floor, not against the raw span,
  // or a still market would let any marker take the scale over completely.
  const reach = Math.max(priceSpan, (priceMax * MIN_SPAN_BPS) / 10_000);
  let min = priceMin;
  let max = priceMax;
  for (const mk of markers) {
    const v = Number(mk.price);
    if (v < min) min = Math.max(v, priceMin - reach * MARKER_ALLOWANCE);
    if (v > max) max = Math.min(v, priceMax + reach * MARKER_ALLOWANCE);
  }

  let span = max - min;
  const floor = Math.max((priceMax * MIN_SPAN_BPS) / 10_000, 1);
  if (span < floor) {
    const mid = (max + min) / 2;
    min = mid - floor / 2;
    max = mid + floor / 2;
    span = floor;
  }

  return { min: min - span * PADDING, max: max + span * PADDING };
}

export function PriceChart({
  candles,
  height = 340,
  markers = [],
  events = [],
  mode = "candles",
}: {
  candles: Candle[];
  height?: number;
  markers?: PriceMarker[];
  events?: EventMarker[];
  mode?: "candles" | "area";
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000; // viewBox width; SVG scales to the container

  const geom = useMemo(() => {
    if (!candles.length) return null;
    const plotH = height - PAD.top - PAD.bottom - VOL_H;
    const { min, max } = priceDomain(candles, markers);

    const plotW = W - PAD.left - PAD.right;
    const x = (i: number) =>
      PAD.left + (i / Math.max(1, candles.length - 1)) * plotW;
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * plotH;
    const maxVol = Math.max(...candles.map((c) => Number(c.v))) || 1;
    const vy = (v: number) => height - PAD.bottom - (v / maxVol) * VOL_H;

    const bw = Math.max(1.5, (plotW / candles.length) * 0.58);
    return { x, y, vy, min, max, plotH, plotW, bw };
  }, [candles, height, markers]);

  if (!geom) return <div className="skeleton" style={{ height }} />;

  /*
   * Too little to chart: say so, rather than draw a dot.
   *
   * The price and its context are on the screen already - the header carries
   * the last price and the session banner explains why it is not moving - so
   * this only has to be honest about the series, and get out of the way.
   */
  if (candles.length < MIN_CANDLES) {
    const only = candles[candles.length - 1];
    return (
      <div className="chart-sparse" style={{ height }}>
        <div className="chart-sparse-price">
          {usd(only.c, { compact: false, dp: 2 })}
        </div>
        <p>
          {candles.length === 1
            ? "One price published so far"
            : `${candles.length} prices published so far`}
          . A chart needs a few more.
        </p>
        <p className="chart-sparse-why">
          The series is built from the oracle's own publishes. While the venue
          is closed the keeper refuses to republish an unchanged price, so it
          stops growing until the next session opens.
        </p>
      </div>
    );
  }
  const { x, y, vy, min, max, bw } = geom;
  /** Clamp a marker into the plot, reporting whether it was off-scale. */
  const place = (v: number) => {
    const clamped = Math.max(min, Math.min(max, v));
    return { y: y(clamped), off: v < min ? "below" : v > max ? "above" : null };
  };

  const ticks = 4;
  const gridValues = Array.from(
    { length: ticks + 1 },
    (_, i) => min + ((max - min) * i) / ticks,
  );

  const areaPath =
    "M " +
    candles
      .map((c, i) => `${x(i).toFixed(2)} ${y(Number(c.c)).toFixed(2)}`)
      .join(" L ") +
    ` L ${x(candles.length - 1).toFixed(2)} ${height - PAD.bottom - VOL_H} L ${PAD.left} ${
      height - PAD.bottom - VOL_H
    } Z`;
  const linePath =
    "M " +
    candles
      .map((c, i) => `${x(i).toFixed(2)} ${y(Number(c.c)).toFixed(2)}`)
      .join(" L ");

  /** Every bar is a single print: no bodies, no wicks, nothing to connect. */
  const allDojis = candles.every(
    (c) => c.o === c.h && c.h === c.l && c.l === c.c,
  );

  const active = hover !== null ? candles[hover] : null;
  const last = candles[candles.length - 1];

  /** Up to four evenly spaced labels, in the reader's own timezone. */
  const timeTicks = (() => {
    if (candles.length < 2) return [];
    const wanted = Math.min(4, candles.length);
    const step = (candles.length - 1) / (wanted - 1);
    const seen = new Set<number>();
    return Array.from({ length: wanted }, (_, n) => Math.round(n * step))
      .filter((i) => !seen.has(i) && seen.add(i) !== undefined)
      .map((i) => ({
        i,
        label: new Date(candles[i].t * 1000).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }),
      }));
  })();
  const up = (c: Candle) => c.c >= c.o;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(
      ((rel - PAD.left) / (W - PAD.left - PAD.right)) * (candles.length - 1),
    );
    setHover(Math.max(0, Math.min(candles.length - 1, i)));
  }

  const markerColor = (tone: PriceMarker["tone"]) =>
    tone === "entry"
      ? "var(--chart-1)"
      : tone === "liquidation"
        ? "var(--negative)"
        : "var(--chart-2)";

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${height}`}
        height={height}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Price chart, ${candles.length} periods, last ${usd(last.c)}`}
      >
        {gridValues.map((v, i) => (
          <g key={i}>
            <line
              className="chart-grid-line"
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
            />
            {/* Suppressed where the last-price badge sits: two prices in
                the same place, one printed over the other, reads as a
                rendering fault rather than as two facts. */}
            {Math.abs(y(v) - y(Number(last.c))) > 11 && (
              <text
                className="chart-axis-label"
                x={W - PAD.right + 6}
                y={y(v) + 3}
              >
                {usd(BigInt(Math.round(v)), { compact: false, dp: 2 })}
              </text>
            )}
          </g>
        ))}

        {mode === "area" ? (
          <>
            <defs>
              <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="var(--chart-1)"
                  stopOpacity="0.28"
                />
                <stop
                  offset="100%"
                  stopColor="var(--chart-1)"
                  stopOpacity="0"
                />
              </linearGradient>
            </defs>
            <path d={areaPath} fill="url(#areaFill)" />
            <path
              d={linePath}
              fill="none"
              stroke="var(--chart-1)"
              strokeWidth={2}
            />
          </>
        ) : (
          <>
            {/*
              A guide line through the closes, drawn only when every bar is a
              doji.

              A bucket holding one print has open, high, low and close all
              equal, so the bar is a flat two-pixel dash with no wick. A row of
              those at different heights is a correct drawing of the data and
              an unreadable one: it looks like a broken renderer rather than a
              price that moved. `candlesFrom` now buckets wide enough that this
              is rare, but "rare" is not "never" on a series with irregular
              gaps, and a chart must never look broken.

              Only when *every* bar is a doji. One flat bar inside a normal
              series is information, and drawing a line through those would be
              adding a second series nobody asked for.
            */}
            {allDojis && (
              <path
                d={linePath}
                fill="none"
                stroke="var(--chart-1)"
                strokeWidth={1}
                opacity={0.45}
              />
            )}
            {candles.map((c, i) => {
            const col = up(c) ? "var(--positive)" : "var(--negative)";
            const oy = y(Number(c.o));
            const cy = y(Number(c.c));
            const top = Math.min(oy, cy);
            // Two pixels, not one. A candle whose open and close match has a
            // zero-height body, and at one pixel against a narrow bar it
            // renders as a speck rather than as the flat bar a still period
            // actually is.
            const bodyH = Math.max(2, Math.abs(cy - oy));
            return (
              <g key={i}>
                <line
                  x1={x(i)}
                  x2={x(i)}
                  y1={y(Number(c.h))}
                  y2={y(Number(c.l))}
                  stroke={col}
                  strokeWidth={1}
                />
                <rect
                  x={x(i) - bw / 2}
                  y={top}
                  width={bw}
                  height={bodyH}
                  fill={col}
                  rx={1}
                />
              </g>
            );
            })}
          </>
        )}

        {/* The time axis. Four labels, evenly spaced, so the series reads as
            a period rather than as an abstract line. */}
        {timeTicks.map((tick) => (
          <text
            key={`t${tick.i}`}
            className="chart-axis-label"
            x={x(tick.i)}
            y={height - 4}
            textAnchor={
              tick.i === 0
                ? "start"
                : tick.i === candles.length - 1
                  ? "end"
                  : "middle"
            }
          >
            {tick.label}
          </text>
        ))}

        {/* The last price, pinned to the axis it belongs on. The one piece of
            furniture every trading chart has, and the fastest way to read
            where the market is without hunting along a gridline. */}
        <g className="chart-last" data-dir={up(last) ? "up" : "down"}>
          <rect
            x={W - PAD.right + 2}
            y={y(Number(last.c)) - 9}
            width={PAD.right - 4}
            height={18}
            rx={3}
          />
          <text x={W - PAD.right + 6} y={y(Number(last.c)) + 4}>
            {usd(last.c, { compact: false, dp: 2 })}
          </text>
        </g>

        {/* Volume pane, same colour language, recessive opacity. */}
        {candles.map((c, i) => (
          <rect
            key={`v${i}`}
            x={x(i) - bw / 2}
            y={vy(Number(c.v))}
            width={bw}
            height={height - PAD.bottom - vy(Number(c.v))}
            fill={up(c) ? "var(--positive)" : "var(--negative)"}
            opacity={0.22}
            rx={1}
          />
        ))}

        {markers.map((mk, mi) => {
          const at = place(Number(mk.price));
          return (
            <g key={mk.label}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={at.y}
                y2={at.y}
                stroke={markerColor(mk.tone)}
                strokeWidth={1.5}
                strokeDasharray={at.off ? "2 5" : "5 4"}
                opacity={at.off ? 0.55 : 0.85}
              />
              {/* Anchored to the price axis, where a reader already looks for a
                  price, and staggered so two nearby markers never overprint.
                  The left edge is reserved for event markers. */}
              <text
                className="chart-axis-label"
                x={W - PAD.right - 6}
                y={at.y + (mi % 2 === 0 ? -5 : 11)}
                textAnchor="end"
                fill={markerColor(mk.tone)}
                style={{ fontWeight: 600 }}
              >
                {mk.label}
                {at.off === "below"
                  ? " ↓ off-scale"
                  : at.off === "above"
                    ? " ↑ off-scale"
                    : ""}
              </text>
            </g>
          );
        })}

        {/* A corporate action is annotated, never rendered as a price move. */}
        {events.map((ev) => {
          const idx = candles.findIndex((c) => c.t >= ev.t);
          if (idx < 0) return null;
          return (
            <g key={ev.label}>
              <line
                x1={x(idx)}
                x2={x(idx)}
                y1={PAD.top}
                y2={height - PAD.bottom - VOL_H}
                stroke="var(--chart-4)"
                strokeWidth={1.5}
                strokeDasharray="2 3"
              />
              <circle
                cx={x(idx)}
                cy={PAD.top + 5}
                r={5}
                fill="var(--chart-4)"
                stroke="var(--surface)"
                strokeWidth={2}
              />
              <text
                className="chart-axis-label"
                x={x(idx) + 9}
                y={PAD.top + 9}
                fill="var(--chart-4)"
                style={{ fontWeight: 600 }}
              >
                {ev.label}
              </text>
            </g>
          );
        })}

        {/* Last price marker */}
        <circle
          cx={x(candles.length - 1)}
          cy={y(Number(last.c))}
          r={4}
          fill="var(--chart-1)"
          stroke="var(--surface)"
          strokeWidth={2}
        />

        {hover !== null && (
          <>
            <line
              className="chart-crosshair"
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={height - PAD.bottom}
            />
            <circle
              cx={x(hover)}
              cy={y(Number(candles[hover].c))}
              r={4.5}
              fill="var(--chart-1)"
              stroke="var(--surface)"
              strokeWidth={2}
            />
          </>
        )}
      </svg>

      {active && hover !== null && (
        <div
          className="tooltip"
          style={{
            left: `clamp(0px, ${((x(hover) / W) * 100).toFixed(2)}% - 70px, calc(100% - 150px))`,
            top: 6,
          }}
        >
          <div className="tooltip-time">
            {new Date(active.t * 1000).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
          <dl style={{ margin: 0 }}>
            {(
              [
                ["O", active.o],
                ["H", active.h],
                ["L", active.l],
                ["C", active.c],
              ] as const
            ).map(([k, v]) => (
              <div className="tooltip-row" key={k}>
                <dt>{k}</dt>
                <dd style={{ margin: 0 }}>{usd(v, { compact: false })}</dd>
              </div>
            ))}
            <div className="tooltip-row">
              <dt>Vol</dt>
              <dd style={{ margin: 0 }}>{usd(active.v)}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

/** A bare trend line for market cards. No axes, no interaction. */
export function Sparkline({
  candles,
  width = 108,
  height = 30,
}: {
  candles: Candle[];
  width?: number;
  height?: number;
}) {
  if (candles.length < 2) return null;
  const vals = candles.map((c) => Number(c.c));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals
    .map(
      (v, i) =>
        `${(i / (vals.length - 1)) * width},${height - ((v - min) / span) * height}`,
    )
    .join(" ");
  const rising = vals[vals.length - 1] >= vals[0];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
    >
      <polyline
        points={pts}
        fill="none"
        stroke={rising ? "var(--positive)" : "var(--negative)"}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
