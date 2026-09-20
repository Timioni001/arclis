/**
 * The NYSE trading calendar, as a pure function of time.
 *
 * # Why this file is the most important one in `keeper/`
 *
 * Every equity-specific guarantee Arclis makes reduces to one question: is the
 * venue open right now? The program enforces the consequences (no increasing
 * risk against a frozen price, no funding while shut, no corporate action
 * mid-session) but it cannot know the answer. Something off-chain has to
 * decide, and if that thing is wrong the on-chain rules are wrong with it.
 *
 * Getting it wrong in either direction costs real money:
 *
 *   - Saying **Open** while the venue is shut lets somebody open a position
 *     against a stale print. That is the free weekend option the whole session
 *     design exists to refuse.
 *   - Saying **Closed** while it is open traps traders who want out and stops
 *     funding accruing on a live imbalance.
 *
 * So this is pure: unix seconds in, `MarketSession` out. No network, no clock
 * of its own, no state. Everything it knows is in the tables below, and every
 * rule has a test with a date somebody can check against a real calendar.
 *
 * # Time zones without a time-zone library
 *
 * The NYSE runs on America/New_York, which is US Eastern with daylight saving.
 * Rather than take a dependency, this uses `Intl.DateTimeFormat` with that
 * time zone, which is in every runtime that matters and is backed by the same
 * IANA database a library would ship. The one rule is that no calculation is
 * ever done in local time: the formatter converts once, and the rest is
 * arithmetic on the resulting wall-clock fields.
 */

export type MarketSession = "Open" | "Closed" | "PreOpen" | "Halted";

/** Regular hours, in minutes from midnight Eastern. */
const REGULAR_OPEN = 9 * 60 + 30; // 09:30
const REGULAR_CLOSE = 16 * 60; // 16:00
/** Half days close at 13:00, and there is no separate rule beyond that. */
const HALF_DAY_CLOSE = 13 * 60; // 13:00

/**
 * How long before the bell the venue is treated as PreOpen.
 *
 * The opening auction accepts orders well before this, but indications only
 * start to mean anything in the last stretch, and `PreOpen` is as strict as a
 * halt: nothing may be valued against it. Thirty minutes is long enough to
 * cover the period where an indication could move the open materially, and
 * short enough not to freeze the book all morning.
 */
const PRE_OPEN_MINUTES = 30;

/**
 * Full market holidays, as `YYYY-MM-DD` in Eastern.
 *
 * Hard-coded rather than computed. Most of these are rule-based (third Monday
 * in February, last Monday in May) but several are not: Good Friday follows
 * the paschal full moon, and every holiday falling on a weekend is observed on
 * an adjacent weekday by a rule with its own exceptions. A table that can be
 * checked line by line against the NYSE's published calendar is worth more
 * than a clever derivation nobody can audit.
 *
 * `KNOWN_THROUGH` is the honest edge: past it, `sessionAt` reports `Halted`
 * rather than guessing, because a guessed holiday is a market the keeper
 * declares open on Thanksgiving.
 */
const HOLIDAYS = new Set<string>([
  // 2025
  "2025-01-01",
  "2025-01-09",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  // 2026
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);

/** Early closes at 13:00 Eastern. */
const HALF_DAYS = new Set<string>([
  // 2025
  "2025-07-03",
  "2025-11-28",
  "2025-12-24",
  // 2026
  "2026-11-27",
  "2026-12-24",
  // 2027
  "2027-11-26",
]);

/**
 * The last date the tables above are known good for.
 *
 * Past this the calendar refuses rather than extrapolates. Update the tables
 * and this constant together, from the NYSE's published calendar.
 */
export const KNOWN_THROUGH = "2027-12-31";

export interface EasternTime {
  /** `YYYY-MM-DD` in Eastern. */
  date: string;
  /** 0 = Sunday. */
  weekday: number;
  /** Minutes from midnight Eastern. */
  minutes: number;
}

const FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  weekday: "short",
});

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Convert unix seconds to Eastern wall-clock fields.
 *
 * `formatToParts` rather than parsing a formatted string: the string form
 * varies by ICU version and locale data, the parts do not.
 */
export function toEastern(unixSeconds: number): EasternTime {
  const parts = FORMAT.formatToParts(new Date(unixSeconds * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  // `hour12: false` yields "24" for midnight in some ICU versions rather than
  // "00". Normalising here means the rest of the file can treat minutes as a
  // plain 0..1439 value.
  const hour = Number(get("hour")) % 24;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAYS[get("weekday")] ?? 0,
    minutes: hour * 60 + Number(get("minute")),
  };
}

export function isWeekend(eastern: EasternTime): boolean {
  return eastern.weekday === 0 || eastern.weekday === 6;
}

export function isHoliday(date: string): boolean {
  return HOLIDAYS.has(date);
}

export function isHalfDay(date: string): boolean {
  return HALF_DAYS.has(date);
}

/** Is this a day the venue trades at all? */
export function isTradingDay(eastern: EasternTime): boolean {
  return !isWeekend(eastern) && !isHoliday(eastern.date);
}

/** Closing bell for a given date, in minutes from midnight Eastern. */
export function closeMinutes(date: string): number {
  return isHalfDay(date) ? HALF_DAY_CLOSE : REGULAR_CLOSE;
}

/**
 * The session at an instant.
 *
 * Note what this never returns on its own: `Halted`, except as the refusal
 * when the date is past the calendar's knowledge. A real trading halt is an
 * exchange event, not a clock event, and it arrives from the price feed. A
 * calendar that could invent halts would be a calendar that could freeze a
 * market by being wrong about the date.
 */
export function sessionAt(unixSeconds: number): MarketSession {
  const eastern = toEastern(unixSeconds);

  // Past the tables, refuse. `Halted` is the strict answer: it permits
  // nothing, which is the correct posture for a keeper that does not know
  // what day it is.
  if (eastern.date > KNOWN_THROUGH) return "Halted";

  if (!isTradingDay(eastern)) return "Closed";

  const close = closeMinutes(eastern.date);
  if (eastern.minutes >= close) return "Closed";
  if (eastern.minutes >= REGULAR_OPEN) return "Open";
  if (eastern.minutes >= REGULAR_OPEN - PRE_OPEN_MINUTES) return "PreOpen";
  return "Closed";
}

/**
 * The next instant the session changes, as unix seconds.
 *
 * The keeper uses this to sleep until the next boundary instead of polling,
 * and the interface uses it to say "opens Monday 09:30 ET". Searching forward
 * a minute at a time is the honest implementation: it is exact across DST
 * transitions, half days and holiday runs, where closed-form arithmetic on
 * "the next weekday at 09:30" quietly is not.
 *
 * Bounded at ten days, which covers the longest holiday run the NYSE produces
 * and stops a bad calendar turning into an unbounded loop.
 */
export function nextTransition(unixSeconds: number): number | null {
  const current = sessionAt(unixSeconds);
  const limit = unixSeconds + 10 * 86_400;

  // Step to the top of the next minute first, so an instant that is already on
  // a boundary does not return itself.
  let t = Math.floor(unixSeconds / 60) * 60 + 60;
  while (t <= limit) {
    if (sessionAt(t) !== current) return t;
    t += 60;
  }
  return null;
}

/** The next time the venue opens, for display. Null past the calendar's end. */
export function nextOpen(unixSeconds: number): number | null {
  let t = unixSeconds;
  for (let i = 0; i < 10 * 24 * 60; i++) {
    t = Math.floor(t / 60) * 60 + 60;
    if (sessionAt(t) === "Open") return t;
  }
  return null;
}

/** The next closing bell, for display. */
export function nextClose(unixSeconds: number): number | null {
  let t = unixSeconds;
  let sawOpen = sessionAt(unixSeconds) === "Open";
  for (let i = 0; i < 10 * 24 * 60; i++) {
    t = Math.floor(t / 60) * 60 + 60;
    const session = sessionAt(t);
    if (session === "Open") sawOpen = true;
    else if (sawOpen) return t;
  }
  return null;
}

/**
 * Does the calendar still cover this instant?
 *
 * The keeper checks this at startup and refuses to run past the tables rather
 * than publishing `Halted` forever and wondering why nothing trades.
 */
export function isCovered(unixSeconds: number): boolean {
  return toEastern(unixSeconds).date <= KNOWN_THROUGH;
}
