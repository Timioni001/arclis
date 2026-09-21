/**
 * The Arclis mark, and the ecosystem marks beside it.
 *
 * # Why these are inline SVG rather than image files
 *
 * A logo strip made of `<img>` tags is four extra requests that arrive after
 * first paint, reflow the row when they land, and show four broken-image
 * glyphs the first time someone builds with the wrong `base`. Inline paths
 * cost a few hundred bytes each, paint with the first frame, and inherit
 * `currentColor` so they follow the theme instead of fighting it.
 *
 * # Why Meteora and Clawpump are set rather than drawn
 *
 * The Solana mark is here because its geometry is public, fixed and simple
 * enough to reproduce exactly. The other two are not: neither publishes an
 * SVG this build can reach, and a logo drawn from memory is worse than no
 * logo - it is a wrong logo, on a page whose entire argument is that it tells
 * you what things actually are.
 *
 * So they are typeset instead, in the interface's own type, clearly as
 * Arclis's treatment of a name rather than an imitation of a mark. To use the
 * real ones, drop the official file at `app/public/brand/<id>.svg` and give
 * that entry an `asset` below; nothing else changes.
 */

import type { ReactNode } from "react";

/* -------------------------------------------------------------------------
   The Arclis mark. The same four numbers as `app/public/brand/mark.svg` and
   `scripts/make-icons.py`: a rising arc that stops short, and the point it is
   heading for. `Brand.test.tsx` fails if this and the SVG file disagree.
   ------------------------------------------------------------------------- */
export function ArclisMark({
  size = 24,
  title,
}: {
  size?: number;
  title?: string;
}) {
  const id = "arclis-tile-grad";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className="arclis-mark"
    >
      <defs>
        <linearGradient
          id={id}
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#d4f86a" />
          <stop offset="1" stopColor="#aadd1f" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8.5" fill={`url(#${id})`} />
      <path
        d="M7 23.8C13.5 23.2 18.2 19.2 21.4 11.2"
        fill="none"
        stroke="#16210c"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="23.4" cy="5.9" r="2.15" fill="#16210c" />
    </svg>
  );
}

/** The mark and the word, as they appear in the topbar and the footer. */
export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span className="wordmark-lockup">
      <ArclisMark size={size} title="Arclis" />
      <span className="wordmark">arclis</span>
    </span>
  );
}

/* -------------------------------------------------------------------------
   Ecosystem marks
   ------------------------------------------------------------------------- */

/**
 * Solana.
 *
 * Three bars, the outer two leaning one way and the middle one the other, in
 * the brand's purple-to-green gradient. Drawn on the official 398x312 grid so
 * the proportions are the published ones rather than an approximation.
 */
function SolanaMark({ size }: { size: number }) {
  const id = "solana-grad";
  return (
    <svg
      width={size}
      height={(size * 312) / 398}
      viewBox="0 0 398 312"
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient
          id={id}
          x1="360"
          y1="-37"
          x2="141"
          y2="383"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#00FFA3" />
          <stop offset="1" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <g fill={`url(#${id})`}>
        <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
        <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
        <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
      </g>
    </svg>
  );
}

export interface EcosystemBrand {
  id: string;
  name: string;
  /** One line, present tense, naming what it actually does in this codebase. */
  role: string;
  /** The shorter form for the strip under the hero. */
  short: string;
  href: string;
  /** The real mark, where one can be reproduced faithfully. */
  mark?: (size: number) => ReactNode;
  /** Drop an official SVG at `public/brand/<asset>` to use it instead. */
  asset?: string;
}

export const ECOSYSTEM: EcosystemBrand[] = [
  {
    id: "solana",
    name: "Solana",
    short: "Settles on Solana",
    role: "Settlement. Markets, positions and the counterparty pool are on-chain accounts.",
    href: "https://solana.com",
    mark: (size) => <SolanaMark size={size} />,
  },
  {
    id: "meteora",
    name: "Meteora",
    short: "Meteora DBC and DLMM",
    role: "Liquidity. Dynamic Bonding Curve configs for stock-quoted pools, and DLMM depth in the registry.",
    href: "https://meteora.ag",
  },
  {
    id: "clawpump",
    name: "Clawpump",
    short: "Launches on Clawpump",
    role: "Distribution. The launch surface a new stock-quoted market opens through.",
    href: "https://clawpump.com",
  },
];

/**
 * One ecosystem mark at a fixed optical size.
 *
 * `size` is the width the real marks are drawn to; the typeset fallback is
 * sized to match their visual weight rather than their bounding box, because
 * a monogram tile at the same width reads much heavier than a wordmark-less
 * glyph strip.
 */
export function BrandMark({
  brand,
  size = 22,
}: {
  brand: EcosystemBrand;
  size?: number;
}) {
  if (brand.asset) {
    return (
      <img
        src={`${import.meta.env.BASE_URL}brand/${brand.asset}`}
        alt=""
        width={size}
        height={size}
        className="brand-asset"
        loading="lazy"
        decoding="async"
      />
    );
  }
  if (brand.mark) return <>{brand.mark(size)}</>;
  return (
    <span
      className="brand-monogram"
      style={{ width: size, height: size, fontSize: size * 0.52 }}
      aria-hidden
    >
      {brand.name.slice(0, 1)}
    </span>
  );
}
