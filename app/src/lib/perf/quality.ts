/**
 * How much finish this machine can actually carry, decided by watching it.
 *
 * The expensive effect is the refraction lens on the sticky bar: a
 * displacement filter over a backdrop that moves on every scrolled pixel. On
 * hardware with a GPU it is close to free. Without one it is the difference
 * between sixty frames a second and ten.
 *
 * # Why this measures scrolling rather than startup
 *
 * The obvious design is a benchmark at boot, and it is the wrong one. It has
 * to be short enough not to delay the first paint and long enough to mean
 * something, and whatever it measures is a page that is still loading, still
 * fetching fonts, still mounting. It would be guessing about a workload it
 * never ran, and a wrong guess costs every visitor the finish.
 *
 * So nothing is measured until the reader scrolls, because scrolling with the
 * lens on *is* the workload. Frame intervals are sampled only while the page
 * is actually moving, and only while the lens is actually on.
 *
 * # Why it only ever goes down
 *
 * A quality setting that moves both ways oscillates: drop the lens, frames
 * improve because the lens is gone, put it back, frames collapse, repeat. So
 * the decision is one-way and made once. It is remembered, so a returning
 * visitor does not re-run the experiment, and `?lite=0` clears it for anyone
 * who wants the finish back on a machine that struggled once.
 */

export type Quality = "full" | "lite";

const KEY = "arclis:lite";

/** Under ~31fps sustained. Below this, scrolling is visibly stepping. */
const LATE_FRAME_MS = 32;

/** Enough samples that a garbage collection or a tab restore cannot decide. */
const SAMPLES_REQUIRED = 30;

let current: Quality = "full";
let decided = false;
const listeners = new Set<() => void>();

function readStored(): Quality | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === "1" ? "lite" : raw === "0" ? "full" : null;
  } catch {
    // Private windows and blocked storage throw. Neither is a reason to
    // change how the interface looks.
    return null;
  }
}

function store(quality: Quality) {
  try {
    window.localStorage.setItem(KEY, quality === "lite" ? "1" : "0");
  } catch {
    /* nothing to do; the decision just will not be remembered */
  }
}

/** `?lite` pins lite, `?lite=0` pins full. Either way, stop measuring. */
function readOverride(): Quality | null {
  try {
    const param = new URLSearchParams(window.location.search).get("lite");
    if (param === null) return null;
    return param !== "0" && param !== "false" ? "lite" : "full";
  } catch {
    return null;
  }
}

function set(quality: Quality, reason: string) {
  decided = true;
  if (current === quality) return;
  current = quality;
  store(quality);
  console.info(`[arclis] visual quality: ${quality} (${reason})`);
  for (const fn of listeners) fn();
}

export function getQuality(): Quality {
  return current;
}

export function subscribeQuality(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Decide from what is already known, and start watching if nothing is.
 *
 * Safe to call more than once; only the first call measures anything.
 */
export function startQualityWatch(): void {
  if (decided) return;

  const override = readOverride();
  if (override) {
    set(override, "asked for in the URL");
    return;
  }

  const remembered = readStored();
  if (remembered) {
    decided = true;
    current = remembered;
    return;
  }

  let samples: number[] = [];
  let last = 0;
  let raf = 0;
  let idle = 0;

  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    window.clearTimeout(idle);
  };

  const tick = (now: number) => {
    if (last) samples.push(now - last);
    last = now;

    if (samples.length >= SAMPLES_REQUIRED) {
      const sorted = [...samples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      stop();
      window.removeEventListener("scroll", onScroll);
      if (median > LATE_FRAME_MS) {
        set("lite", `${median.toFixed(0)}ms median frame while scrolling`);
      } else {
        // Comfortably keeping up. Remember that too, so the next visit does
        // not measure again.
        set("full", `${median.toFixed(0)}ms median frame while scrolling`);
      }
      samples = [];
      return;
    }

    raf = requestAnimationFrame(tick);
  };

  const onScroll = () => {
    if (!raf) raf = requestAnimationFrame(tick);
    window.clearTimeout(idle);
    // Sampling stops with the scroll. A frame interval measured while the
    // page is still is measuring nothing.
    idle = window.setTimeout(stop, 120);
  };

  window.addEventListener("scroll", onScroll, { passive: true });
}
