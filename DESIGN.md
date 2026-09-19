# ARCLIS DESIGN.md

## Frontend Design Source of Truth

**Product:** Arclis  
**Positioning:** On-chain access to public markets  
**Design direction:** Bright, luminous, professional financial terminal  

> This file combines the original Arclis UI/UX brief with a more implementation-ready design system. It is intended to be placed at the root of the Arclis repository and used as context for frontend development and AI coding agents.

---

## 1. Design North Star

Arclis should feel like a modern public-markets terminal whose settlement and market infrastructure happen to be on-chain. It should combine professional financial information, modern fintech composition, bright controlled accents, subtle glow, purposeful animation, deep chart interaction, protocol transparency, and strong responsive behavior.

The supplied screenshots define the preferred visual language: rounded modular cards, dense but organized information, large financial values, strong charts, compact controls, layered surfaces, soft borders, generous spacing, status pills, circular action controls, and polished dashboard composition. Use those references as inspiration rather than copying them literally.

### Bright does not mean neon everywhere

Use bright color as controlled illumination against calm neutral surfaces. The product should have moments of energy through glowing active states, luminous primary actions, selected chart points, live indicators, subtle gradients, and animated data transitions. Do not turn every card or control into a glowing object.

---

## 2. External Design References

The following references were reviewed as inputs to the design approach:

- Spectrum UI Charts — chart patterns including market, candlestick, price, indicator, depth, order-book, and portfolio charts.
- Refero Styles — DESIGN.md examples and style-system references.
- Neuform — AI-oriented UI and design-system workflow reference.
- TypeUI — reusable UI/design guidance for coding agents.
- Aura — visual website and interface generation reference.
- DesignMD / Hyperbrowser — structured DESIGN.md workflow reference.
- designmd.supply — DESIGN.md resource reference.
- OpenDesign — portable/open design-system workflow reference.
- DesignMD.me — structured design-token and DESIGN.md reference.

Spectrum's chart reference is particularly relevant because it demonstrates OHLC/candlestick charts, volume panes, snapping crosshairs, live tape, price charts, stacked indicators, depth charts, order books, and portfolio charts. Arclis should adapt those functional patterns to its own visual system.

---

## 3. Visual Personality

### Should feel

- Precise
- Analytical
- Premium
- Bright
- Technical
- Calm
- Responsive
- Information-rich

### Should not feel

- Meme-coin focused
- Generic DeFi
- Gaming
- Cyberpunk
- Bank-like
- Generic SaaS
- Overly neon
- Overly minimal

---

## 4. Color System

Do **not** make Arclis an explicit black + neon-green interface. Use a multi-accent system over warm neutral surfaces.

### Light mode

```yaml
background: '#F6F8F5'
surface: '#FFFFFF'
surface-muted: '#EEF2EE'
surface-elevated: '#FFFFFF'
border: '#DDE4DE'
text-primary: '#101512'
text-secondary: '#5F6A63'
text-muted: '#8A948D'
```

### Dark mode

```yaml
background: '#0D1110'
surface: '#141A17'
surface-muted: '#1A211D'
surface-elevated: '#202923'
border: '#303A34'
text-primary: '#F4F8F5'
text-secondary: '#AEB8B1'
text-muted: '#748078'
```

### Accent palette

```yaml
primary: '#6C63FF'
primary-soft: '#827AFF'
primary-bright: '#A59FFF'
cyan: '#18C8FF'
cyan-soft: '#54D8FF'
lime: '#C9FF3D'
lime-soft: '#D8FF72'
positive: '#24D17E'
positive-soft: '#6BE6A8'
negative: '#FF5E70'
negative-soft: '#FF8996'
warning: '#FFB547'
warning-soft: '#FFD17A'
info: '#43B9FF'
info-soft: '#7BD2FF'
```

Use violet/indigo as the primary interaction color, cyan for information/oracle/network data, and lime as a restrained highlight. Semantic colors communicate state.

---

## 5. Glow System

Glow is a first-class visual treatment, but it must remain controlled.

Use glow for:

- Active navigation
- Live market indicators
- Primary CTA hover/focus
- Selected chart points
- Wallet connection
- Transaction progress
- Protocol events
- Focused controls

Do not glow every card.

### Violet glow

```css
box-shadow:
  0 0 0 1px rgba(108, 99, 255, 0.18),
  0 0 24px rgba(108, 99, 255, 0.14);
```

### Lime glow

```css
box-shadow:
  0 0 0 1px rgba(201, 255, 61, 0.18),
  0 0 28px rgba(201, 255, 61, 0.12);
```

### Background glow

Use radial gradients behind major sections rather than bright blocks.

```css
background:
  radial-gradient(
    circle at 80% 20%,
    rgba(108, 99, 255, 0.14),
    transparent 38%
  ),
  #0D1110;
```

Avoid rainbow gradients.

---

## 6. Motion System

Animation is required where it improves feedback, hierarchy, or live-data comprehension.

```yaml
micro: 120ms
fast: 180ms
standard: 240ms
emphasis: 360ms
large: 500ms
```

Use:

- `ease-out` for entrances
- `ease-in-out` for state changes
- restrained spring motion for selected controls

Animate:

- Navigation changes
- Tabs
- Card hover
- Modals
- Drawers
- Bottom sheets
- Number changes
- Chart updates
- Live market points
- Transaction progress
- Wallet connection
- Status changes

Avoid:

- Constant looping effects
- Full-screen motion
- Every element animating on page load
- Excessive risk-alert animation
- Table-wide flashing on every update

Support reduced-motion preferences.

---

## 7. Design Tokens

### Spacing

```yaml
space-1: 4px
space-2: 8px
space-3: 12px
space-4: 16px
space-5: 20px
space-6: 24px
space-7: 32px
space-8: 40px
space-9: 48px
space-10: 64px
space-11: 80px
space-12: 96px
```

### Radius

```yaml
radius-xs: 6px
radius-sm: 10px
radius-md: 14px
radius-lg: 18px
radius-xl: 24px
radius-2xl: 32px
radius-pill: 999px
```

Default dashboard card: `18px`.  
Large panel: `24px`.  
Small controls: `10–14px`.  
Pills: `999px`.

### Typography

- Display: 48–64px
- Large metric: 32–40px
- Page heading: 28–32px
- Section heading: 20–24px
- Card heading: 16–20px
- Body: 14–16px
- Metadata: 11–13px

Use tabular numerals for prices, P&L, volume, open interest, funding, NAV, margin, and percentages.

---

## 8. Layout System

Desktop: 12-column grid, 1440–1600px content width, 24–40px page padding, 16–24px column gaps.

Tablet: 8-column grid.

Mobile: 4-column grid.

Use modular cards rather than one giant dashboard container.

Desktop trading composition:

```text
┌─────────────────────────────────────────────────────────────┐
│ Market header                                               │
├──────────────────────────────────────┬──────────────────────┤
│                                      │                      │
│              Price chart             │   Position / Order   │
│                                      │                      │
├──────────────────────────────────────┴──────────────────────┤
│ Market statistics / funding / OI / margin / session         │
├─────────────────────────────────────────────────────────────┤
│ Positions / Orders / Activity                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. Application Navigation

Primary:

- Markets
- Trade
- Portfolio
- Liquidity
- Treasuries

Secondary:

- Activity
- Docs
- Settings

Top-right:

- Wallet status
- Network
- Account controls

Active navigation gets a brighter surface, accent indicator, subtle glow, and short transition.

---

## 10. Core Product Data Mapping

The protocol architecture defines four subsystems:

```text
Oracle
Market
Liquidity
Treasury
```

The frontend must map these into:

```text
Market
Position
LiquidityPool
LPPosition
Treasury
Oracle
Transaction
CorporateAction
```

Every object follows:

```text
Data → State → Action → Feedback
```

Do not design disconnected mock screens and attach protocol data later.

---

## 11. Market Discovery

Market cards should display equity context:

```text
AAPL
Apple Inc.

$168.16
+1.24%

● OPEN

24h volume
$2.4M

Open interest
$8.2M

Funding
0.014%

Oracle confidence
99.8%
```

Use tiny sparklines where useful. Hover may lift the card 2–4px and increase border brightness.

---

## 12. Market Header

```text
← Markets

AAPL                                      ● OPEN
Apple Inc.

$168.16
+1.24% · Today

Oracle             $168.15     99.8% confidence
Open Interest      $8.24M
Funding            0.014%
24h Volume         $3.81M
```

Market sessions:

- OPEN
- CLOSED
- PRE-OPEN
- HALTED

Use text + icon + color.

---

## 13. Trading Terminal

The trading page is chart-first.

```text
┌──────────────────────────────────────┬──────────────────────┐
│                                      │ Trade                │
│              CHART                   │                      │
│                                      │ Long | Short         │
│                                      │ Size                 │
│                                      │ Leverage             │
│                                      │ Collateral           │
│                                      │ [Review trade]       │
└──────────────────────────────────────┴──────────────────────┘
```

The order panel uses shares and dollars, not raw on-chain integer scales.

---

## 14. Order Panel

```text
Trade

Long        Short

Size
[ 2.00 shares ]

Leverage
[ 5x ]

Collateral
$67.26

Entry price
$168.16

Liquidation
$139.42

Estimated fee
$0.84

Funding
+0.014%

[ Review trade ]
```

Primary CTA: bright accent fill, subtle gradient, small glow, hover illumination, short press response.

---

## 15. Chart System

Required chart family:

- MarketChart
- CandlestickChart
- PriceChart
- IndicatorChart
- DepthChart
- OrderBook
- PortfolioChart
- FundingChart
- OpenInterestChart
- ExposureChart
- MarginChart
- NAVChart
- HedgeHealthChart

Default chart behavior:

- OHLC candles
- Volume pane
- Crosshair
- Last-price marker
- Live update state
- Entry marker
- Liquidation marker
- Oracle marker
- Corporate-action marker
- Optional indicators
- Timeframe controls

Timeframes:

`1H  4H  1D  1W  1M  3M  1Y  ALL`

---

## 16. Chart Interaction

Crosshair should snap to data points and show:

- Timestamp
- OHLC
- Volume
- Indicator values
- Position context where relevant

Selected price points can have a soft glow. Grid lines remain muted.

Optional indicators:

- RSI
- MACD
- Moving averages
- Volume
- VWAP
- Bollinger Bands

Do not overload the default chart.

---

## 17. Depth Chart and Order Book

Depth charts should show cumulative bid/ask liquidity around the mid price with translucent bright fills.

Order books use subtle depth bars behind rows. Live updates should briefly animate the changed row rather than flashing the entire table.

Example:

```text
ORDER BOOK

Price       Size       Total
$168.45     816        8.3K
$168.35     1.5K       7.5K
$168.25     938        6.1K
$168.16     ─ SPREAD ─
$168.05     215        215
$167.95     448        663
```

---

## 18. Position Panel

```text
AAPL
LONG · 2.50 shares

Entry                 $162.40
Mark                  $168.16
Unrealized P&L        +$14.40
Notional              $420.40
Margin ratio          31.4%
Funding               -$0.82
Liquidation           $139.20

[ Close position ]
```

Position equity must account for unsettled funding.

---

## 19. Market Session Behavior

```text
Session       Increase risk       Reduce / close
Open          Available            Available
Closed        Disabled             Available
PreOpen       Disabled             Disabled
Halted        Disabled             Disabled
```

Closed-market state:

```text
AAPL

● MARKET CLOSED

Trading opens
Monday · 09:30 ET

You can still reduce or close existing positions.

[ Close position ]
```

Never surface a generic transaction error when the frontend already knows the market state.

---

## 20. Oracle UX

```text
Oracle

$168.15

Confidence
99.8%

Updated
12s ago
```

Stale state:

```text
Oracle update delayed

Last update
2m 18s ago

Trading temporarily restricted.
```

---

## 21. Corporate Actions

A split should not appear as an artificial price crash.

Chart marker:

```text
● 4:1 SPLIT

Historical prices adjusted
Position size adjusted automatically
No P&L impact
```

Expanded view:

```text
Corporate action

AAPL · 4:1 stock split

Previous price       $672.64
Adjusted price       $168.16
Position impact      10 → 40 shares
P&L impact            $0
```

---

## 22. Portfolio

```text
Portfolio

Total equity
$42,820.32

Today's P&L
+$824.20   +1.96%

Margin used
42%

Available collateral
$18,420
```

Portfolio chart supports account value, cost basis, drawdown, and time range.

---

## 23. Liquidity Dashboard

```text
Liquidity

Your position
$24,820.42

NAV / Share
$1.084

Pool utilization
68.2%

Free to withdraw
$7,420
```

Exposure should distinguish synthetic equity exposure, fees, funding, and trader P&L. Do not reduce the explanation to a generic yield label.

---

## 24. Liquidity Deposit / Withdrawal

Deposit:

```text
Provide liquidity

Available              $12,420
Amount                 [ $5,000 ]
LP shares received     4,612.3
Estimated ownership    0.42%
Pool utilization       68.2%

Your exposure
Synthetic long equity

[ Continue ]
```

Withdrawal:

```text
Withdraw liquidity

Available to withdraw       $7,420
Pending                     $2,000
Cooldown                    18h 24m
Current utilization         68.2%
Maximum currently withdrawable $7,420

[ Request withdrawal ]
```

Show cooldown and free liquidity before submission.

---

## 25. Treasury

```text
Treasury

AAPL Treasury

Stock holdings       12,500 shares
Stock value          $2.10M
Perp position        -12,100 shares
Net delta            +400 shares
Hedge health         ● Within tolerance
NAV                  $2.08M
NAV / token          $1.042
```

Hedge visual:

```text
SHORT PERP                       LONG STOCK

←──────────────●────────────────────→
               │
             TARGET
```

---

## 26. Activity Feed

Use a vertical timeline:

```text
Recent activity

● Opened AAPL position
  2.5 shares · 12s ago

● Funding settled
  AAPL · 2m ago

● Closed TSLA position
  4 shares · 7m ago

● Collateral deposited
  $2,500 · 12m ago
```

---

## 27. Transaction States

Every on-chain action follows:

```text
Review
 ↓
Wallet confirmation
 ↓
Submitting
 ↓
Confirming
 ↓
Confirmed
```

Use a soft pulse while submitting/confirming and a brief accent flash on confirmation.

---

## 28. Risk Communication

```text
Margin health

████████████████░░░░

Healthy

Current margin       31.4%
Maintenance          12.0%
Liquidation          $139.20
```

Risk should become clearer, not louder. Avoid frightening motion.

---

## 29. Loading and Empty States

Use skeletons with subtle shimmer rather than blank screens.

Empty state:

```text
No open positions

Your active positions will appear here.

[ Explore markets ]
```

---

## 30. Error States

Errors must explain the actual state.

Bad:

`Transaction failed.`

Better:

```text
Market closed

New positions cannot be opened during the current market session.

You can still reduce an existing position.
```

Possible protocol-specific states:

- Oracle stale
- Insufficient collateral
- Position below minimum size
- Withdrawal cooldown active
- Pool liquidity unavailable
- Market halted
- Protocol paused

---

## 31. Wallet

Disconnected: `Connect wallet`

Connecting: `Connecting...`

Connected: `● Connected 7x4F...92A`

Wallet menu:

- Copy address
- View on explorer
- Disconnect
- Network

Use a subtle connected-state glow.

---

## 32. Component Library

### Core

- Button
- IconButton
- Badge
- StatusPill
- Input
- Select
- Search
- Tabs
- Tooltip
- Dropdown
- Modal
- Drawer
- BottomSheet
- Toast

### Financial

- PriceDisplay
- PercentageChange
- MetricCard
- MarketCard
- PositionCard
- OrderPanel
- Chart
- CandlestickChart
- DepthChart
- OrderBook
- FundingIndicator
- MarginIndicator
- LiquidationIndicator
- ExposureBar
- NAVCard
- UtilizationGauge
- PortfolioChart
- TransactionStatus

### Protocol

- OracleStatus
- MarketSession
- CorporateActionMarker
- WalletStatus
- TransactionHash
- ProtocolStatus
- HedgeHealth
- SolvencyStatus

---

## 33. Component States

Every reusable interactive component must define:

```text
Default
Hover
Focus
Active
Selected
Disabled
Loading
Success
Warning
Error
```

Focus states must be visible.

---

## 34. Responsive Rules

Desktop:

`Chart | Market Data | Trade`

Tablet:

`Chart`
`Market Data + Trade`

Mobile:

`Market`
`Price`
`Chart`
`Position`
`Trade`
`Stats`
`Activity`

The order panel becomes a bottom sheet on mobile.

---

## 35. Accessibility

Required:

- Strong contrast
- Keyboard navigation
- Visible focus states
- Semantic buttons
- Accessible labels
- No color-only state communication
- Reduced-motion support
- Screen-reader-friendly transaction status
- Adequate touch targets

When reduced motion is enabled, remove decorative pulses and reduce transitions while preserving functional state changes.

---

## 36. Data Formatting

Examples:

```text
$168.16
$2.4M
$8.24M
+1.24%
-0.82%
2.50 shares
5×
0.014%
31.4%
```

Do not expose raw protocol integer scales as the primary user representation.

---

## 37. Protocol Solvency UI

When relevant, show the solvency path clearly:

```text
Trader profit
      ↓
LP pool

Trader loss
      ↓
LP pool

Fees
      ↓
Insurance

Liquidation penalty
      ↓
Liquidator / Insurance
```

Shortfall:

```text
Insurance balance
       ↓
LP pool NAV
       ↓
Market bad debt
```

Bad debt should never be silently hidden.

---

## 38. AI Coding-Agent Rules

When an AI coding agent generates Arclis UI:

1. Follow this file before inventing styles.
2. Reuse existing components.
3. Reuse design tokens.
4. Do not introduce new colors without a reason.
5. Do not introduce new radii without a reason.
6. Do not create a new card style when an existing one works.
7. Preserve the visual hierarchy.
8. Use bright accents only for meaningful interaction.
9. Use glow selectively.
10. Animate functional state changes, not static decoration.
11. Use the protocol data model as the source of truth.
12. Keep raw blockchain values out of primary user-facing fields.
13. Keep desktop, tablet, and mobile behavior explicit.
14. Keep charts interactive but visually restrained.
15. Do not generate a generic AI dashboard.
16. Preserve the Arclis color, radius, spacing, typography, and motion tokens.
17. Prefer composition from existing primitives over one-off CSS.
18. Explain protocol-specific restrictions in the interface before transaction submission.

---

## 39. AI Generation Context

Use this context whenever generating an Arclis screen:

> Design a high-end on-chain public-markets terminal called Arclis. Use bright modern financial UI with warm neutral surfaces, deep graphite dark mode, controlled violet, cyan and lime accents, subtle luminous glows, refined gradients, rounded modular cards, large financial typography, dense but organized information, professional market charts, compact trading controls, and restrained motion. The interface should feel analytical and institutional while still being visually energetic. Avoid generic DeFi aesthetics, excessive neon, excessive dark backgrounds, and excessive animation. Reuse the Arclis design tokens and components. Prioritize financial clarity, market state, risk visibility, responsive behavior, and precise interaction feedback.

---

## 40. Main Dashboard Reference

```text
┌──────────────────────────────────────────────────────────┐
│ ARCLIS        Markets   Trade   Portfolio   Liquidity    │
├──────────────────────────────────────────────────────────┤
│                                                          │
│ AAPL                                      ● OPEN          │
│ Apple Inc.                                                │
│                                                          │
│ $168.16       +1.24%       OI $8.2M       Funding 0.014% │
│                                                          │
├─────────────────────────────────────┬────────────────────┤
│                                     │                    │
│                                     │    Trade           │
│             CHART                   │                    │
│                                     │    Long / Short    │
│                                     │    Size            │
│                                     │    Leverage        │
│                                     │    Collateral      │
│                                     │                    │
├─────────────────────────────────────┴────────────────────┤
│ Position      Margin      Liquidation      Oracle         │
├──────────────────────────────────────────────────────────┤
│ Open Positions                                            │
└──────────────────────────────────────────────────────────┘
```

---

## 41. Quality Gate

Every screen should pass five checks.

### Visual

- Does it look like Arclis?
- Is bright color controlled?
- Is glow subtle?
- Are cards consistent?
- Is hierarchy obvious?

### Financial

- Is the main market information visible?
- Is risk visible?
- Is market state visible?
- Are costs understandable?
- Are restrictions explained?

### Interaction

- Does every action have feedback?
- Are loading states clear?
- Are confirmation states clear?
- Are disabled states explained?

### Responsive

- Desktop works
- Tablet works
- Mobile works
- Chart remains useful
- Order panel remains usable

### Technical

- UI uses the actual read model
- Values are converted correctly
- Corporate actions are handled
- Funding is represented correctly
- Protocol states are reflected before submission

---

## 42. Final Product Principle

Arclis should not look like a crypto exchange that happens to contain stocks.

It should look like a modern public-markets terminal whose settlement and market infrastructure happen to be on-chain.

The screenshots establish the visual taste.

The Arclis architecture establishes the functional truth.

The external design references provide implementation patterns.

This file is the frontend source of truth that combines those inputs.

---

# Original Arclis UI/UX Brief — Detailed Reference

# Arclis UI/UX Design Brief

## Product
**Arclis — On-chain access to public markets**

This brief defines the visual and UX direction for the Arclis frontend. The supplied interface references are used as design inspiration for structure, information density, component patterns, spacing, charts, cards, controls, and interaction language.

The design should not copy the references literally. Arclis should have its own visual identity while retaining the strongest patterns from them.

---

# 1. Visual Direction

Arclis should feel like:

- A serious financial terminal
- A modern fintech dashboard
- A professional trading interface
- An on-chain market platform

Avoid making it feel like:

- A meme-coin terminal
- A generic DeFi dashboard
- A gaming interface
- A neon cyberpunk product
- A conventional banking website
- An overly minimalist SaaS landing page

The visual character should be precise, technical, calm, and information-rich.

The interface should make four questions immediately clear:

1. What am I looking at?
2. What is happening now?
3. What can I do?
4. What happens if I do it?

---

# 2. Reference Design Patterns

The supplied references repeatedly use:

- Large rounded containers
- Softly rounded buttons and input fields
- Dense but organized information
- Strong information hierarchy
- Large numerical values for important financial metrics
- Charts as major interface elements
- Compact status pills
- Small circular icon buttons
- Generous card padding
- Minimal borders
- Subtle shadows
- Tonal separation between surfaces
- Modular dashboard sections
- Responsive layouts
- Clear positive, negative, neutral, warning, and unavailable states
- Short labels instead of long paragraphs
- Nested cards and information modules

Carry these patterns into Arclis without reproducing the exact visual styling.

---

# 3. Color Direction

Do NOT make the product an explicit black + neon-green interface.

Use a flexible palette based on:

**Deep neutral + warm/off-white + one controlled brand accent + semantic colors.**

Suggested base:

- Background: `#F5F6F3`
- Surface: `#FFFFFF`
- Muted surface: `#ECEEEA`
- Border: `#D9DDD6`
- Primary text: `#171A18`
- Secondary text: `#69706A`
- Muted text: `#929892`

Dark mode:

- Background: `#111413`
- Surface: `#191D1B`
- Elevated surface: `#202522`
- Border: `#303632`
- Primary text: `#F3F5F1`
- Secondary text: `#A8AEA9`
- Muted text: `#737A75`

Accent direction:

- Primary brand accent: muted blue or blue-violet
- Secondary highlight: soft lime/yellow
- Positive: green
- Negative: coral/red
- Warning: amber
- Informational: blue

The accent should be controlled. Use it mainly for active states, primary actions, selected elements, important chart points, and key status indicators.

Do not use the accent on every button, border, number, or card.

---

# 4. Layout System

Use a 12-column responsive grid on desktop.

General structure:

```text
┌─────────────────────────────────────────────────────────────┐
│ ARCLIS       Markets   Trade   Liquidity   Treasury   ...  │
├─────────────┬───────────────────────────────────────────────┤
│             │                                               │
│ Navigation  │             Main Workspace                    │
│             │                                               │
│             │                                               │
├─────────────┴───────────────────────────────────────────────┤
│                     Context / Status Bar                    │
└─────────────────────────────────────────────────────────────┘
```

Trading page:

```text
┌─────────────────────────────────────────────────────────────┐
│ Market header                                               │
├──────────────────────────────┬──────────────────────────────┤
│                              │                              │
│                              │      Position / Order       │
│        Price Chart           │          Panel              │
│                              │                              │
├──────────────────────────────┴──────────────────────────────┤
│ Market statistics / funding / OI / margin / session         │
├─────────────────────────────────────────────────────────────┤
│ Positions / Orders / Activity                               │
└─────────────────────────────────────────────────────────────┘
```

Do not force everything into one large card. Use modular information blocks that can stand independently.

---

# 5. Navigation

Primary navigation:

- Markets
- Trade
- Portfolio
- Liquidity
- Treasuries

Secondary:

- Activity
- Docs
- Settings

Top-right:

- Wallet status
- Connected wallet address
- Account controls

Example:

```text
ARCLIS

Markets   Trade   Portfolio   Liquidity   Treasuries

                                      ● Connected
                                      7x4F...92A
```

The wallet component should remain visible without dominating the header.

---

# 6. Market Discovery

Market discovery should focus on equity-market context rather than simply displaying token pairs.

Example:

```text
AAPL
Apple Inc.

$168.16
+1.24%

OPEN
NYSE
09:30 – 16:00 ET

24h
$2.4M

OI
$8.2M

Funding
0.014%

Oracle confidence
99.8%
```

Core market data should include:

- Oracle price
- Market session
- Oracle confidence
- Last update
- Long open interest
- Short open interest
- Funding
- Maximum leverage
- Maintenance margin
- Initial margin
- Taker fee

---

# 7. Market Header

Example:

```text
← Markets

AAPL                                      ● OPEN
Apple Inc.

$168.16
+1.24% · Today

Oracle
$168.15
99.8% confidence

Open Interest
$8.24M

Funding
0.014%

24h Volume
$3.81M
```

Market session states:

- OPEN
- CLOSED
- PRE-OPEN
- HALTED

Do not rely on color alone. Use text and an icon/status indicator.

---

# 8. Trading Interface

The main trading screen should use a large chart with a focused order panel.

Example:

```text
AAPL

$168.16
+1.24%

────────────────────

Chart

1H  4H  1D  1W  1M
```

Order panel:

```text
Trade

Long     Short

Size
[ 2.00 shares ]

Leverage
[ 5x ]

Collateral
$67.26

Entry price
$168.16

Liquidation
$139.42

Estimated fee
$0.84

Funding
+0.014%

[ Review trade ]
```

The user-facing UI should use shares and dollars. Raw on-chain integer values should never be exposed as the primary input format.

---

# 9. Position Panel

Example:

```text
AAPL
LONG · 2.50 shares

Entry
$162.40

Mark
$168.16

Unrealized P&L
+$14.40

Notional
$420.40

Margin ratio
31.4%

Funding
-$0.82

Liquidation
$139.20

[ Close position ]
```

Position equity must account for unsettled funding.

---

# 10. Market Session UX

A closed market should not disable the entire position interface.

Example:

```text
AAPL

● MARKET CLOSED

Trading opens
Monday · 09:30 ET

You can still reduce or close existing positions.

[ Close position ]
```

Session behavior:

| Session | Increase Risk | Reduce / Close |
|---|---:|---:|
| Open | Available | Available |
| Closed | Disabled | Available |
| PreOpen | Disabled | Disabled |
| Halted | Disabled | Disabled |

Do not surface a generic blockchain failure when the frontend already knows the market state.

Use a meaningful explanation such as:

> Market closed. New positions are unavailable until the next session. Existing positions can still be reduced.

---

# 11. Chart Design

Charts should be integrated directly into the dashboard.

Main chart capabilities:

- Candlesticks
- Area/line mode
- Volume
- Position markers
- Entry price
- Liquidation price
- Oracle price
- Corporate-action markers

Time controls:

```text
1H   4H   1D   1W   1M   3M   1Y
```

Compact chart controls:

- Indicators
- Chart type
- Fullscreen
- Settings

Keep chart controls visually quiet.

---

# 12. Corporate Actions

Stock splits should not visually appear as artificial crashes.

The interface should annotate corporate actions and explain their effect.

Example:

```text
────────────────────────────
          ●
       4:1 SPLIT

Historical prices adjusted
Position size adjusted automatically
No P&L impact
────────────────────────────
```

Details modal:

```text
Corporate action

AAPL · 4:1 stock split

Previous price
$672.64

Adjusted price
$168.16

Position impact
10 → 40 shares

P&L impact
$0
```

---

# 13. Liquidity Dashboard

Example:

```text
Liquidity

Your position

$24,820.42

NAV / Share
$1.084

Pool utilization
68.2%

Free to withdraw
$7,420
```

Exposure:

```text
Your exposure

Synthetic long equity
+$24,820

Fees
+$184

Funding
+$42

Trader P&L
-$630

────────────────
Current value
$24,416
```

Do not describe LP exposure simply as "yield." Explain the actual components of the position.

---

# 14. LP Deposit Flow

Example:

```text
Provide liquidity

Available
$12,420

Amount
[ $5,000 ]

You receive
4,612.3 LP shares

Estimated pool ownership
0.42%

Pool utilization
68.2%

────────────────────

Your exposure

Synthetic long equity

Your shares remain exposed until
withdrawal settles.

[ Continue ]
```

Withdrawal:

```text
Withdraw liquidity

Available to withdraw
$7,420

Pending
$2,000

Cooldown
18h 24m

Current utilization
68.2%

Maximum currently withdrawable
$7,420

[ Request withdrawal ]
```

Show cooldown and free liquidity before the transaction is requested.

---

# 15. Treasury Dashboard

Treasury screens should feel more institutional.

Example:

```text
Treasury

AAPL Treasury

Stock holdings
12,500 shares

Stock value
$2.10M

Perp position
-12,100 shares

Net delta
+400 shares

Hedge health
● Within tolerance

NAV
$2.08M

NAV / token
$1.042
```

Hedge visualization:

```text
SHORT PERP                          LONG STOCK

←───────────────●────────────────────→
                │
             TARGET
```

---

# 16. Portfolio Overview

Example:

```text
Portfolio

Total equity
$42,820.32

Today's P&L
+$824.20    +1.96%

Margin used
42%

Available collateral
$18,420
```

Performance chart:

```text
Performance

[ chart ]

1D   1W   1M   3M   1Y
```

Positions:

```text
Positions

AAPL     Long     12.5     +$420
TSLA     Short     4.0     -$82
NVDA     Long      2.5     +$218
```

Activity:

```text
Recent activity
────────────────────────
Opened AAPL position
Funding settled
Closed TSLA position
Collateral deposited
```

---

# 17. Typography

Use a modern sans-serif with strong numerical readability.

Suggested hierarchy:

- Display: 48–64px
- Large metric: 32–40px
- Page heading: 28–32px
- Card heading: 16–20px
- Body: 14–16px
- Metadata: 11–13px

Financial numbers should use tabular numerals where possible.

---

# 18. Cards

Recommended card language:

- 16–24px radius
- 1px subtle border
- Very soft shadow when needed
- 16–24px internal padding
- Consistent spacing
- Clear title → value → context hierarchy

Use nested tonal surfaces instead of putting borders around every small element.

Example:

```text
┌─────────────────────────────┐
│ Portfolio                   │
│                             │
│ $42,820.32                  │
│ +1.96% today                │
│                             │
│ ┌─────────┐ ┌─────────────┐ │
│ │ Margin  │ │ Available   │ │
│ │ 42%     │ │ $18,420     │ │
│ └─────────┘ └─────────────┘ │
└─────────────────────────────┘
```

---

# 19. Micro-interactions

Use restrained interaction feedback:

- Button hover transitions
- Soft elevation
- Animated number updates
- Chart crosshair
- Position markers
- Smooth modal transitions
- Active-tab movement
- Loading skeletons
- Transaction progress
- Toast confirmations
- Wallet connection transitions

Avoid excessive animation. Financial information should remain visually stable.

---

# 20. Transaction States

Every on-chain action should have a clear state:

```text
Review
   ↓
Wallet confirmation
   ↓
Submitting
   ↓
Confirming
   ↓
Confirmed
```

Example:

```text
Opening AAPL position

2.50 shares
Long
5× leverage

Transaction
0x8f...92a

● Confirming on Solana
```

Confirmation:

```text
Position opened

AAPL
2.50 shares long

Entry
$168.16

View position →
```

---

# 21. Risk Communication

Risk should be visible without overwhelming the user.

Margin:

```text
Margin health

████████████████░░░░

Healthy

Current margin
31.4%

Maintenance
12.0%

Liquidation
$139.20
```

Funding:

```text
Funding

Current
+0.014%

Your position
-$0.82 accrued
```

---

# 22. System States

Create a reusable state component.

Examples:

- `● Healthy`
- `● Open`
- `● Near liquidation`
- `● Closed`
- `● Halted`
- `○ Updating`

Oracle delay:

```text
Oracle update delayed

Last update
2m 18s ago

Trading temporarily restricted.
```

---

# 23. Responsive Design

Desktop:

```text
Chart | Market Data | Trade
```

Tablet:

```text
Chart
Market Data + Trade
```

Mobile:

```text
Market
Price
Chart
Position
Trade
Stats
Activity
```

On mobile, the order panel can become a bottom sheet.

---

# 24. Component Library

## Core components

- Button
- IconButton
- Badge
- StatusPill
- Input
- Select
- Search
- Tabs
- Tooltip
- Dropdown
- Modal
- Drawer
- Toast

## Financial components

- PriceDisplay
- PercentageChange
- MetricCard
- MarketCard
- PositionCard
- OrderPanel
- Chart
- FundingIndicator
- MarginIndicator
- LiquidationIndicator
- ExposureBar
- NAVCard
- UtilizationGauge
- TransactionStatus

## Protocol components

- OracleStatus
- MarketSession
- CorporateActionMarker
- WalletStatus
- TransactionHash
- ProtocolStatus

---

# 25. Data-Driven Frontend Architecture

The frontend should be built around the protocol read model rather than designing disconnected screens first.

Core objects:

```text
Market
Position
LiquidityPool
LPPosition
Treasury
Oracle
Transaction
CorporateAction
```

Each object should follow:

```text
Data → State → Action → Feedback
```

This keeps the visual interface connected to the actual protocol behavior.

---

# 26. Main Dashboard Pattern

```text
┌──────────────────────────────────────────────────────────┐
│ ARCLIS        Markets   Trade   Portfolio   Liquidity    │
├──────────────────────────────────────────────────────────┤
│                                                          │
│ AAPL                                      ● OPEN          │
│ Apple Inc.                                                │
│                                                          │
│ $168.16       +1.24%       OI $8.2M       Funding 0.014% │
│                                                          │
├─────────────────────────────────────┬────────────────────┤
│                                     │                    │
│                                     │    Trade           │
│             CHART                   │                    │
│                                     │    Long / Short    │
│                                     │                    │
│                                     │    Size            │
│                                     │    Leverage        │
│                                     │    Collateral      │
│                                     │                    │
├─────────────────────────────────────┴────────────────────┤
│ Position      Margin      Liquidation      Oracle         │
├──────────────────────────────────────────────────────────┤
│ Open Positions                                            │
└──────────────────────────────────────────────────────────┘
```

---

# 27. Final Design Principle

The supplied screenshots should influence:

- Structure
- Spacing
- Information density
- Card shapes
- Charts
- Controls
- Interaction patterns
- Visual hierarchy
- Dashboard composition

They should NOT dictate:

- Exact colors
- Exact typography
- Exact layouts
- Branding
- Copy
- Component styling

Arclis should look like one coherent financial product rather than several reference designs combined.

The key visual formula is:

**Rounded modular cards + dense financial information + large numbers + clean charts + compact controls + soft tonal layering + strong spacing + clear state indicators + responsive composition + minimal visual noise.**

---

# 28. Frontend Priority

Build the design system around these core protocol objects:

```text
Market
Position
Liquidity Pool
LP Position
Treasury
Oracle
Transaction
Corporate Action
```

For every object, define:

```text
1. What data does it expose?
2. What state can it be in?
3. What actions can the user perform?
4. What feedback does the user receive?
5. What risks or restrictions must be communicated?
```

This should be the foundation for the actual Arclis frontend implementation.
