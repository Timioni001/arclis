/**
 * The market chart: candles or area, live, over the oracle's own prices.
 *
 * # Why Lightweight Charts
 *
 * This was a hand-drawn SVG, and it hit the limits a hand-drawn chart always
 * does: a candle centred on the first bar was half outside the plot and past
 * the card's edge, the time axis was four labels, the crosshair was bespoke,
 * and none of it followed a pointer or a pinch the way a trader expects.
 * TradingView's Lightweight Charts (Apache-2.0, about 45 KB) is the charting
 * layer most crypto venues use for exactly this: canvas-rendered and clipped
 * to its container, with a real time scale, crosshair, price axis, pan and
 * zoom, and incremental updates for a live series.
 *
 * What is still ours is the part a library cannot know: the price scale's
 * floor. A market that has not moved would otherwise autoscale a one-cent
 * range across the whole plot and draw noise as drama, so `priceDomain` is fed
 * in as the autoscale provider.
 *
 * Times are shown in the viewer's own timezone. The library works in UTC
 * seconds; the formatters below convert for display only.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type MouseEventParams,
  type ISeriesApi,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { Icon } from "../ui";
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

/** Fewer bars than this is a list of prices, not a chart. */
const MIN_CANDLES = 3;

/** The smallest range the price axis will span, in bps of price. */
const MIN_SPAN_BPS = 40; // 0.4% of price, split either side

/**
 * The placeholder skyline, as percentages of the plot height.
 *
 * Fixed rather than random so the shape is stable across renders: a
 * placeholder that reshuffles itself draws the eye to the wrong thing.
 */
const SKELETON_BARS = [
  38, 52, 45, 61, 57, 70, 64, 49, 58, 72, 66, 80, 74, 62, 69, 55, 47, 60, 68,
  76,
];

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

/** Protocol price scale (1e6) to dollars, for the chart. */
const px = (v: bigint) => Number(v) / 1_000_000;

/** A CSS custom property, resolved against the current theme. */
function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function palette() {
  return {
    text: token("--text-muted", "#6a7368"),
    grid: token("--border-soft", "#f0f2ef"),
    up: token("--positive", "#16a34a"),
    down: token("--negative", "#dc2626"),
    line: token("--chart-1", "#65a30d"),
    entry: token("--chart-2", "#6366f1"),
  };
}

/**
 * An axis label for a tick, at the granularity the library says it marks.
 *
 * The library passes the kind of boundary each tick sits on: a new year, a
 * new month, a new day, or a time within a day. Formatting every tick as a
 * time of day, as this first did, labelled a five-year chart of daily bars
 * "06:00 AM" at every tick, because every daily bar opens at the same hour.
 */
export function tickLabel(t: Time, kind: TickMarkType): string {
  const d = new Date((t as number) * 1000);
  switch (kind) {
    case TickMarkType.Year:
      return String(d.getFullYear());
    case TickMarkType.Month:
      return d.toLocaleDateString(undefined, {
        month: "short",
        year: "2-digit",
      });
    case TickMarkType.DayOfMonth:
      return d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    default:
      return d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
  }
}

/**
 * The crosshair's date label: a date for bars a day wide or wider, a date and
 * time for intraday bars. A daily bar's open time is an artefact of the data
 * source, not something a reader should be shown.
 */
function crosshairLabel(t: Time, intraday: boolean): string {
  const d = new Date((t as number) * 1000);
  return intraday
    ? d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : d.toLocaleDateString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function PriceChart({
  candles,
  markers = [],
  events = [],
  mode = "candles",
  height,
  title,
  controls,
}: {
  candles: Candle[];
  markers?: PriceMarker[];
  events?: EventMarker[];
  mode?: "candles" | "area";
  /**
   * A fixed height in pixels. Without one the chart takes its height from
   * the screen (see `.chart-fluid`), which is what lets it work on a phone
   * held either way up.
   */
  height?: number;
  /** Shown above the chart when it is expanded to the full screen. */
  title?: string;
  /** The page's own chart controls (type, timeframe), repeated full screen. */
  controls?: ReactNode;
}) {
  const [full, setFull] = useState(false);
  const [hover, setHover] = useState<Readout | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<SeriesType> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const firstT = useRef<number | null>(null);
  const seriesMode = useRef<"candles" | "area" | null>(null);

  const domain = useMemo(
    () => (candles.length ? priceDomain(candles, markers) : null),
    [candles, markers],
  );
  // Read inside the autoscale callback, which the library calls on its own
  // schedule, so it always sees the current series rather than the first.
  const domainRef = useRef(domain);
  domainRef.current = domain;

  const hasVolume = candles.some((c) => c.v > 0n);
  // Bars narrower than about a day are intraday; read by the crosshair
  // formatter, which the library calls on its own schedule.
  const intraday =
    candles.length < 2 ||
    candles[candles.length - 1].t - candles[candles.length - 2].t < 20 * 3_600;
  const intradayRef = useRef(intraday);
  intradayRef.current = intraday;
  const drawable = candles.length >= MIN_CANDLES;

  // The chart itself: created once, themed, and torn down with the component.
  useEffect(() => {
    if (!drawable || !box.current) return;
    const colors = palette();
    let api: IChartApi;
    try {
      api = createChart(box.current, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: colors.text,
          fontFamily: "inherit",
          attributionLogo: false,
        },
        // Horizontal rules only: price levels are what a reader lines up
        // against; vertical rules add ink without adding a reading.
        grid: {
          vertLines: { visible: false },
          horzLines: { color: colors.grid },
        },
        rightPriceScale: {
          borderVisible: false,
          scaleMargins: { top: 0.12, bottom: 0.12 },
        },
        timeScale: {
          borderVisible: false,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 4,
          tickMarkFormatter: tickLabel,
        },
        crosshair: { mode: CrosshairMode.Normal },
        localization: {
          timeFormatter: (t: Time) => crosshairLabel(t, intradayRef.current),
          priceFormatter: (p: number) =>
            usd(BigInt(Math.round(p * 1e6)), { compact: false }),
        },
        // Vertical drags scroll the page on a phone rather than the chart,
        // which is what a reader scrolling past it expects.
        handleScroll: { vertTouchDrag: false },
      });
    } catch {
      // No canvas (a test environment, or a browser with it disabled): the
      // container stays, empty, rather than taking the page down.
      return;
    }
    chart.current = api;

    // Re-theme when the reader switches light and dark.
    const observer = new MutationObserver(() => {
      const c = palette();
      api.applyOptions({
        layout: { textColor: c.text },
        grid: { horzLines: { color: c.grid } },
      });
      series.current?.applyOptions(
        seriesMode.current === "area"
          ? {
              lineColor: c.line,
              topColor: `${c.line}55`,
              bottomColor: `${c.line}05`,
            }
          : {
              upColor: c.up,
              downColor: c.down,
              wickUpColor: c.up,
              wickDownColor: c.down,
            },
      );
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      observer.disconnect();
      // Detach the resize observer before disposing. Otherwise the container
      // leaving the page triggers one last resize into a chart that no longer
      // exists, and the library throws "Object is disposed".
      api.applyOptions({ autoSize: false });
      api.remove();
      chart.current = null;
      series.current = null;
      seriesMode.current = null;
      volume.current = null;
      firstT.current = null;
    };
    // Only `drawable`: switching candles and area swaps the series below and
    // keeps this chart. Recreating the chart on a mode switch left the
    // library's resize observer firing into a disposed instance.
  }, [drawable]);

  // The series, its data, and everything drawn on it.
  useEffect(() => {
    const api = chart.current;
    if (!api || !drawable) return;
    const colors = palette();

    // A mode switch replaces the series on the same chart.
    if (series.current && seriesMode.current !== mode) {
      api.removeSeries(series.current);
      series.current = null;
      firstT.current = null;
    }

    if (!series.current) {
      seriesMode.current = mode;
      const autoscaleInfoProvider = () => {
        const d = domainRef.current;
        return d
          ? { priceRange: { minValue: d.min / 1e6, maxValue: d.max / 1e6 } }
          : null;
      };
      series.current =
        mode === "area"
          ? api.addSeries(AreaSeries, {
              lineColor: colors.line,
              lineWidth: 2,
              topColor: `${colors.line}55`,
              bottomColor: `${colors.line}05`,
              autoscaleInfoProvider,
            })
          : api.addSeries(CandlestickSeries, {
              upColor: colors.up,
              downColor: colors.down,
              borderVisible: false,
              wickUpColor: colors.up,
              wickDownColor: colors.down,
              autoscaleInfoProvider,
            });
    }

    api.timeScale().applyOptions({ timeVisible: intraday });

    const s = series.current;
    s.setData(
      candles.map((c) =>
        mode === "area"
          ? { time: c.t as UTCTimestamp, value: px(c.c) }
          : {
              time: c.t as UTCTimestamp,
              open: px(c.o),
              high: px(c.h),
              low: px(c.l),
              close: px(c.c),
            },
      ),
    );

    if (hasVolume) {
      volume.current ??= api.addSeries(HistogramSeries, {
        priceScaleId: "volume",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      api
        .priceScale("volume")
        .applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      api
        .priceScale("right")
        .applyOptions({ scaleMargins: { top: 0.12, bottom: 0.2 } });
      volume.current.setData(
        candles.map((c) => ({
          time: c.t as UTCTimestamp,
          value: Number(c.v) / 1e6,
          color: `${c.c >= c.o ? colors.up : colors.down}40`,
        })),
      );
    }

    // Entry and liquidation as price lines on the axis, the way every venue
    // draws them.
    const lines = markers.map((m) =>
      s.createPriceLine({
        price: px(m.price),
        color: m.tone === "liquidation" ? colors.down : colors.entry,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: m.label,
      }),
    );

    // Corporate actions, pinned to the bar they happened in.
    const eventMarkers = createSeriesMarkers(
      s,
      events
        .map((e) => {
          const bar = [...candles].reverse().find((c) => c.t <= e.t);
          return bar
            ? {
                time: bar.t as UTCTimestamp,
                position: "aboveBar" as const,
                shape: "circle" as const,
                color: colors.entry,
                text: e.label,
              }
            : null;
        })
        .filter((m): m is NonNullable<typeof m> => m !== null),
    );

    // The readout above the plot follows the crosshair, bar by bar.
    const onMove = (param: MouseEventParams) => {
      const d = param.time !== undefined ? param.seriesData.get(s) : undefined;
      setHover(d ? readoutOf(d, param.time as number) : null);
    };
    api.subscribeCrosshairMove(onMove);

    // Fit on first draw and when the window changes (a new first bar); leave
    // the reader's pan and zoom alone on a live update.
    const first = candles[0]?.t ?? null;
    if (firstT.current !== first) {
      api.timeScale().fitContent();
      firstT.current = first;
    }

    return () => {
      // On unmount the chart effect's cleanup has already removed the chart,
      // and with it everything drawn on it; there is nothing left to detach.
      try {
        api.unsubscribeCrosshairMove(onMove);
        for (const l of lines) s.removePriceLine(l);
        eventMarkers.detach();
      } catch {
        /* chart already disposed */
      }
    };
  }, [candles, markers, events, mode, drawable, hasVolume, intraday]);

  // Full screen: the page behind stops scrolling, a drag on the plot moves it
  // both ways (on the page a vertical drag scrolls the page instead), and
  // Escape comes back.
  useEffect(() => {
    chart.current?.applyOptions({ handleScroll: { vertTouchDrag: full } });
    if (!full) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [full]);

  const resetView = () => {
    const api = chart.current;
    if (!api) return;
    api.timeScale().fitContent();
    api.priceScale("right").applyOptions({ autoScale: true });
  };

  const sized = (className: string) => ({
    className: height ? className : `${className} chart-fluid`,
    style: height ? { height } : undefined,
  });

  if (!candles.length) {
    return (
      <div
        {...sized("skeleton-chart")}
        role="status"
        aria-label="Loading price history"
      >
        {SKELETON_BARS.map((h, i) => (
          <span
            key={i}
            className="skeleton"
            style={{ height: `${h}%`, borderRadius: 3 }}
          />
        ))}
      </div>
    );
  }

  /*
   * Too little to chart: say so, rather than draw a dot.
   *
   * The price and its context are on the screen already - the header carries
   * the last price and the session banner explains why it is not moving - so
   * this only has to be honest about the series, and get out of the way.
   */
  if (!drawable) {
    const only = candles[candles.length - 1];
    return (
      <div {...sized("chart-sparse")}>
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

  const last = candles[candles.length - 1];
  const shown: Readout = hover ?? {
    t: last.t,
    o: px(last.o),
    h: px(last.h),
    l: px(last.l),
    c: px(last.c),
  };
  const change = shown.o ? ((shown.c - shown.o) / shown.o) * 100 : 0;
  const money = (v: number) => usd(v, { compact: false });

  return (
    <div
      className="chart-frame"
      data-full={full || undefined}
      role={full ? "dialog" : undefined}
      aria-modal={full || undefined}
      aria-label={full ? `${title ?? "Price"} chart, full screen` : undefined}
    >
      {full && (
        <div className="chart-full-head">
          {title && <strong className="chart-full-title">{title}</strong>}
          {controls && <div className="chart-controls">{controls}</div>}
        </div>
      )}
      <div className="chart-stage">
        <div className="chart-bar">
          <div className="chart-legend num" aria-hidden="true">
            {mode === "candles" && shown.h !== undefined ? (
              <>
                <span>
                  O <b>{money(shown.o)}</b>
                </span>
                <span>
                  H <b>{money(shown.h)}</b>
                </span>
                <span>
                  L <b>{money(shown.l!)}</b>
                </span>
                <span>
                  C <b>{money(shown.c)}</b>
                </span>
              </>
            ) : (
              <span>
                <b>{money(shown.c)}</b>
              </span>
            )}
            {mode === "candles" && (
              <span
                data-tone={change > 0 ? "up" : change < 0 ? "down" : undefined}
              >
                {change > 0 ? "+" : ""}
                {change.toFixed(2)}%
              </span>
            )}
            <span className="chart-legend-time">
              {crosshairLabel(shown.t as Time, intraday)}
            </span>
          </div>
          <div className="chart-tools">
            <button
              type="button"
              className="chart-tool"
              onClick={resetView}
              aria-label="Reset the chart view"
              title="Reset view"
            >
              <Icon name="reset" size={16} />
            </button>
            <button
              type="button"
              className="chart-tool"
              onClick={() => setFull((f) => !f)}
              aria-label={
                full ? "Leave full screen" : "Expand the chart to full screen"
              }
              aria-pressed={full}
              title={full ? "Exit full screen (Esc)" : "Full screen"}
            >
              <Icon name={full ? "collapse" : "expand"} size={16} />
            </button>
          </div>
        </div>
        <div
          ref={box}
          className={height ? "chart-live" : "chart-live chart-fluid"}
          style={height && !full ? { height } : undefined}
          role="img"
          aria-label={`Price chart, ${candles.length} bars, last ${usd(last.c, { compact: false })}`}
        />
      </div>
    </div>
  );
}

/** One bar as the readout shows it, in dollars. */
interface Readout {
  t: number;
  o: number;
  h?: number;
  l?: number;
  c: number;
}

function readoutOf(d: object, t: number): Readout | null {
  if ("close" in d) {
    const b = d as { open: number; high: number; low: number; close: number };
    return { t, o: b.open, h: b.high, l: b.low, c: b.close };
  }
  if ("value" in d) {
    const v = (d as { value: number }).value;
    return { t, o: v, c: v };
  }
  return null;
}

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
