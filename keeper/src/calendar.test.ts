/**
 * Calendar tests.
 *
 * Every case names a real date. If one of these fails, either the tables are
 * wrong or the NYSE changed its schedule, and both are worth stopping for.
 *
 * Times are written as ISO strings with an explicit offset (`-05:00` in
 * winter, `-04:00` in summer) rather than as "Eastern", so the DST cases are
 * unambiguous in the source as well as in the result.
 */

import { describe, expect, it } from "vitest";
import {
  closeMinutes,
  isCovered,
  isHalfDay,
  isHoliday,
  isTradingDay,
  KNOWN_THROUGH,
  nextClose,
  nextOpen,
  nextTransition,
  sessionAt,
  toEastern,
} from "./calendar";

/** Unix seconds from an ISO string with an explicit UTC offset. */
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("toEastern", () => {
  it("converts a winter UTC instant to Eastern standard time", () => {
    // 2026-01-15 14:30 UTC is 09:30 EST.
    const e = toEastern(at("2026-01-15T14:30:00Z"));
    expect(e.date).toBe("2026-01-15");
    expect(e.minutes).toBe(9 * 60 + 30);
    expect(e.weekday).toBe(4); // Thursday
  });

  it("converts a summer UTC instant to Eastern daylight time", () => {
    // 2026-07-15 13:30 UTC is 09:30 EDT: one hour earlier in UTC than winter.
    const e = toEastern(at("2026-07-15T13:30:00Z"));
    expect(e.date).toBe("2026-07-15");
    expect(e.minutes).toBe(9 * 60 + 30);
  });

  it("reports midnight as minute zero, not minute 1440", () => {
    // Some ICU builds format midnight as hour "24" under hour12: false.
    const e = toEastern(at("2026-01-15T05:00:00Z")); // 00:00 EST
    expect(e.minutes).toBe(0);
    expect(e.date).toBe("2026-01-15");
  });

  it("puts a late-evening UTC instant on the previous Eastern date", () => {
    // 2026-01-16 02:00 UTC is 2026-01-15 21:00 EST. Getting this wrong would
    // shift every holiday by a day for anyone running the keeper in UTC.
    const e = toEastern(at("2026-01-16T02:00:00Z"));
    expect(e.date).toBe("2026-01-15");
  });
});

describe("sessionAt, regular days", () => {
  // 2026-01-15 is an ordinary Thursday.
  it("is Closed before the pre-open window", () => {
    expect(sessionAt(at("2026-01-15T13:00:00Z"))).toBe("Closed"); // 08:00 EST
  });

  it("is PreOpen in the half hour before the bell", () => {
    expect(sessionAt(at("2026-01-15T14:00:00Z"))).toBe("PreOpen"); // 09:00 EST
    expect(sessionAt(at("2026-01-15T14:29:00Z"))).toBe("PreOpen"); // 09:29 EST
  });

  it("opens exactly at 09:30 and not a minute before", () => {
    expect(sessionAt(at("2026-01-15T14:29:59Z"))).toBe("PreOpen");
    expect(sessionAt(at("2026-01-15T14:30:00Z"))).toBe("Open");
  });

  it("stays open through the session", () => {
    expect(sessionAt(at("2026-01-15T18:00:00Z"))).toBe("Open"); // 13:00 EST
  });

  it("closes exactly at 16:00, inclusive of the boundary", () => {
    expect(sessionAt(at("2026-01-15T20:59:00Z"))).toBe("Open"); // 15:59 EST
    expect(sessionAt(at("2026-01-15T21:00:00Z"))).toBe("Closed"); // 16:00 EST
  });

  it("is Closed overnight", () => {
    expect(sessionAt(at("2026-01-16T02:00:00Z"))).toBe("Closed"); // 21:00 EST
  });
});

describe("sessionAt, non-trading days", () => {
  it("is Closed all weekend, including during regular hours", () => {
    // 2026-01-17 is a Saturday, 2026-01-18 a Sunday.
    expect(sessionAt(at("2026-01-17T15:00:00Z"))).toBe("Closed");
    expect(sessionAt(at("2026-01-18T15:00:00Z"))).toBe("Closed");
  });

  it("is Closed on a holiday that falls midweek", () => {
    // Thanksgiving 2026 is Thursday 26 November.
    expect(isHoliday("2026-11-26")).toBe(true);
    expect(sessionAt(at("2026-11-26T15:00:00Z"))).toBe("Closed");
  });

  it("is Closed on an observed holiday, not on the date itself", () => {
    // 4 July 2026 is a Saturday, so the market closes Friday the 3rd.
    expect(isHoliday("2026-07-03")).toBe(true);
    expect(sessionAt(at("2026-07-03T15:00:00Z"))).toBe("Closed");
  });

  it("is Closed on Good Friday, which no weekday rule would produce", () => {
    // Good Friday 2026 is 3 April. It is not a federal holiday, and it moves
    // with the paschal full moon, which is why the table is hand-written.
    expect(isHoliday("2026-04-03")).toBe(true);
    expect(sessionAt(at("2026-04-03T15:00:00Z"))).toBe("Closed");
  });
});

describe("sessionAt, half days", () => {
  it("closes at 13:00 on the day after Thanksgiving", () => {
    expect(isHalfDay("2026-11-27")).toBe(true);
    expect(closeMinutes("2026-11-27")).toBe(13 * 60);
    // 17:59 UTC is 12:59 EST, still open; 18:00 UTC is 13:00 EST, shut.
    expect(sessionAt(at("2026-11-27T17:59:00Z"))).toBe("Open");
    expect(sessionAt(at("2026-11-27T18:00:00Z"))).toBe("Closed");
  });

  it("still opens at the normal time on a half day", () => {
    expect(sessionAt(at("2026-11-27T14:30:00Z"))).toBe("Open");
  });

  it("keeps the regular close on an ordinary day", () => {
    expect(closeMinutes("2026-01-15")).toBe(16 * 60);
  });
});

describe("sessionAt, daylight saving transitions", () => {
  it("opens at 14:30 UTC in winter and 13:30 UTC in summer", () => {
    // The whole point of using a real time zone database rather than a fixed
    // offset: the same wall-clock bell is a different UTC instant each half of
    // the year, and a fixed -05:00 would run the market an hour late all
    // summer.
    expect(sessionAt(at("2026-01-15T14:30:00Z"))).toBe("Open");
    expect(sessionAt(at("2026-01-15T13:30:00Z"))).toBe("Closed");

    expect(sessionAt(at("2026-07-15T13:30:00Z"))).toBe("Open");
    expect(sessionAt(at("2026-07-15T12:30:00Z"))).toBe("Closed");
  });

  it("handles the spring-forward Monday correctly", () => {
    // DST began Sunday 8 March 2026, so Monday the 9th trades on EDT.
    expect(sessionAt(at("2026-03-09T13:30:00Z"))).toBe("Open");
    expect(sessionAt(at("2026-03-09T19:59:00Z"))).toBe("Open"); // 15:59 EDT
    expect(sessionAt(at("2026-03-09T20:00:00Z"))).toBe("Closed"); // 16:00 EDT
  });

  it("handles the fall-back Monday correctly", () => {
    // DST ended Sunday 1 November 2026, so Monday the 2nd is back on EST.
    expect(sessionAt(at("2026-11-02T14:30:00Z"))).toBe("Open");
    expect(sessionAt(at("2026-11-02T13:30:00Z"))).toBe("Closed");
  });
});

describe("the edge of the calendar", () => {
  it("covers dates inside the tables", () => {
    expect(isCovered(at("2026-06-01T12:00:00Z"))).toBe(true);
  });

  it("refuses rather than guessing past the last known date", () => {
    const beyond = at(`${KNOWN_THROUGH}T23:59:00Z`) + 2 * 86_400;
    expect(isCovered(beyond)).toBe(false);
    // Halted permits nothing, which is the right posture for a keeper that
    // does not know what day it is.
    expect(sessionAt(beyond)).toBe("Halted");
  });
});

describe("transitions", () => {
  it("finds the opening bell from inside the pre-open window", () => {
    const from = at("2026-01-15T14:00:00Z"); // 09:00 EST, PreOpen
    const next = nextTransition(from)!;
    expect(sessionAt(next)).toBe("Open");
    expect(next).toBe(at("2026-01-15T14:30:00Z"));
  });

  it("finds the closing bell from inside the session", () => {
    const from = at("2026-01-15T18:00:00Z"); // 13:00 EST, Open
    const next = nextTransition(from)!;
    expect(sessionAt(next)).toBe("Closed");
    expect(next).toBe(at("2026-01-15T21:00:00Z"));
  });

  it("does not return the instant it was given when already on a boundary", () => {
    const bell = at("2026-01-15T14:30:00Z");
    expect(nextTransition(bell)).toBeGreaterThan(bell);
  });

  it("skips the whole weekend to Monday's pre-open", () => {
    const fridayNight = at("2026-01-16T22:00:00Z"); // Friday 17:00 EST
    const next = nextTransition(fridayNight)!;
    expect(sessionAt(next)).toBe("PreOpen");
    expect(toEastern(next).date).toBe("2026-01-20"); // Monday 19th is MLK Day
  });

  it("skips a holiday that falls on the next weekday", () => {
    // Friday 2026-01-16 close, then MLK Day on Monday the 19th, so the next
    // session is Tuesday the 20th.
    const next = nextOpen(at("2026-01-16T22:00:00Z"))!;
    const e = toEastern(next);
    expect(e.date).toBe("2026-01-20");
    expect(e.minutes).toBe(9 * 60 + 30);
  });

  it("reports the early bell as the next close on a half day", () => {
    const next = nextClose(at("2026-11-27T15:00:00Z"))!;
    const e = toEastern(next);
    expect(e.date).toBe("2026-11-27");
    expect(e.minutes).toBe(13 * 60);
  });
});

describe("the session sequence over a full ordinary day", () => {
  it("runs Closed, PreOpen, Open, Closed and never anything else", () => {
    const seen: string[] = [];
    const midnight = at("2026-01-15T05:00:00Z"); // 00:00 EST
    for (let m = 0; m < 24 * 60; m += 5) {
      const s = sessionAt(midnight + m * 60);
      if (seen[seen.length - 1] !== s) seen.push(s);
    }
    expect(seen).toEqual(["Closed", "PreOpen", "Open", "Closed"]);
  });

  it("never reports Halted from the clock alone inside the calendar", () => {
    // A halt is an exchange event that arrives from the price feed. A calendar
    // that could invent one could freeze a market by being wrong about a date.
    const start = at("2026-01-12T05:00:00Z");
    for (let m = 0; m < 7 * 24 * 60; m += 7) {
      expect(sessionAt(start + m * 60)).not.toBe("Halted");
    }
  });

  it("agrees that every trading day in a normal week is a trading day", () => {
    const monday = at("2026-01-12T15:00:00Z");
    for (let d = 0; d < 5; d++) {
      expect(isTradingDay(toEastern(monday + d * 86_400))).toBe(true);
    }
    expect(isTradingDay(toEastern(monday + 5 * 86_400))).toBe(false); // Sat
    expect(isTradingDay(toEastern(monday + 6 * 86_400))).toBe(false); // Sun
  });
});
