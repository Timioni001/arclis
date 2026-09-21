/**
 * Inline SVG icons.
 *
 * Unicode glyphs (⌕ ◔ ⇄) were the first attempt and they render inconsistently
 * across platforms: different sizes, different baselines, some fall back to a
 * system font entirely. A small hand-built set is a few hundred bytes and looks
 * the same everywhere.
 *
 * All drawn on a 24×24 grid with a 1.8 stroke so they sit evenly beside
 * 14px text at the default 18px size.
 */
export type IconName =
  | "search"
  | "bell"
  | "moon"
  | "sun"
  | "clock"
  | "swap"
  | "layers"
  | "target"
  | "send"
  | "card"
  | "qr"
  | "plus"
  | "arrowUp"
  | "arrowDown"
  | "arrowRight"
  | "arrowLeft"
  | "caretUp"
  | "caretDown"
  | "wallet"
  | "shield"
  | "droplet"
  | "chart"
  | "check"
  | "alert";

const PATHS: Record<IconName, JSX.Element> = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  bell: (
    <>
      <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 10 4a6.5 6.5 0 0 0 10 10.5Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  swap: (
    <>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </>
  ),
  layers: (
    <path d="M12 3.5 3.5 8 12 12.5 20.5 8 12 3.5ZM3.5 13 12 17.5 20.5 13" />
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  send: (
    <path d="M20.5 3.5 3.5 10.5l7 2.5 2.5 7 7.5-16.5ZM10.5 13.5 20.5 3.5" />
  ),
  card: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="3" />
      <path d="M3 10.5h18" />
    </>
  ),
  qr: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1.5" />
      <rect x="14" y="4" width="6" height="6" rx="1.5" />
      <rect x="4" y="14" width="6" height="6" rx="1.5" />
      <path d="M14 14h2.5M20 14v2.5M14 20h6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowLeft: <path d="M19 12H5M11 18l-6-6 6-6" />,
  /* Filled rather than stroked, and the only two that are. A price delta is
     read in peripheral vision at 11px beside a number, where an outline
     triangle turns to mush; these want to be a solid wedge of the delta's own
     colour. `fill="currentColor"` overrides the shared `fill="none"`. */
  caretUp: <path d="M12 8.5l5 7H7l5-7Z" fill="currentColor" stroke="none" />,
  caretDown: (
    <path d="M12 15.5l-5-7h10l-5 7Z" fill="currentColor" stroke="none" />
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="3.5" />
      <path d="M16 12.5h2.5" />
    </>
  ),
  shield: <path d="M12 3.5 5 6.5v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9v-5l-7-3Z" />,
  droplet: <path d="M12 3.5s6 6 6 9.5a6 6 0 0 1-12 0c0-3.5 6-9.5 6-9.5Z" />,
  chart: <path d="M4 19h16M7 16V9M12 16V5M17 16v-4" />,
  check: <path d="M5 12.5 10 17.5 19.5 7" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5M12 16h.01" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
