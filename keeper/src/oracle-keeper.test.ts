/**
 * The capped catch-up walk.
 *
 * The situation these describe is the one that stopped the keeper dead on
 * devnet: a seeded price of $228.50 against a real $338.98. That is 48% away,
 * the program's per-update cap is 10%, and so every publish was rejected -
 * forever, with the feed right and the chain stale and nothing getting better
 * by waiting.
 */
import { describe, expect, it } from "vitest";

import { cappedStep, CATCHUP_STEP_BPS } from "./oracle-keeper";

/** What the program enforces: |new - old| * 10000 / old <= 1000. */
const MAX_DEVIATION_BPS = 1000n;
function deviationBps(from: bigint, to: bigint): bigint {
  const delta = to > from ? to - from : from - to;
  return (delta * 10_000n) / from;
}

describe("a step within the cap", () => {
  it("goes straight to the target", () => {
    expect(cappedStep(100_000_000n, 105_000_000n)).toBe(105_000_000n);
    expect(cappedStep(100_000_000n, 95_000_000n)).toBe(95_000_000n);
  });

  it("does not move a price that has not moved", () => {
    expect(cappedStep(228_500_000n, 228_500_000n)).toBe(228_500_000n);
  });

  it("waves through an oracle that has never published", () => {
    // `check_deviation` returns Ok when the stored price is zero: there is no
    // anchor to deviate from.
    expect(cappedStep(0n, 338_980_000n)).toBe(338_980_000n);
  });
});

describe("a step beyond the cap", () => {
  it("moves as far as the program allows and no further", () => {
    const step = cappedStep(228_500_000n, 338_980_000n);
    expect(step).toBeGreaterThan(228_500_000n);
    expect(step).toBeLessThan(338_980_000n);
    expect(deviationBps(228_500_000n, step)).toBeLessThanOrEqual(
      MAX_DEVIATION_BPS,
    );
  });

  it("works downward too", () => {
    const step = cappedStep(338_980_000n, 228_500_000n);
    expect(step).toBeLessThan(338_980_000n);
    expect(deviationBps(338_980_000n, step)).toBeLessThanOrEqual(
      MAX_DEVIATION_BPS,
    );
  });

  it("leaves headroom under the boundary", () => {
    // The on-chain check floors its division, so a step computed to land
    // exactly on 1000 bps can land a basis point the wrong side of it.
    expect(CATCHUP_STEP_BPS).toBeLessThan(MAX_DEVIATION_BPS);
  });
});

describe("walking the real gap", () => {
  it("reaches $338.98 from $228.50, every step legal", () => {
    let price = 228_500_000n;
    const target = 338_980_000n;
    let steps = 0;

    while (price !== target) {
      const next = cappedStep(price, target);
      expect(deviationBps(price, next)).toBeLessThanOrEqual(MAX_DEVIATION_BPS);
      price = next;
      steps++;
      expect(steps).toBeLessThan(20); // must converge, not crawl forever
    }

    expect(price).toBe(target);
    // At ~9.5% a step, 48% takes five. At a ten-second tick that is under a
    // minute of catching up, which is the point: it has to finish inside a
    // demo, not over an afternoon.
    expect(steps).toBe(5);
  });

  it("converges downward from a gap just as large", () => {
    let price = 338_980_000n;
    const target = 228_500_000n;
    let steps = 0;
    while (price !== target && steps < 20) {
      price = cappedStep(price, target);
      steps++;
    }
    expect(price).toBe(target);
  });

  it("always moves, so the walk can never loop forever", () => {
    // The failure this caught: integer division floors, so below ~11 units
    // the step rounds to zero and the keeper republishes the same price every
    // tick, paying a fee each time and never arriving. Real prices are
    // millionths of a dollar and never come near it, which is precisely why
    // it would never have shown up in use.
    for (const current of [1n, 7n, 10n, 99n, 1_000_000n, 228_500_000n]) {
      expect(cappedStep(current, current * 3n)).toBeGreaterThan(current);
      expect(cappedStep(current * 3n, current)).toBeLessThan(current * 3n);
    }
  });
});
