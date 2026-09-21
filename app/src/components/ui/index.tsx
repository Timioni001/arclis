import { useLayoutEffect, useRef } from "react";
import type { ReactNode, CSSProperties } from "react";
import gsap from "gsap";
import { onIntroFinished } from "../motion/intro";
import { getQuality } from "../../lib/perf/quality";
import { BrandMark, ECOSYSTEM } from "./Brand";
// Imported for use here as well as re-exported: a bare `export ... from` puts
// the name in the module's exports without binding it in this scope.
import { Icon } from "./Icon";
export { Icon, type IconName } from "./Icon";
/**
 * UI primitives.
 *
 * The repeating units of the design language: a white card with a large radius
 * and a soft wide shadow, rows that sit on their own tinted surface rather than
 * being divided by lines, rounded-square icon chips where lime marks the one
 * that matters, and discrete segmented progress instead of a continuous fill.
 */

export function Card({
  children,
  title,
  note,
  action,
  large,
  className = "",
  style,
  onClick,
}: {
  children: ReactNode;
  title?: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  large?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
}) {
  return (
    <section
      className={`card ${large ? "card-lg" : ""} ${className}`}
      style={style}
      onClick={onClick}
    >
      {(title || action) && (
        <header className="card-head">
          <div>
            {title && <h3 className="card-title">{title}</h3>}
            {note && <div className="card-note">{note}</div>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function CardLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button className="card-link" onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * A rounded-square icon holder.
 *
 * `accent` turns it lime. Exactly one chip per group should be accented; it is
 * how the eye finds the primary thing, and it stops meaning anything if
 * everything glows.
 */
export function Chip({
  children,
  accent,
  tone,
  small,
}: {
  children: ReactNode;
  accent?: boolean;
  tone?: "positive" | "negative";
  small?: boolean;
}) {
  return (
    <span
      className={`chip ${small ? "chip-sm" : ""}`}
      data-accent={accent}
      data-tone={tone}
      aria-hidden
    >
      {children}
    </span>
  );
}

/** The list row the reference repeats everywhere: chip, title/sub, value/meta. */
export function ListRow({
  icon,
  title,
  sub,
  value,
  meta,
  accent,
  onClick,
}: {
  icon?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  value?: ReactNode;
  meta?: ReactNode;
  accent?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className="row-item"
      data-accent={accent}
      data-clickable={onClick ? "true" : undefined}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {icon}
      <div className="row-main">
        <div className="row-title">{title}</div>
        {sub && <div className="row-sub">{sub}</div>}
      </div>
      {(value || meta) && (
        <div className="row-side num">
          {value && <div className="row-value">{value}</div>}
          {meta && <div className="row-meta">{meta}</div>}
        </div>
      )}
    </div>
  );
}

export type Tone =
  "open" | "closed" | "preopen" | "halted" | "info" | "neutral" | "lime";

export function StatusPill({
  tone,
  children,
  dot = true,
}: {
  tone: Tone;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className="pill" data-tone={tone}>
      {dot && <span className="dot" aria-hidden />}
      {children}
    </span>
  );
}

export function BadgeLime({ children }: { children: ReactNode }) {
  return <span className="badge-lime">{children}</span>;
}

export function Metric({
  label,
  value,
  sub,
  size = "md",
}: {
  label?: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  size?: "md" | "lg" | "xl";
}) {
  const cls =
    size === "xl" ? "metric-value-xl" : size === "lg" ? "metric-value-lg" : "";
  return (
    <div>
      {label && <div className="metric-label">{label}</div>}
      <div className={`metric-value num ${cls}`}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="stat-tile">
      <div className="metric-label">{label}</div>
      <div className="metric-value num">{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

/**
 * A signed value.
 *
 * Always renders a direction glyph beside the colour. Positive and negative are
 * 5.1 ΔE apart under deuteranopia, below the readability floor, so colour
 * alone is unreadable for roughly 8% of men. The glyph is the accessible
 * channel, not decoration.
 */
export function Delta({
  value,
  children,
  showGlyph = true,
}: {
  value: number | bigint;
  children: ReactNode;
  showGlyph?: boolean;
}) {
  const n = typeof value === "bigint" ? Number(value) : value;
  const dir = n > 0 ? "up" : n < 0 ? "down" : "flat";
  return (
    <span className="num-delta num" data-dir={dir}>
      {showGlyph && dir !== "flat" && (
        <span className="glyph" aria-hidden>
          <Icon name={dir === "up" ? "caretUp" : "caretDown"} size={11} />
        </span>
      )}
      <span>{children}</span>
      <span className="sr-only">
        {dir === "up"
          ? " increase"
          : dir === "down"
            ? " decrease"
            : " unchanged"}
      </span>
    </span>
  );
}

export function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="metric-row">
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "danger" | "neutral";
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className="notice"
      data-tone={tone}
      role={tone === "danger" ? "alert" : undefined}
    >
      <div>
        {title && <div className="notice-title">{title}</div>}
        {children && <div className="notice-body">{children}</div>}
      </div>
    </div>
  );
}

export function Button({
  children,
  variant = "default",
  block,
  small,
  disabled,
  onClick,
  title,
}: {
  children: ReactNode;
  variant?: "default" | "primary";
  block?: boolean;
  small?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`btn ${variant === "primary" ? "btn-primary" : ""} ${block ? "btn-block" : ""} ${small ? "btn-sm" : ""}`}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o} aria-pressed={o === value} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  suffix,
  step = "0.01",
  min = "0",
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  step?: string;
  min?: string;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="input-wrap">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          step={step}
          min={min}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span className="input-suffix">{suffix}</span>}
      </span>
    </label>
  );
}

/**
 * Discrete segmented progress.
 *
 * Countable rather than continuous, which is the reference's signature and is
 * genuinely easier to read at a glance: "seven of twelve" lands faster than a
 * bar that is 58% full.
 */
export function SegBar({
  value,
  max = 100,
  segments = 12,
  tone,
  small,
  ariaLabel,
}: {
  value: number;
  max?: number;
  segments?: number;
  tone?: "positive" | "warning" | "negative";
  small?: boolean;
  ariaLabel: string;
}) {
  const filled = Math.round(Math.max(0, Math.min(1, value / max)) * segments);
  return (
    <div
      className={`segbar ${small ? "segbar-sm" : ""}`}
      role="meter"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={ariaLabel}
    >
      {Array.from({ length: segments }, (_, i) => (
        <span key={i} data-on={i < filled} data-tone={tone} />
      ))}
    </div>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div>{children}</div>}
      {action && <div style={{ marginTop: "var(--space-4)" }}>{action}</div>}
    </div>
  );
}

export function Legend({
  items,
}: {
  items: { label: string; color: string }[];
}) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span className="legend-item" key={i.label}>
          <span
            className="legend-swatch"
            style={{ background: i.color }}
            aria-hidden
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The front-page banner, and the first thing anyone sees of Arclis.
 *
 * # What moves, and when
 *
 * Three separate things, deliberately not one:
 *
 *  1. **The entrance.** Eyebrow, headline, body, call to action and the
 *     ecosystem strip rise in sequence, once, after the opening overlay has
 *     lifted. It is driven from `onIntroFinished` rather than a matching
 *     delay, because a hardcoded 1.6s is wrong the moment anyone hits Skip.
 *  2. **The drift.** The blobs travel a few pixels on a very long loop. This
 *     is the difference between a gradient and a surface, and it is the only
 *     thing on the page that moves while nobody is touching anything - so it
 *     is slow enough that you notice it only if you look for it.
 *  3. **The sheen.** One diagonal pass of light across the panel, every
 *     eleven seconds.
 *
 * Both loops are CSS keyframes on `transform` and `opacity` alone, which is
 * what keeps them on the compositor instead of in layout. Neither runs under
 * `prefers-reduced-motion`, and neither runs when the adaptive quality watch
 * has decided this machine is struggling.
 *
 * # Why the entrance hides the text with JavaScript rather than CSS
 *
 * `opacity: 0` in the stylesheet is a promise that some script will undo it.
 * If the bundle fails, the page is blank prose-first content that a crawler
 * would have read perfectly well. Hiding in a layout effect means the text is
 * only ever invisible while the code that reveals it is already running, and
 * the timeline below reveals it unconditionally - no scroll trigger, no
 * intersection observer, nothing that can decline to fire.
 */
export function Hero({
  eyebrow,
  title,
  highlight,
  body,
  cta,
  onCta,
  /** The "built on" strip. Off by default; the front page turns it on. */
  ecosystem = false,
}: {
  eyebrow?: string;
  title: string;
  highlight?: string;
  body?: ReactNode;
  cta?: string;
  onCta?: () => void;
  ecosystem?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      getQuality() === "lite" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const rows = el.querySelectorAll<HTMLElement>(".hero-rise");
    if (rows.length === 0) return;

    // Synchronously, before the browser paints this frame. A `gsap.from` here
    // would show the settled text for one frame and then snap it back down.
    gsap.set(rows, { opacity: 0, y: 16 });

    let tween: gsap.core.Tween | undefined;
    let played = false;
    const play = () => {
      if (played) return;
      played = true;
      tween = gsap.to(rows, {
        opacity: 1,
        y: 0,
        duration: 0.82,
        stagger: 0.075,
        ease: "power3.out",
        // Leaves no inline transform behind, so the CTA's own hover
        // transition is not competing with a stale matrix.
        clearProps: "transform,opacity",
      });
    };
    const stop = onIntroFinished(play);

    // The headline is the page. It does not get to depend on an animation
    // library, an overlay and a latch all behaving: if the opening has not
    // released it within three seconds - twice the splash's own length - it
    // plays anyway. Nothing about the product is worth a blank hero.
    const watchdog = window.setTimeout(play, 3000);

    return () => {
      stop();
      window.clearTimeout(watchdog);
      tween?.kill();
      gsap.set(rows, { clearProps: "transform,opacity" });
    };
  }, []);

  return (
    <section className="hero" ref={ref}>
      <div className="hero-blobs" aria-hidden>
        <span
          className="hero-blob hero-blob-a"
          style={{ width: 168, height: 168, right: "6%", top: "-28%" }}
        />
        <span
          className="hero-blob hero-blob-b"
          style={{
            width: 96,
            height: 96,
            right: "23%",
            bottom: "-18%",
            opacity: 0.75,
          }}
        />
        <span
          className="hero-blob hero-blob-c"
          style={{
            width: 54,
            height: 54,
            right: "38%",
            top: "22%",
            opacity: 0.6,
          }}
        />
      </div>
      <span className="hero-sheen" aria-hidden />
      <div className="hero-body">
        {eyebrow && <div className="hero-eyebrow hero-rise">{eyebrow}</div>}
        <h1 className="hero-rise">
          {title} {highlight && <span className="hero-mark">{highlight}</span>}
        </h1>
        {body && <p className="hero-rise">{body}</p>}
        {cta && (
          <div className="hero-rise">
            <button className="hero-cta" onClick={onCta}>
              {cta}
              <Icon name="arrowRight" size={17} />
            </button>
          </div>
        )}
        {ecosystem && (
          <ul className="hero-eco hero-rise" aria-label="Built on">
            {ECOSYSTEM.map((b) => (
              <li key={b.id}>
                <a href={b.href} target="_blank" rel="noreferrer noopener">
                  <BrandMark brand={b} size={18} />
                  <span>{b.short}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
