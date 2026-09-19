/**
 * UI primitives.
 *
 * Small, composable, token-driven. Nothing here knows about the protocol - the
 * protocol-aware components live in `components/protocol`.
 */
import type { ReactNode, CSSProperties } from "react";

export function Card({
  children,
  title,
  note,
  action,
  large,
  className = "",
  style,
}: {
  children: ReactNode;
  title?: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  large?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={`card ${large ? "card-lg" : ""} ${className}`} style={style}>
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

export type Tone = "open" | "closed" | "preopen" | "halted" | "info" | "neutral";

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="pill" data-tone={tone}>
      <span className="dot" aria-hidden />
      {children}
    </span>
  );
}

export function Metric({
  label,
  value,
  sub,
  size = "md",
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  size?: "md" | "lg" | "xl";
}) {
  const cls = size === "xl" ? "metric-value-xl" : size === "lg" ? "metric-value-lg" : "";
  return (
    <div>
      <div className="metric-label">{label}</div>
      <div className={`metric-value num ${cls}`}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

export function StatTile({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat-tile">
      <div className="metric-label">{label}</div>
      <div className="num" style={{ fontSize: 17, fontWeight: 600, marginTop: 2 }}>
        {value}
      </div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

/**
 * A signed value.
 *
 * Always renders a direction glyph alongside the colour. Positive and negative
 * in this palette are 5.1 ΔE apart under deuteranopia - below the readability
 * floor - so colour on its own would be invisible to a substantial minority of
 * users. The glyph is not decoration; it is the accessible channel.
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
  disabled,
  onClick,
  title,
  type = "button",
}: {
  children: ReactNode;
  variant?: "default" | "primary";
  block?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={`btn ${variant === "primary" ? "btn-primary" : ""} ${block ? "btn-block" : ""}`}
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

/** A meter with a labelled threshold — used for margin and utilisation. */
export function Meter({
  value,
  max = 100,
  threshold,
  tone = "primary",
  ariaLabel,
}: {
  value: number;
  max?: number;
  threshold?: number;
  tone?: "primary" | "positive" | "warning" | "negative";
  ariaLabel: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color =
    tone === "positive"
      ? "var(--positive)"
      : tone === "warning"
        ? "var(--warning)"
        : tone === "negative"
          ? "var(--negative)"
          : "var(--primary)";
  return (
    <div style={{ position: "relative" }}>
      <div
        className="bar"
        role="meter"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={ariaLabel}
      >
        <span style={{ width: `${pct}%`, background: color, borderRadius: "var(--radius-pill)" }} />
      </div>
      {threshold !== undefined && (
        <span
          aria-hidden
          title="Maintenance threshold"
          style={{
            position: "absolute",
            left: `${Math.max(0, Math.min(100, (threshold / max) * 100))}%`,
            top: -3,
            width: 2,
            height: 14,
            background: "var(--text-muted)",
            borderRadius: 1,
          }}
        />
      )}
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
