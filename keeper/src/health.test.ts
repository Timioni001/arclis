/**
 * The health verdict, and the mistake it is built to avoid.
 *
 * The obvious health check is "has a price been published recently". It is
 * wrong, and wrong in a way that only shows up at 9pm: markets close, the
 * correct behaviour is to publish nothing, and a host that restarts on a
 * failed check would then restart the keeper every night for doing its job.
 *
 * So these fix the distinction. Liveness is about the loop turning; price
 * freshness is reported for a human and never decides anything.
 */
import { describe, expect, it } from "vitest";

import { newHealth } from "./health";

const META = {
  rpc: "https://api.devnet.solana.com",
  programId: "BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP",
  keeper: "Keeper1111111111111111111111111111111111111",
  symbols: ["AAPL"],
  feed: "finnhub",
};

const MINUTE = 60_000;

function healthy() {
  const h = newHealth(META);
  h.register("oracle", 10_000);
  h.reporter("oracle")({ ok: true });
  return h;
}

describe("a market that is closed", () => {
  it("does not make the keeper unhealthy", () => {
    const h = healthy();
    // Sixteen hours since the last print: a Friday evening into Saturday.
    h.published(["AAPL"], Math.floor(Date.now() / 1000) - 16 * 3600);

    // The loop is still turning, so the verdict holds even though nothing has
    // been published for most of a day.
    expect(h.report().ok).toBe(true);
  });

  it("still reports when the last print was, for a human", () => {
    const h = healthy();
    h.published(["AAPL"], 1_700_000_000);
    expect(h.report().lastPublishedAt).toEqual({ AAPL: 1_700_000_000 });
  });
});

describe("a loop that stops turning", () => {
  it("is unhealthy once it has missed several intervals", () => {
    const h = healthy();
    expect(h.report(Date.now() + MINUTE / 2).ok).toBe(true);
    expect(h.report(Date.now() + 5 * MINUTE).ok).toBe(false);
  });

  it("gets a grace period before its first pass", () => {
    // A slow first tick against a cold RPC must not read as a dead loop.
    const h = newHealth(META);
    h.register("oracle", 10_000);
    expect(h.report().ok).toBe(true);
  });

  it("is judged against its own cadence, not a shared one", () => {
    const h = newHealth(META);
    h.register("corporate", 3_600_000); // hourly
    h.reporter("corporate")({ ok: true });
    // Ten minutes is nothing for an hourly task.
    expect(h.report(Date.now() + 10 * MINUTE).ok).toBe(true);
  });
});

describe("a loop that keeps throwing", () => {
  it("survives a few failures", () => {
    const h = healthy();
    const report = h.reporter("oracle");
    for (let i = 0; i < 4; i++) report({ ok: false, error: "429" });
    expect(h.report().ok).toBe(true);
  });

  it("is unhealthy once the budget is spent", () => {
    const h = healthy();
    const report = h.reporter("oracle");
    for (let i = 0; i < 5; i++) report({ ok: false, error: "429" });

    const out = h.report();
    expect(out.ok).toBe(false);
    expect(
      (out.tasks as Record<string, { lastError: string }>).oracle.lastError,
    ).toBe("429");
  });

  it("forgets the failures once a pass succeeds", () => {
    const h = healthy();
    const report = h.reporter("oracle");
    for (let i = 0; i < 5; i++) report({ ok: false, error: "429" });
    expect(h.report().ok).toBe(false);

    report({ ok: true });
    expect(h.report().ok).toBe(true);
  });
});

describe("the report", () => {
  it("names what it is pointed at, so a wrong deployment is visible", () => {
    // The failure this catches: a keeper running happily against the wrong
    // program or the wrong cluster, publishing into a void, looking healthy.
    expect(healthy().report()).toMatchObject({
      rpc: META.rpc,
      programId: META.programId,
      keeper: META.keeper,
      feed: "finnhub",
    });
  });

  it("ignores a report for a task nobody registered", () => {
    const h = healthy();
    expect(() => h.reporter("ghost")({ ok: false })).not.toThrow();
    expect(h.report().ok).toBe(true);
  });
});
