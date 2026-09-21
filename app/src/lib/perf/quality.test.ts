// @vitest-environment jsdom
/**
 * Every branch here fails the same way when it is wrong: the interface simply
 * looks the way it always did. A switch that never fires and a switch that is
 * not wired in are indistinguishable from the outside, which is how the first
 * version of this shipped broken.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function freshModule() {
  vi.resetModules();
  return import("./quality");
}

/** Drive rAF at a fixed frame interval, so "slow" and "fast" are decidable. */
function withFrameInterval(ms: number) {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    now += ms;
    queueMicrotask(() => cb(now));
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

/** Let the queued microtask chain run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("visual quality", () => {
  it("starts at full and measures nothing until the page is scrolled", async () => {
    const q = await freshModule();
    withFrameInterval(100); // hopelessly slow, but nobody has scrolled
    q.startQualityWatch();
    await settle();

    expect(q.getQuality()).toBe("full");
  });

  it("drops to lite when scrolling is measurably slow", async () => {
    const q = await freshModule();
    withFrameInterval(100);
    q.startQualityWatch();

    window.dispatchEvent(new Event("scroll"));
    await settle();

    expect(q.getQuality()).toBe("lite");
  });

  it("stays at full when the machine keeps up", async () => {
    const q = await freshModule();
    withFrameInterval(16);
    q.startQualityWatch();

    window.dispatchEvent(new Event("scroll"));
    await settle();

    expect(q.getQuality()).toBe("full");
  });

  it("remembers the verdict rather than re-running the experiment", async () => {
    const slow = await freshModule();
    withFrameInterval(100);
    slow.startQualityWatch();
    window.dispatchEvent(new Event("scroll"));
    await settle();
    expect(slow.getQuality()).toBe("lite");

    // A second visit on the same browser, with nothing slow happening.
    const next = await freshModule();
    withFrameInterval(16);
    next.startQualityWatch();
    window.dispatchEvent(new Event("scroll"));
    await settle();

    expect(next.getQuality()).toBe("lite");
  });

  it("lets ?lite=0 pin full quality on a machine that struggles", async () => {
    window.history.replaceState({}, "", "/?lite=0");
    const q = await freshModule();
    withFrameInterval(100);
    q.startQualityWatch();

    window.dispatchEvent(new Event("scroll"));
    await settle();

    expect(q.getQuality()).toBe("full");
  });

  it("lets ?lite force it off on a machine that could manage", async () => {
    window.history.replaceState({}, "", "/?lite");
    const q = await freshModule();
    withFrameInterval(16);
    q.startQualityWatch();
    await settle();

    expect(q.getQuality()).toBe("lite");
  });

  it("tells subscribers when the verdict changes", async () => {
    const q = await freshModule();
    withFrameInterval(100);
    const seen: string[] = [];
    q.subscribeQuality(() => seen.push(q.getQuality()));
    q.startQualityWatch();

    window.dispatchEvent(new Event("scroll"));
    await settle();

    expect(seen).toContain("lite");
  });
});

describe("returning to automatic", () => {
  it("forgets a remembered verdict and measures again", async () => {
    // Pretend a previous visit decided lite.
    localStorage.setItem("arclis:lite", "1");
    window.history.replaceState({}, "", "/?lite=auto");

    const q = await freshModule();
    withFrameInterval(16); // this time the machine keeps up
    q.startQualityWatch();
    window.dispatchEvent(new Event("scroll"));
    await settle();

    expect(q.getQuality()).toBe("full");
  });
});
