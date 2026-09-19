# Arclis — frontend

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
      types.ts     the read model — mirrors the on-chain accounts
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

1. `python3 ../scripts/build-idl.py` — regenerates `idl/arclis.json`.
2. Write `src/lib/protocol/rpc.ts` implementing `DataSource` against
   `@coral-xyz/anchor`, deriving PDAs with the seeds in `docs/ARCHITECTURE.md`.
3. Change the one line in `main.tsx`.

The `DEMO DATA` badge in the header is driven by `source.kind`, so it disappears
by itself once the RPC source is wired.

## Design notes that came out of building it

The palette in `DESIGN.md` was run through a contrast and colour-vision
validator rather than eyeballed. Two things came back:

- **Several brand accents fail contrast on the light surface** — lime is 1.15:1
  against white, effectively invisible. Charts therefore have their own
  categorical ramp (`--chart-1..4`), re-stepped per mode rather than flipped.
  Both sets pass lightness-band, chroma, adjacent-pair CVD separation and
  contrast.

- **Positive and negative are 5.1 ΔE apart under deuteranopia**, below the
  readability floor — so red/green alone is unreadable for roughly 8% of men.
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
