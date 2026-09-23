/**
 * What each chart timeframe draws, and from which data.
 *
 * Three series feed the chart, each covering a different span:
 *
 * - **Oracle prints**: every price the keeper has published, from the keeper's
 *   history and live chain reads. Seconds apart, and reaching back roughly a
 *   trading day.
 * - **Intraday bars**: 15-minute bars for the underlying stock over the last
 *   month, from market data the keeper caches.
 * - **Daily bars**: the stock's full listing history.
 *
 * Each timeframe uses the finest series that covers it, resampled to a bar
 * width a reader can see, and the newest bar always carries the live oracle
 * price. The result is one continuous chart: years of history at the left,
 * today's oracle at the right.
 */
import type { Candle, PricePoint } from "./types";
import { candlesFrom } from "./rpc/history";

export const TIMEFRAMES = ["1H", "4H", "1D", "1W", "1M", "1Y", "5Y", "ALL"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const MIN = 60;
const HOUR = 3_600;
const DAY = 86_400;
const WEEK = 7 * DAY;

/** How far back each tab looks. `null` is everything available. */
export const TF_SECONDS: Record<Timeframe, number | null> = {
  "1H": HOUR,
  "4H": 4 * HOUR,
  "1D": DAY,
  "1W": WEEK,
  "1M": 30 * DAY,
  "1Y": 365 * DAY,
  "5Y": 5 * 365 * DAY,
  ALL: null,
};

export interface ChartInputs {
  /** Oracle prints: keeper history merged with live chain reads. */
  points: PricePoint[];
  /** 15-minute bars for the underlying, last month. */
  intraday: Candle[];
  /** Daily bars for the underlying, full history. */
  daily: Candle[];
  /** Ready-made candles, for a source with no prints (the modelled data). */
  fallback: Candle[];
  /** The live oracle price and when it was published. */
  live: { price: bigint; t: number } | null;
}

export interface TimeframeView {
  candles: Candle[];
  /**
   * What fraction of the requested window the data actually spans, or null
   * when the question does not apply.
   */
  coverage: number | null;
  /** Which series drew this view, for the attribution under the chart. */
  source: "oracle" | "intraday" | "daily" | "fallback" | "none";
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/** A bucket key for a bar width. Weeks start on Monday; months are calendar months. */
export type Period = number | "month";

function bucket(t: number, period: Period): number {
  if (period === "month") {
    const d = new Date(t * 1000);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }
  // The Unix epoch was a Thursday; shifting by four days starts weeks on Monday.
  const offset = period === WEEK ? 4 * DAY : 0;
  return Math.floor((t - offset) / period);
}

/** Combine bars into wider ones: first open, highest high, lowest low, last close. */
export function resample(bars: Candle[], period: Period): Candle[] {
  const out: Candle[] = [];
  let key: number | null = null;
  for (const b of bars) {
    const k = bucket(b.t, period);
    const cur = out[out.length - 1];
    if (cur && k === key) {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
      cur.v += b.v;
    } else {
      out.push({ ...b });
      key = k;
    }
  }
  return out;
}

/**
 * Fold the live oracle price into the newest bar, or open a new bar for it.
 *
 * This is what makes a chart of daily history live: the rightmost daily
 * candle moves with every publish, the way a terminal's does.
 */
export function withLive(
  bars: Candle[],
  live: { price: bigint; t: number } | null,
  period: Period,
): Candle[] {
  if (!live || live.price <= 0n || bars.length === 0) return bars;
  const last = bars[bars.length - 1];
  if (live.t < last.t) return bars;
  const out = bars.slice(0, -1);
  if (bucket(live.t, period) === bucket(last.t, period)) {
    out.push({
      ...last,
      c: live.price,
      h: live.price > last.h ? live.price : last.h,
      l: live.price < last.l ? live.price : last.l,
    });
  } else {
    out.push(last, {
      t: live.t,
      o: last.c,
      h: live.price > last.c ? live.price : last.c,
      l: live.price < last.c ? live.price : last.c,
      c: live.price,
      v: 0n,
    });
  }
  return out;
}

function within(bars: Candle[], seconds: number | null, anchor: number): Candle[] {
  if (seconds === null) return bars;
  return bars.filter((b) => b.t >= anchor - seconds);
}

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

/** Prints re-bucketed inside the window, measured from the last print. */
function fromPrints(points: PricePoint[], window: number | null): TimeframeView {
  if (points.length === 0) return { candles: [], coverage: null, source: "none" };
  const newest = points[points.length - 1].t;
  const inWindow = window === null ? points : points.filter((p) => p.t >= newest - window);
  return {
    candles: candlesFrom(inWindow),
    coverage:
      window === null || inWindow.length < 2
        ? null
        : (inWindow[inWindow.length - 1].t - inWindow[0].t) / window,
    source: "oracle",
  };
}

/** Bars clipped to a window measured from the newest bar, resampled, made live. */
function fromBars(
  bars: Candle[],
  window: number | null,
  period: Period,
  live: ChartInputs["live"],
  source: TimeframeView["source"],
): TimeframeView {
  if (bars.length === 0) return { candles: [], coverage: null, source: "none" };
  const anchor = Math.max(bars[bars.length - 1].t, live?.t ?? 0);
  const clipped = within(bars, window, anchor);
  const candles = withLive(resample(clipped, period), live, period);
  return { candles, coverage: null, source };
}

/** A source with ready-made candles and no prints: filter by window only. */
function fromFallback(bars: Candle[], window: number | null): TimeframeView {
  if (bars.length === 0) return { candles: [], coverage: null, source: "none" };
  const last = bars[bars.length - 1].t;
  const inWindow = window === null ? bars : bars.filter((c) => c.t >= last - window);
  // Fixed-width bars in a window narrower than a few of them would hold one
  // bar and no chart; show the last few instead.
  return {
    candles: inWindow.length >= 3 ? inWindow : bars.slice(-12),
    coverage: null,
    source: "fallback",
  };
}

const usable = (v: TimeframeView) => v.candles.length >= 3;

/**
 * The candles for one timeframe tab.
 *
 * Each tab tries the series that suits it best and falls back to the next,
 * so a missing source degrades the chart rather than blanking it.
 */
export function buildTimeframe(tf: Timeframe, input: ChartInputs): TimeframeView {
  const window = TF_SECONDS[tf];
  const { points, intraday, daily, live } = input;

  const attempts: (() => TimeframeView)[] = [];
  switch (tf) {
    case "1H":
    case "4H":
      attempts.push(
        () => fromPrints(points, window),
        () => fromBars(intraday, window, 15 * MIN, live, "intraday"),
      );
      break;
    case "1D":
      attempts.push(
        () => fromBars(intraday, window, 15 * MIN, live, "intraday"),
        () => fromPrints(points, window),
      );
      break;
    case "1W":
      attempts.push(
        () => fromBars(intraday, window, 30 * MIN, live, "intraday"),
        () => fromBars(daily, window, DAY, live, "daily"),
      );
      break;
    case "1M":
      attempts.push(
        () => fromBars(intraday, window, 2 * HOUR, live, "intraday"),
        () => fromBars(daily, window, DAY, live, "daily"),
      );
      break;
    case "1Y":
      attempts.push(() => fromBars(daily, window, DAY, live, "daily"));
      break;
    case "5Y":
      attempts.push(() => fromBars(daily, window, WEEK, live, "daily"));
      break;
    case "ALL": {
      // Weekly bars up to about fifteen years; monthly beyond, so a listing
      // that goes back to 1980 is a few hundred bars rather than thousands.
      const span = daily.length ? daily[daily.length - 1].t - daily[0].t : 0;
      const period: Period = span > 15 * 365 * DAY ? "month" : WEEK;
      attempts.push(() => fromBars(daily, null, period, live, "daily"));
      break;
    }
  }
  // Last resorts, in order: whatever the oracle has, then modelled candles.
  attempts.push(
    () => fromPrints(points, window),
    () => fromFallback(input.fallback, window),
  );

  let best: TimeframeView = { candles: [], coverage: null, source: "none" };
  for (const attempt of attempts) {
    const view = attempt();
    if (usable(view)) return view;
    if (view.candles.length > best.candles.length) best = view;
  }
  return best;
}
