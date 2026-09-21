/**
 * One signal: "the opening is over, the page may move".
 *
 * The hero animates on mount, and the splash covers the page for about 1.6s.
 * Without coordination the hero plays its entrance underneath an opaque
 * overlay and is already settled by the time anyone can see it, which is the
 * worst of both: the cost of an animation and none of the effect.
 *
 * A module-level latch rather than context or an event on `window`: the
 * splash mounts and unmounts, subscribers come and go, and a subscriber that
 * arrives *after* the splash has finished has to fire immediately rather than
 * wait forever for an event that already happened. That one requirement is
 * what rules out a plain `CustomEvent`.
 */

let finished = false;
let waiters: Array<() => void> = [];

/**
 * Called by the splash, whether it played or was skipped outright.
 *
 * Synchronous, and it is the *caller's* job to call it at the right moment.
 * See `Splash.tsx`: signalling from inside the GSAP callback that ends the
 * animation is too early, because the splash's `gsap.context` is still active
 * there and adopts whatever the waiters create, only to revert it moments
 * later when the overlay unmounts. Deferring here by a frame was tried and is
 * not a fix - React's unmount commit and a rAF callback land in whichever
 * order they land in, and the failure is silent when they land the wrong way.
 */
export function introFinished(): void {
  if (finished) return;
  finished = true;
  const pending = waiters;
  waiters = [];
  for (const fn of pending) fn();
}

export function introIsFinished(): boolean {
  return finished;
}

/**
 * Run `fn` once the opening is over. Returns an unsubscribe, so a component
 * that unmounts mid-splash does not animate a detached node.
 */
export function onIntroFinished(fn: () => void): () => void {
  if (finished) {
    fn();
    return () => {};
  }
  waiters.push(fn);
  return () => {
    waiters = waiters.filter((f) => f !== fn);
  };
}

/** Test seam. Nothing in the app calls this. */
export function resetIntroForTests(): void {
  finished = false;
  waiters = [];
}
