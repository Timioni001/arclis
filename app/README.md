# Arclis, frontend

*On-chain access to public markets.*

React + TypeScript + Vite. No UI framework and no chart library: the design
system is token-driven CSS, and the charts are inline SVG because the marks
carry protocol meaning (entry, liquidation, a corporate action) that a generic
library has no concept of.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # the read-model maths, cross-checked against the Rust
npm run typecheck
npm run build
```

## How it is put together

```
src/
  lib/
    protocol/
      types.ts     the read model, mirrors the on-chain accounts
      math.ts      PnL, margin, liquidation price, pool NAV, utilisation…
      math.test.ts cross-checks every function against the Rust tests
      session.ts   the market-session rules
      mock.ts      DataSource + an in-memory implementation
    format.ts      the display boundary: bigint → shares, dollars, percent
  components/
    ui/            Card, StatusPill, Metric, Delta, Meter, Button…
    charts/        PriceChart (candles, volume, crosshair, markers), Sparkline
    protocol/      SessionBadge, SessionNotice, OracleStatus, MarginHealth,
                   CorporateActionCard, ExposureBreakdown, HedgeHealth
  screens/         Markets, Trade, Portfolio, Liquidity, Treasury
  styles/          tokens.css (from DESIGN.md), base.css
```

### Three decisions worth knowing

**1. `bigint` everywhere, converted once.** Protocol values are fixed-point
integers. A position's notional in raw units passes `Number.MAX_SAFE_INTEGER`
around $9m and silently loses precision after, so nothing is converted to a
`number` until `format.ts` renders it.

**2. The maths is ported, not re-derived.** `math.ts` mirrors
`programs/arclis/src/math/`, and `math.test.ts` asserts the two agree on the
same worked examples the Rust tests use. A frontend that computes margin
slightly differently from the program shows a position as healthy right up until
it is liquidated.

**3. `DataSource` is the seam.** `mock.ts` implements it in memory. A live
implementation reads the same shapes from RPC using `idl/arclis.json` through
`@coral-xyz/anchor`. Swapping it is one line in `main.tsx`; no screen or
component knows which it is talking to.

## Going live

1. `python3 ../scripts/build-idl.py`: regenerates `idl/arclis.json`.
2. Write `src/lib/protocol/rpc.ts` implementing `DataSource` against
   `@coral-xyz/anchor`, deriving PDAs with the seeds in `docs/ARCHITECTURE.md`.
3. Change the one line in `main.tsx`.

The `DEMO DATA` badge in the header is driven by `source.kind`, so it disappears
by itself once the RPC source is wired.

## The visual language

Near-white warm-grey page, pure white cards at a large radius with a soft wide
shadow and barely any border, separation comes from elevation, not strokes.
One bright lime carries every active and primary state; everything else is
neutral. Rows inside cards sit on their own faintly tinted surface rather than
being divided by lines. Progress is **discrete segments**, not a continuous
fill, because "seven of twelve" reads faster than a bar that is 58% full.

The wordmark is the mark, no logo glyph.

### Fonts

Designed for **After** (display) and **Newblack** (text). Both are commercial
and not redistributed here. `tokens.css` names them first in
`--font-display` / `--font`, and falls back to Plus Jakarta Sans, which is close
in construction, geometric, wide apertures, tall x-height.

The fallback is **self-hosted**, not linked from a CDN, so the interface renders
identically offline, in CI and behind a proxy with no third-party request on
first paint:

```bash
python3 scripts/fetch-fonts.py     # refreshes app/public/fonts/
```

To use the licensed faces: drop `after.woff2` and `newblack.woff2` into
`app/public/fonts/` and uncomment the two blocks at the top of
`app/public/fonts/fonts.css`. Nothing else changes.

### Icons

A small hand-built inline-SVG set (`components/ui/Icon.tsx`), drawn on a 24×24
grid with a 1.8 stroke. The first pass used unicode glyphs (⌕ ◔ ⇄) and they
rendered at different sizes and baselines across platforms, with some falling
back to a system font entirely.

## Colour, validated rather than eyeballed

The palette was run through a contrast and colour-vision validator. Two things
came back:

- **The lime cannot carry data.** At roughly 1.2:1 against white it is
  invisible as a chart series, so it is a UI accent only, active states,
  primary buttons, badges, and charts have their own categorical ramp
  (`--chart-1..4`), re-stepped per mode rather than flipped. Both sets pass
  lightness-band, chroma, adjacent-pair CVD separation and contrast.

- **Positive and negative are 5.1 ΔE apart under deuteranopia**, below the
  readability floor, so red/green alone is unreadable for roughly 8% of men.
  The convention is kept, but every signed value renders a ▲/▼ glyph and an
  explicit sign as well. `DESIGN.md` §35 asks for no colour-only state
  communication; this is where that bites hardest, because finance defaults to
  exactly that.

## Screenshots

There is no committed screenshot tooling. To capture screens locally:

```bash
npm run build && npx vite preview --port 4173
# then drive http://127.0.0.1:4173 with Playwright or a browser
```

## The registry

`src/lib/registry/` and `src/screens/Registry.tsx` are a public lookup for
tokenized equities: claim strength, NAV deviation against the market calendar,
exit liquidity by price impact, and mint authorities. It is the one surface that
never asks for a wallet, and the code enforces that rather than promising it:
nothing under `Registry.tsx` reads the session, and `App.tsx` does not pass it
one. See [`../docs/REGISTRY.md`](../docs/REGISTRY.md).

## Accounts

Two routes, presented as equals in `src/components/auth/AuthSheet.tsx`:

- **Wallet connect** over the Wallet Standard, in about thirty lines
  (`src/lib/auth/wallet.ts`). No `@solana/wallet-adapter-react`: that package
  exists to paper over an era when every wallet injected a bespoke object, and
  the narrower surface here never asks for anything beyond connect and
  `signMessage`.
- **Passkey accounts** (`src/lib/auth/passkey.ts`). An Ed25519 key is generated
  in WebCrypto, WebAuthn's PRF extension produces a secret only the
  authenticator can reproduce, HKDF turns it into an AES-GCM key, and only the
  ciphertext is stored. Unlocking repeats the ceremony. The user experiences
  Face ID; what happens is a non-custodial key with no seed phrase that this
  application cannot decrypt without them present. Where PRF is unavailable the
  flow refuses rather than storing a bare key behind a prompt that protects
  nothing.

`Capability` (`src/lib/auth/session.ts`) is modelled rather than inferred from
`address !== null`. Three states: `anonymous` (browse everything, the intended
state for most visitors), `watching` (a stored account nobody has unlocked this
session), and `trading`. Deriving access from a nullable address is how
"connect your wallet to read this page" happens.

## Glass

`src/components/ui/Glass.tsx` wraps `@samasante/liquid-glass`, which runs an SVG
displacement filter over the live DOM, so text under it stays selectable rather
than being a frozen screenshot. Three rules govern it:

1. **Never under a number.** Refraction bends glyph edges, which is a finish on
   a label and a legibility bug on a price. Glass goes on chrome: the top bar,
   the sign-in sheet, the filter rail. Values sit on flat surfaces, marked
   `.crisp`.
2. **It degrades to a flat panel, always.** `prefers-reduced-transparency` and
   `prefers-reduced-motion` both turn it off, and the fallback renders the same
   two boxes with the same classes, so layout is identical either way.
3. **One optics vocabulary per theme.** Dark glass is not light glass with a
   darker tint: the veil goes negative and the rim does the work, or the pane
   reads as fog.

One structural note worth keeping: `<Glass>` renders its own block wrapper and
the filter's `<svg>` as siblings of the children, so layout belongs to the inner
box (`innerClassName`), never to the glass shell. Putting `display: flex` on the
shell silently stacks every child.

## Checking the interface

The layout audit that gates changes here is not a snapshot test. It drives the
built app in Chromium across every screen at three widths in both themes and
fails on four things: any box escaping the page, any text clipped by its own
box, any interactive control under 32px tall, and any text below its WCAG
contrast floor against the surface it actually composites onto. It is what
caught the page being unscrollable below 760px, and a `--text-muted` sitting at
2.27:1 on the page background.
