/**
 * Liquid glass, on a leash.
 *
 * `@samasante/liquid-glass` runs a real SVG displacement filter over the live
 * DOM, so text under it stays selectable and links stay clickable. That is the
 * reason it is here rather than a `backdrop-filter: blur()`: a frosted panel
 * that freezes the page under it is a screenshot with extra steps.
 *
 * Three rules govern where it is allowed to appear, because a refraction filter
 * is the single most expensive thing on this page and the easiest to overuse.
 *
 *  1. **Never under a number a person has to read.** Refraction bends glyph
 *     edges. On a price, a percentage, or a position size that is a legibility
 *     bug, not a finish. Glass goes on chrome: the top bar, the wallet sheet,
 *     the filter rail. Values sit on flat surfaces.
 *  2. **It degrades to a flat panel, always.** The fallback is not a
 *     worse-looking version, it is the same layout with `--glass-fallback`
 *     doing the work. Anyone on reduced transparency, reduced motion, or a
 *     browser having a bad day gets a finished interface.
 *  3. **One optics vocabulary per theme.** Light glass is bright-rimmed and
 *     lightly frosted. Dark glass needs a stronger sheen and a darker veil or
 *     it vanishes into the near-black surfaces. Both live here, once.
 */

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Glass, type GlassOptics } from "@samasante/liquid-glass";

/**
 * Should this session render real glass at all?
 *
 * `prefers-reduced-transparency` is the direct signal and is the one that
 * matters: people turn it on because layered translucency makes interfaces
 * hard to read, and overriding that for a flourish is not a trade worth
 * making. `prefers-reduced-motion` is included because the lens re-rasterizes
 * as the page behind it scrolls, which reads as motion whether or not anything
 * is animating.
 */
export function useGlassEnabled(): boolean {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    const queries = [
      window.matchMedia("(prefers-reduced-transparency: reduce)"),
      window.matchMedia("(prefers-reduced-motion: reduce)"),
    ];
    const update = () => setEnabled(!queries.some((q) => q.matches));
    update();
    for (const q of queries) q.addEventListener("change", update);
    return () => {
      for (const q of queries) q.removeEventListener("change", update);
    };
  }, []);

  return enabled;
}

/** Read the active theme without threading it through every call site. */
function useTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(
    () =>
      (document.documentElement.getAttribute("data-theme") as
        "light" | "dark") ?? "light",
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(
        (document.documentElement.getAttribute("data-theme") as
          "light" | "dark") ?? "light",
      );
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

/**
 * How thick the glass reads. Three steps, because a fourth would be a decision
 * nobody can make consistently.
 *
 *   `chrome` - the top bar and nav. Barely there: enough rim light to separate
 *              it from the page, not enough to compete with the wordmark.
 *   `panel`  - a sheet or popover sitting over content. Reads as a real pane.
 *   `lens`   - a focused element the eye is meant to land on. The full dome.
 */
export type GlassWeight = "chrome" | "panel" | "lens";

const LIGHT: Record<GlassWeight, Partial<GlassOptics>> = {
  chrome: {
    strength: 0.12,
    depth: 0.34,
    curvature: 0.1,
    bend: 0.3,
    dispersion: 0.25,
    frost: 3,
    brightness: 0.1,
    specular: 0.5,
    sheen: 0.45,
    glow: 0.14,
  },
  panel: {
    strength: 0.2,
    depth: 0.42,
    curvature: 0.16,
    bend: 0.5,
    dispersion: 0.4,
    frost: 6,
    brightness: 0.14,
    specular: 0.7,
    sheen: 0.6,
    glow: 0.2,
  },
  lens: {
    strength: 0.32,
    depth: 0.7,
    curvature: 0.42,
    bend: 0.62,
    dispersion: 0.6,
    frost: 2,
    brightness: 0.06,
    specular: 0.9,
    sheen: 0.7,
    glow: 0.26,
  },
};

/**
 * Dark glass is not light glass with a darker tint. Against a near-black page
 * a bright veil reads as fog, so the veil goes negative and the *edge* does the
 * work: more sheen, more specular, more dispersion at the rim. That is what
 * makes a dark pane look like a pane rather than a slightly lighter rectangle.
 */
const DARK: Record<GlassWeight, Partial<GlassOptics>> = {
  chrome: {
    strength: 0.12,
    depth: 0.34,
    curvature: 0.1,
    bend: 0.34,
    dispersion: 0.3,
    frost: 4,
    brightness: -0.1,
    specular: 0.85,
    sheen: 0.8,
    sheenWidth: 1.4,
    glow: 0.12,
  },
  panel: {
    strength: 0.2,
    depth: 0.42,
    curvature: 0.16,
    bend: 0.55,
    dispersion: 0.45,
    frost: 7,
    brightness: -0.14,
    specular: 1,
    sheen: 0.95,
    sheenWidth: 1.6,
    glow: 0.18,
  },
  lens: {
    strength: 0.32,
    depth: 0.7,
    curvature: 0.42,
    bend: 0.66,
    dispersion: 0.65,
    frost: 2,
    brightness: -0.06,
    specular: 1.15,
    sheen: 1,
    sheenWidth: 1.8,
    glow: 0.24,
  },
};

export function useGlassOptics(weight: GlassWeight): Partial<GlassOptics> {
  const theme = useTheme();
  return useMemo(
    () => (theme === "dark" ? DARK[weight] : LIGHT[weight]),
    [theme, weight],
  );
}

export interface GlassPanelProps {
  children: ReactNode;
  weight?: GlassWeight;
  /** Classes for the glass shell: the surface, its radius and its shadow. */
  className?: string;
  /**
   * Classes for the content box inside the shell, which is where the layout
   * goes.
   *
   * The split is not cosmetic. `<Glass>` renders its own block-level wrapper
   * plus the filter's `<svg>` as siblings of the children, so a `display: flex`
   * put on the shell never reaches them and every child stacks. Layout
   * therefore belongs to a box this component owns, one level in.
   */
  innerClassName?: string;
  style?: CSSProperties;
  /** Corner radius in px. Kept explicit because the lens needs a number, not a
   *  CSS custom property it cannot resolve. */
  radius?: number;
  /** Rendered element for the content box. Defaults to a div. */
  as?: "div" | "header" | "section" | "aside" | "nav";
}

/**
 * A glass surface that is a plain surface wherever glass is not wanted.
 *
 * Both branches render the same element with the same classes, so layout,
 * spacing and focus order are identical either way. Only the finish differs -
 * which is the whole point of putting the decision behind one component.
 */
export function GlassPanel({
  children,
  weight = "panel",
  className = "",
  innerClassName = "",
  style,
  radius = 24,
  as: Tag = "div",
}: GlassPanelProps) {
  const enabled = useGlassEnabled();
  const optics = useGlassOptics(weight);
  const shell = `glass glass-${weight} ${className}`.trim();
  const inner = `glass-inner ${innerClassName}`.trim();

  /*
   * Chrome never gets the lens, however capable the machine.
   *
   * The lens is a displacement filter over what is behind the element, and the
   * sticky bar is the one surface whose backdrop moves on every frame: the
   * filter re-runs across the whole bar for every scrolled pixel. Measured at
   * 1440x900, that alone took the page from 16.7ms per frame to 99.9ms - 60fps
   * down to 10, with every frame late. Dropping only the filter reference and
   * keeping the blur restored 16.7ms exactly.
   *
   * The frosted `backdrop-filter` in `.topbar-glass` costs nothing measurable
   * and reads almost the same on a bar this thin. So the lens stays where it
   * earns its cost, on surfaces that sit still, and the bar is frosted.
   */
  const lens = enabled && weight !== "chrome";

  // Both branches keep the same two boxes, so a rule written against the inner
  // class applies identically whether or not the lens is running.
  if (!lens) {
    // `glass-flat` is the opaque finish for anyone who asked for reduced
    // transparency. Chrome with glass still on is not that case: it wants the
    // frosted surface `.topbar-glass` already defines, so it takes neither
    // the lens nor the flat override.
    const finish = enabled ? "" : " glass-flat";
    return (
      <div
        className={`${shell}${finish}`}
        style={{ borderRadius: radius, ...style }}
      >
        <Tag className={inner}>{children}</Tag>
      </div>
    );
  }

  return (
    <Glass
      className={shell}
      radius={radius}
      optics={optics}
      style={{ borderRadius: radius, ...style }}
    >
      <Tag className={inner}>{children}</Tag>
    </Glass>
  );
}
