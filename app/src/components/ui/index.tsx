import type { ReactNode, CSSProperties } from "react";
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
    <section className={`card ${large ? "card-lg" : ""} ${className}`} style={style} onClick={onClick}>
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

export function CardLink({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button className="card-link" onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * A rounded-square icon holder.
 *
 * `accent` turns it lime. Exactly one chip per group should be accented — it is
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
    <span className={`chip ${small ? "chip-sm" : ""}`} data-accent={accent} data-tone={tone} aria-hidden>
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

export type Tone = "open" | "closed" | "preopen" | "halted" | "info" | "neutral" | "lime";

export function StatusPill({ tone, children, dot = true }: { tone: Tone; children: ReactNode; dot?: boolean }) {
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
  const cls = size === "xl" ? "metric-value-xl" : size === "lg" ? "metric-value-lg" : "";
  return (
    <div>
      {label && <div className="metric-label">{label}</div>}
      <div className={`metric-value num ${cls}`}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

export function StatTile({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
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
 * 5.1 ΔE apart under deuteranopia — below the readability floor — so colour
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
  const glyph = dir === "up" ? "▲" : dir === "down" ? "▼" : "—";
  return (
    <span className="num-delta num" data-dir={dir}>
      {showGlyph && (
        <span className="glyph" aria-hidden>
          {glyph}
        </span>
      )}
      <span>{children}</span>
      <span className="sr-only">{dir === "up" ? " increase" : dir === "down" ? " decrease" : " unchanged"}</span>
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
    <div className="notice" data-tone={tone} role={tone === "danger" ? "alert" : undefined}>
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

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div>{children}</div>}
      {action && <div style={{ marginTop: "var(--space-4)" }}>{action}</div>}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span className="legend-item" key={i.label}>
          <span className="legend-swatch" style={{ background: i.color }} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** The front-page banner: lime gradient, soft blobs, headline, pill CTA. */
export function Hero({
  eyebrow,
  title,
  highlight,
  body,
  cta,
  onCta,
}: {
  eyebrow?: string;
  title: string;
  highlight?: string;
  body?: ReactNode;
  cta?: string;
  onCta?: () => void;
}) {
  return (
    <section className="hero">
      <div className="hero-blobs" aria-hidden>
        <span className="hero-blob" style={{ width: 168, height: 168, right: "6%", top: "-28%" }} />
        <span className="hero-blob" style={{ width: 96, height: 96, right: "23%", bottom: "-18%", opacity: 0.75 }} />
        <span className="hero-blob" style={{ width: 54, height: 54, right: "38%", top: "22%", opacity: 0.6 }} />
      </div>
      <div className="hero-body">
        {eyebrow && (
          <div style={{ fontWeight: 700, fontSize: 12.5, opacity: 0.7, marginBottom: 10, letterSpacing: "0.04em" }}>
            {eyebrow}
          </div>
        )}
        <h1>
          {title}{" "}
          {highlight && <span className="hero-mark">{highlight}</span>}
        </h1>
        {body && <p>{body}</p>}
        {cta && (
          <button className="hero-cta" onClick={onCta}>
            {cta} <span aria-hidden>→</span>
          </button>
        )}
      </div>
    </section>
  );
}
