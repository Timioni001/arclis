// @vitest-environment jsdom
/**
 * The opening releases the page, and *when* it does is the whole contract.
 *
 * This exists because of a specific bug. The splash used to announce itself
 * from the `onComplete` of its own GSAP timeline, which runs while the
 * splash's `gsap.context` is still active and still adopting every animation
 * created under it - including the hero entrance a listener starts in
 * response. The splash then unmounted, its context reverted, and the hero was
 * put back to the state that tween had started from: transparent, sixteen
 * pixels low, with nothing left running to move it.
 *
 * A blank headline, no error, nothing in the console. The only thing that
 * would have caught it is an assertion that the signal arrives *after* the
 * overlay is gone, so that is what these are.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Splash } from "./Splash";
import { introIsFinished, onIntroFinished, resetIntroForTests } from "./intro";

// jsdom has no `matchMedia`, and the splash asks it whether motion is wanted
// before it decides to exist at all. Answering "no reduction" is the branch
// under test: the one where an opening actually plays.
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  resetIntroForTests();
  sessionStorage.clear();
});

describe("the intro latch", () => {
  it("runs a listener that subscribed first", () => {
    const seen = vi.fn();
    onIntroFinished(seen);
    expect(seen).not.toHaveBeenCalled();

    render(<Splash />);
    fireEvent.click(screen.getByText("Skip"));

    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("runs a listener that subscribed afterwards, immediately", () => {
    render(<Splash />);
    fireEvent.click(screen.getByText("Skip"));

    const late = vi.fn();
    onIntroFinished(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("does not run a listener that unsubscribed", () => {
    const gone = vi.fn();
    onIntroFinished(gone)();

    render(<Splash />);
    fireEvent.click(screen.getByText("Skip"));

    expect(gone).not.toHaveBeenCalled();
  });

  it("only fires once", () => {
    const seen = vi.fn();
    onIntroFinished(seen);
    const { unmount } = render(<Splash />);
    fireEvent.click(screen.getByText("Skip"));
    unmount();
    render(<Splash />);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("when the page is released", () => {
  /**
   * The regression. A listener must not be able to observe the splash still
   * in the document, because anything it builds while that is true belongs to
   * an animation context that is about to be thrown away.
   */
  it("happens only after the overlay has left the document", () => {
    let splashWasStillUp: boolean | null = null;
    onIntroFinished(() => {
      splashWasStillUp = document.querySelector(".splash") !== null;
    });

    render(<Splash />);
    expect(document.querySelector(".splash")).not.toBeNull();
    expect(introIsFinished()).toBe(false);

    fireEvent.click(screen.getByText("Skip"));

    expect(splashWasStillUp).toBe(false);
    expect(introIsFinished()).toBe(true);
  });

  it("happens on the first frame when there is no opening to play", () => {
    // A second visit in the same tab: the splash marked itself seen, so it
    // never renders and must release the page rather than wait for an
    // animation that is not going to happen.
    sessionStorage.setItem("arclis-splash-seen", "1");
    const seen = vi.fn();
    onIntroFinished(seen);

    render(<Splash />);

    expect(document.querySelector(".splash")).toBeNull();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
