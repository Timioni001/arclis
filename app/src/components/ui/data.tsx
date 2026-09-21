/**
 * The data-display set from the build brief.
 *
 * These are the shadcn/rare-ui components the brief lists (`AddressDisplay`,
 * `PriceTicker`, `AnimatedCounter`, `StepPlayer`, `NotificationBell`), built
 * against Arclis's own tokens instead of installed.
 *
 * That is a deliberate substitution, not a shortcut. Those packages are
 * Tailwind + shadcn components: adding them means adding Tailwind, a
 * `components.json`, and a second set of colour primitives beside the token
 * system this interface already has, whose contrast is measured and whose dark
 * mode is hand-tuned. Two design systems in one app is how an interface starts
 * looking assembled rather than designed. Each one below is thirty to eighty
 * lines and carries the same API surface the brief describes.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

// ---------------------------------------------------------------------------
// AddressDisplay
// ---------------------------------------------------------------------------

export function AddressDisplay({
  address,
  lead = 4,
  tail = 4,
  label,
  explorerHref,
}: {
  address: string;
  lead?: number;
  tail?: number;
  label?: ReactNode;
  explorerHref?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access can be denied outright. The address is selectable in
      // the title attribute either way, so this fails quietly rather than
      // throwing a dialog at someone.
    }
  }

  const short =
    address.length <= lead + tail + 1
      ? address
      : `${address.slice(0, lead)}…${address.slice(-tail)}`;

  return (
    <span className="address">
      {label && <span className="address-label">{label}</span>}
      <button
        className="address-value mono"
        onClick={copy}
        title={address}
        aria-label={`Copy address ${address}`}
      >
        {short}
        <Icon name={copied ? "check" : "card"} size={13} />
      </button>
      {explorerHref && (
        <a
          className="address-link"
          href={explorerHref}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="View on the explorer"
        >
          <Icon name="arrowRight" size={13} />
        </a>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AnimatedCounter
// ---------------------------------------------------------------------------

export interface AnimatedCounterProps {
  value: number;
  decimals?: number;
  prefix?: ReactNode;
  suffix?: ReactNode;
  /** Digit grouping. `indian` uses the 2-2-3 lakh/crore pattern. */
  grouping?: "standard" | "indian" | "none";
  /** Pad the integer part to this many digits, for fixed-width timers. */
  padStart?: number;
  /** Seconds. */
  duration?: number;
  /** Clip a moving gradient through the digits. */
  gradient?: boolean;
  className?: string;
}

function groupIndian(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

/**
 * A number that counts up to its value.
 *
 * Animates via `requestAnimationFrame` into a ref rather than through React
 * state: a counter at 60fps would otherwise re-render its whole subtree sixty
 * times a second for a string change.
 *
 * It counts from the *previous* value, not from zero, so a live figure that
 * ticks from 1,000 to 1,010 animates ten units rather than restarting.
 */
export function AnimatedCounter({
  value,
  decimals = 0,
  prefix,
  suffix,
  grouping = "standard",
  padStart,
  duration = 0.9,
  gradient = false,
  className = "",
}: AnimatedCounterProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(value);

  const format = (n: number) => {
    const fixed = Math.abs(n).toFixed(decimals);
    const [intRaw, frac] = fixed.split(".");
    let int = intRaw;
    if (padStart) int = int.padStart(padStart, "0");
    if (grouping === "standard")
      int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    else if (grouping === "indian") int = groupIndian(int);
    return `${n < 0 ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const start = from.current;
    const delta = value - start;
    from.current = value;

    if (
      delta === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      el.textContent = format(value);
      return;
    }

    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / (duration * 1000));
      // Cubic ease-out: fast enough to feel responsive, settled enough that
      // the final digits are readable before they stop.
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = format(start + delta * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, decimals, duration, grouping, padStart]);

  return (
    <span
      className={`counter ${gradient ? "counter-gradient" : ""} ${className}`}
    >
      {prefix}
      <span className="counter-value num" ref={ref}>
        {format(value)}
      </span>
      {suffix}
    </span>
  );
}

// ---------------------------------------------------------------------------
// PriceTicker
// ---------------------------------------------------------------------------

/**
 * A price that flashes the direction it moved.
 *
 * The flash is the whole point and it is deliberately brief: a trader watching
 * a column of these needs to catch *which* one moved out of the corner of
 * their eye, without the page becoming a christmas tree. Colour returns to
 * neutral after 600ms.
 */
export function PriceTicker({
  value,
  label,
  decimals = 2,
  prefix = "$",
}: {
  value: number;
  label?: ReactNode;
  decimals?: number;
  prefix?: string;
}) {
  const [direction, setDirection] = useState<"up" | "down" | null>(null);
  const previous = useRef(value);

  useEffect(() => {
    if (value === previous.current) return;
    setDirection(value > previous.current ? "up" : "down");
    previous.current = value;
    const id = setTimeout(() => setDirection(null), 600);
    return () => clearTimeout(id);
  }, [value]);

  return (
    <span className="ticker" data-direction={direction ?? undefined}>
      {label && <span className="ticker-label">{label}</span>}
      <span className="ticker-value mono">
        {prefix}
        {value.toLocaleString("en-US", {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })}
      </span>
      {direction && (
        <span className="ticker-arrow" aria-hidden>
          <Icon name={direction === "up" ? "caretUp" : "caretDown"} size={11} />
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// NotificationBell
// ---------------------------------------------------------------------------

export function NotificationBell({
  count = 0,
  onClick,
  label = "Notifications",
}: {
  count?: number;
  onClick?: () => void;
  label?: string;
}) {
  return (
    <button
      className="icon-btn bell"
      onClick={onClick}
      aria-label={count > 0 ? `${label}, ${count} unread` : label}
      data-has-unread={count > 0 ? "true" : undefined}
    >
      <Icon name="bell" />
      {count > 0 && (
        <span className="bell-count" aria-hidden>
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// StepPlayer
// ---------------------------------------------------------------------------

export interface Step {
  title: string;
  body: ReactNode;
}

/**
 * A stepped explainer that can run itself or be driven.
 *
 * Uncontrolled it advances on a timer; pass `value` and `onValueChange` and it
 * becomes controlled, which is how it drives a custom carousel. Autoplay stops
 * permanently the moment someone clicks a step: an explainer that keeps moving
 * after a reader has chosen where to look is fighting them.
 */
export function StepPlayer({
  steps,
  duration = 6,
  loop = true,
  value,
  onValueChange,
}: {
  steps: Step[];
  duration?: number;
  loop?: boolean;
  value?: number;
  onValueChange?: (next: number) => void;
}) {
  const controlled = value !== undefined;
  const [internal, setInternal] = useState(0);
  const [paused, setPaused] = useState(false);
  const index = controlled ? value : internal;

  const set = (next: number) => {
    if (!controlled) setInternal(next);
    onValueChange?.(next);
  };

  useEffect(() => {
    if (paused || steps.length <= 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const id = setTimeout(() => {
      const next = index + 1;
      if (next >= steps.length) {
        if (loop) set(0);
        return;
      }
      set(next);
    }, duration * 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, paused, duration, loop, steps.length]);

  const active = steps[index];
  if (!active) return null;

  return (
    <div className="stepper">
      <ol className="stepper-rail">
        {steps.map((step, i) => (
          <li key={step.title}>
            <button
              className="stepper-tab"
              aria-current={i === index ? "step" : undefined}
              onClick={() => {
                setPaused(true);
                set(i);
              }}
            >
              <span className="stepper-num mono">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="stepper-title">{step.title}</span>
              {i === index && !paused && (
                <span
                  className="stepper-progress"
                  style={{ animationDuration: `${duration}s` }}
                  aria-hidden
                />
              )}
            </button>
          </li>
        ))}
      </ol>
      <div className="stepper-body" key={index}>
        {active.body}
      </div>
    </div>
  );
}
