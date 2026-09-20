// @vitest-environment jsdom
/**
 * Which surfaces get the refraction lens, and which must never get it.
 *
 * This exists because of a measured regression, not a hypothetical one. The
 * lens is a displacement filter over what is behind the element. On a sticky
 * bar - the one surface whose backdrop moves on every frame - it re-runs
 * across the whole bar for every scrolled pixel, and it took scrolling from
 * 16.7ms per frame to 99.9ms: 60fps down to 10.
 *
 * Nothing about that is visible in a screenshot or a type, so it comes back
 * the moment someone makes chrome "consistent" with the other surfaces.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { GlassPanel } from "./Glass";

/**
 * jsdom has no `matchMedia`, and the component asks it two questions on
 * mount. The stub answers both with the same value, which is the only
 * distinction the component draws.
 */
function setPreferences({ reduce }: { reduce: boolean }) {
  window.matchMedia = ((query: string) => ({
    matches: reduce,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// The lens attaches a ResizeObserver, which jsdom does not implement. A stub
// is enough: nothing here asserts on resize behaviour, only on which branch
// rendered.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  NoopResizeObserver;

afterEach(cleanup);

describe("GlassPanel", () => {
  it("does not put the lens on chrome, whatever the machine can do", () => {
    setPreferences({ reduce: false });
    const { container } = render(
      <GlassPanel weight="chrome" as="header" innerClassName="topbar">
        <span>bar</span>
      </GlassPanel>,
    );

    // The lens ships its own filter as an `<svg>` beside the children. Its
    // absence is the property under test: no svg means no displacement
    // filter, which means no per-frame re-filter of a moving backdrop.
    expect(container.querySelector("svg")).toBeNull();

    const shell = container.firstElementChild!;
    expect(shell.className).toContain("glass-chrome");
    // The shell is the panel itself, not a wrapper the lens introduced.
    expect(shell.firstElementChild?.tagName).toBe("HEADER");
  });

  it("keeps chrome frosted rather than opaque when glass is on", () => {
    setPreferences({ reduce: false });
    const { container } = render(
      <GlassPanel weight="chrome">
        <span>bar</span>
      </GlassPanel>,
    );

    // `glass-flat` is the opaque finish for reduced transparency. Chrome
    // skips the lens for performance, which is a different reason and must
    // not drag the opaque background along with it: the bar is still meant to
    // be frosted.
    expect(container.firstElementChild!.className).not.toContain("glass-flat");
  });

  it("falls back to the flat finish when transparency is unwanted", () => {
    setPreferences({ reduce: true });
    const { container } = render(
      <GlassPanel weight="panel">
        <span>body</span>
      </GlassPanel>,
    );

    expect(container.firstElementChild!.className).toContain("glass-flat");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("still puts the lens on surfaces that sit still", () => {
    // The counterpart to the chrome rule. Without this, a change that
    // disabled the lens everywhere would leave every other test passing.
    setPreferences({ reduce: false });
    const { container } = render(
      <GlassPanel weight="panel">
        <span>body</span>
      </GlassPanel>,
    );

    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.firstElementChild!.className).not.toContain("glass-flat");
  });

  it("keeps the same two boxes on every branch, so layout cannot shift", () => {
    setPreferences({ reduce: true });
    const flat = render(
      <GlassPanel weight="panel" innerClassName="body">
        <span>x</span>
      </GlassPanel>,
    ).container.firstElementChild!;
    const flatInner = flat.firstElementChild!;
    cleanup();

    setPreferences({ reduce: false });
    const lit = render(
      <GlassPanel weight="chrome" innerClassName="body">
        <span>x</span>
      </GlassPanel>,
    ).container.firstElementChild!;
    const litInner = lit.firstElementChild!;

    // Same inner class on both, which is what lets one rule style the content
    // box regardless of the finish.
    expect(flatInner.className).toContain("glass-inner");
    expect(flatInner.className).toContain("body");
    expect(litInner.className).toContain("glass-inner");
    expect(litInner.className).toContain("body");
  });
});
