/**
 * Every number on screen passes through `format.ts`, so its edges are pinned
 * here: signs, compaction, precision on large values, and the time helpers.
 */
import { describe, expect, it } from "vitest";
import {
  ago,
  bpsToPct,
  confidencePct,
  duration,
  leverage,
  pct,
  sessionOpensAt,
  shares,
  shortAddress,
  toQuote,
  usd,
  usdSigned,
} from "./format";

describe("usd", () => {
  it("shows cents, and four places under a dollar", () => {
    expect(usd(168_160_000n)).toBe("$168.16");
    expect(usd(0.1234)).toBe("$0.1234");
  });

  it("compacts past ten thousand unless asked not to", () => {
    expect(usd(12_345)).toBe("$12.3K");
    expect(usd(2_400_000)).toBe("$2.40M");
    expect(usd(2_400_000, { compact: false })).toBe("$2,400,000.00");
  });

  it("puts the sign before the dollar sign", () => {
    expect(usd(-5)).toBe("-$5.00");
    expect(usd(-12_345)).toBe("-$12.3K");
  });

  it("always signs a signed amount, zero included", () => {
    expect(usdSigned(5)).toBe("+$5.00");
    expect(usdSigned(-5)).toBe("-$5.00");
    expect(usdSigned(0)).toBe("+$0.0000");
  });
});

describe("scaled values", () => {
  it("keeps precision past Number.MAX_SAFE_INTEGER in raw units", () => {
    // $10 billion and one cent, at 1e6: 1e16 + 10_000 raw units.
    expect(toQuote(10_000_000_000_010_000n)).toBeCloseTo(10_000_000_000.01, 2);
  });

  it("formats shares with a correctly pluralised unit", () => {
    expect(shares(2_500_000n)).toBe("2.50");
    expect(shares(-2_500_000n)).toBe("-2.50");
    expect(shares(1_000_000n, { unit: true })).toBe("1.00 share");
    expect(shares(2_000_000n, { unit: true })).toBe("2.00 shares");
  });
});

describe("percentages", () => {
  it("signs a change so colour never carries the sign alone", () => {
    expect(pct(1.236)).toBe("+1.24%");
    expect(pct(-1.2)).toBe("-1.20%");
    expect(pct(0)).toBe("0.00%");
  });

  it("reads basis points as bigint or number", () => {
    expect(bpsToPct(500n)).toBe("5.00%");
    expect(bpsToPct(25, 3)).toBe("0.250%");
  });

  it("scores confidence, bounded to 0-100 and zero for no price", () => {
    expect(confidencePct(100_000_000n, 1_000_000n)).toBeCloseTo(99);
    expect(confidencePct(0n, 1n)).toBe(0);
    expect(confidencePct(1n, 5n)).toBe(0);
  });

  it("shows one decimal of leverage under 10x", () => {
    expect(leverage(2.5)).toBe("2.5×");
    expect(leverage(12)).toBe("12×");
  });
});

describe("time", () => {
  it("says how long ago, never negative", () => {
    expect(ago(100, 112)).toBe("12s ago");
    expect(ago(0, 138)).toBe("2m 18s ago");
    expect(ago(0, 120)).toBe("2m ago");
    expect(ago(0, 3 * 3600)).toBe("3h ago");
    expect(ago(0, 2 * 86_400)).toBe("2d ago");
    expect(ago(200, 100)).toBe("0s ago");
  });

  it("counts a cooldown down to ready", () => {
    expect(duration(0)).toBe("ready");
    expect(duration(-5)).toBe("ready");
    expect(duration(18 * 3600 + 24 * 60)).toBe("18h 24m");
    expect(duration(2 * 86_400 + 3600)).toBe("2d 1h");
    expect(duration(90)).toBe("1m");
  });

  it("names the next open in New York time", () => {
    // Monday 2026-09-28 13:30 UTC is 09:30 in New York (EDT).
    expect(sessionOpensAt(Date.UTC(2026, 8, 28, 13, 30) / 1000)).toBe(
      "Monday · 09:30 ET",
    );
  });

  it("shortens an address, but not one already short", () => {
    expect(shortAddress("HyEiyg5z2RSvLuTJtmGWgsQeicMRp3Qyu93j4GTSWP5T")).toBe(
      "HyEi...P5T",
    );
    expect(shortAddress("abcdefghij")).toBe("abcdefghij");
  });
});
