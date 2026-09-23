# Arclis: videos, pitch and X posts

Everything needed to record the two hackathon videos and post on X.

| File | Use |
|---|---|
| `ARTICLE.md` | The long-form X Article (or a blog post) |
| `media/x-01-hero.png` … `x-06-markets.png` | X images, 1600×900 (16:9) |
| `media/arclis-intro.webm` | 32-second motion intro, 1920×1080 |
| `media/motion.html` | The intro's source: open, full screen, screen-record |
| `media/cards.html` | The X images' source, for edits |

---

## 1. Recording setup (do this once)

**Desktop (recommended): OBS Studio**, free, Windows/macOS/Linux, obsproject.com.

1. Settings → Video: Base and Output resolution **1920×1080**, **30 fps**.
2. Settings → Output → Recording: format **MP4**, encoder **Hardware (NVENC/QSV/AMF)**
   if listed, otherwise x264; quality "High Quality, Medium File Size".
3. Sources → **+** → *Window Capture* (the browser) or *Display Capture*.
4. Sources → **+** → *Audio Input Capture* (your microphone). Mute *Desktop Audio*.
5. Press **Start Recording**, record, **Stop Recording**. Files land in
   *Videos*.

**Windows, no install:** *Win + Alt + R* (Xbox Game Bar) records the current
window. **macOS:** *Cmd + Shift + 5* → *Record Selected Portion*.
**Android tablet:** pull down Quick Settings → *Screen recorder* → enable
*Record audio: Microphone*.

**Before recording**

- Browser at 100% zoom, window at 1920×1080 (or full screen with F11).
- Close other tabs, hide the bookmarks bar, turn on Do Not Disturb.
- Use a fresh browser profile with only Phantom installed, set to **Devnet**
  (Phantom → Settings → Developer Settings → Testnet Mode → Solana Devnet).
- Load the site once so the charts are cached.
- Record during **US market hours (9:30 to 16:00 New York time, Mon to Fri)**
  if you want to show a trade filling; outside them, show the refusal instead
  (it is a feature, and the script covers both).
- A cheap USB or headset microphone is far better than a laptop microphone.
  Record in a small room with soft furnishings.

**Editing (free):** CapCut desktop or DaVinci Resolve. Put
`media/arclis-intro.webm` first (or record `motion.html` in full screen), then
the screen recording. Add captions (CapCut → Text → Auto captions). Export
**1080p MP4, 30 fps**. Upload to YouTube as **Unlisted**.

`arclis-intro.webm` plays in YouTube, CapCut, Resolve and browsers. X needs
MP4: import it into CapCut and export as MP4, or record `motion.html` directly
with OBS.

---

## 2. Pitch video (target 2:30, hard limit 3:00)

Speak slowly. Each block lists what is on screen and what to say.

**0:00 to 0:15. Intro**
*Screen:* motion intro, first two scenes.
> Tokenized stocks are live on Solana. But a ticker on-chain is not a claim
> on a share, and the DeFi built around these tokens assumes an asset that
> never closes, never halts and never splits. Arclis fixes both.

**0:15 to 0:50. The Registry**
*Screen:* open the site → **Registry**. Scroll the list, open one token, point
at custody, redemption, mint authority, exit depth.
> This is the Arclis Registry. No wallet needed. For every tokenized stock it
> shows who holds the underlying share, whether you can redeem, who controls
> the mint, and how much you could actually sell, measured from live Jupiter
> quotes. Two tokens with the same ticker can be very different things, and
> this is where you find out.

**0:50 to 1:40. The perpetuals engine**
*Screen:* **Overview** → click **NVDA** (or AAPL). Show the chart, switch
**1D → 1Y → 5Y**. Point at the session badge. Then the order ticket.
> Arclis runs perpetual futures on fifteen equities and ETFs. The chart
> combines years of history with the live on-chain oracle price. The program
> knows when the market is open. Outside the session it refuses new risk but
> still lets you close. Splits and dividends are applied on chain, so a
> four-for-one split is not a seventy-five percent crash. And every oracle
> update is capped at a ten percent move.

*If the market is open:* connect Phantom → **Get test USDC** → enter size →
**Review trade** → **Confirm and sign** → the position appears.
> I connect a devnet wallet, take test USDC from the faucet, and open a
> position. The transaction is simulated before my wallet is asked to sign,
> and here is the position, with its liquidation price and margin health.

*If the market is closed:* show the ticket's refusal.
> The market is closed right now, so the program refuses the order. That is
> the point: no leverage against a stale price.

**1:40 to 2:15. Agent treasuries**
*Screen:* **Treasuries**. Show the on-chain treasury, hedge and drift, then
the launchable pairs list filtered to *Hedgeable*.
> AI agents are launching tokens through ClawPump, and they can quote them in
> tokenized stocks, so their fees arrive in NVDA or SPY. Arclis gives that
> agent a treasury that shorts the matching perpetual, so its runway holds its
> dollar value. Rebalancing is permissionless.

**2:15 to 2:30. Close**
*Screen:* motion intro, final scene (stats and URL).
> Arclis is live on Solana devnet with fifteen markets, twenty-eight on-chain
> instructions and more than six hundred tests. Next: Pyth price feeds, an
> audit and mainnet. Thank you.

---

## 3. Technical video (target 4:00)

**0:00 to 0:30. Architecture**
*Screen:* GitHub repo → README → *Components* table.
> Four parts: an Anchor program, a keeper that operates it, a React interface
> that reads the program directly, and a pipeline that builds the Registry.

**0:30 to 1:45. The program**
*Screen:* `programs/arclis/src/`. Open the session check, the split
normalisation, the loss waterfall, `admin.rs`.
> Every oracle carries a session state, and risk-increasing instructions check
> it. Splits are applied through a cumulative index, and a position is
> normalised the next time it is touched. Losses follow an explicit
> waterfall: collateral, insurance fund, LP capital, then recorded bad debt.
> And here is the complete list of the authority's powers: it can pause a
> market. Nothing moves user funds to an address it chooses.

**1:45 to 2:45. The keeper**
*Screen:* `keeper/src/run.ts`, then `arclis-keeper.fly.dev/health` in the
browser.
> The keeper publishes prices and sessions every twenty seconds from market
> data, cranks funding, liquidates, rebalances agent hedges and runs the
> devnet faucet. Its health endpoint reports each loop's liveness. A closed
> market is not a failure, so health is about the loop running, not about
> price freshness.

**2:45 to 3:30. The interface**
*Screen:* `app/src/components/protocol/OrderTicket.tsx`, then the site.
> The order ticket checks, in order: a real deployment, a session that can
> sign, pool liquidity, and the wallet's balance. Then the transaction is
> simulated against the chain before the wallet opens, so a refusal is a
> sentence, not a failed transaction.

**3:30 to 4:00. Tests**
*Screen:* terminal running `npm run app:test` and `npm run keeper:test`
(pre-recorded is fine).
> More than six hundred tests across the program math, a local-validator
> integration suite, the keeper and the interface. CI runs formatting, Clippy
> and the full Anchor build.

---

## 4. Motion design storyboard (`media/motion.html`, 32 s)

| Time | Scene | On screen | Motion |
|---|---|---|---|
| 0.0 to 4.5 s | Brand | Arclis mark, wordmark, "Tokenized equities on Solana" | Tile pops in, arc draws, dot lands; text rises |
| 4.5 to 10.5 s | Registry | "Two tokens named AAPL." Two cards: claim on shares vs no claim | Cards rise in sequence |
| 10.5 to 16 s | Problem | "Markets close. Stocks split. Trading halts." | Lines stack, then the lime answer |
| 16 to 22 s | Perpetuals | Live chart, "MARKET CLOSED · new risk refused, exits allowed" | Chart rises, pill follows |
| 22 to 27.5 s | Agents | ClawPump → Treasury → Short perp | Nodes and arrows build left to right |
| 27.5 to 32 s | End card | 15 markets · 28 instructions · 600+ tests, logo, URL | Stats rise, logo, URL; holds |

To use a single scene as a still, pause the recording on it. Colours and
fonts match the product: lime `#c6f03f` on `#0b0d0a`, Plus Jakarta Sans and
JetBrains Mono. Background music: pick a track from the YouTube Audio Library
(free to use) around 100 BPM, and keep it low (−20 dB) under the voice.

---

## 5. X posts

**Launch thread** (attach the image named on each post)

1/ *(x-01-hero.png)*
> Tokenized stocks are live on Solana. The infrastructure around them still
> assumes an asset that never closes, never halts and never splits.
>
> We built Arclis for the Stocklana hackathon: public equities on-chain, with
> the rules that make them equities. 🧵

2/ *(x-02-registry.png)*
> A ticker is not a claim.
>
> The Arclis Registry shows what each tokenized stock is backed by: legal
> structure, custody, redemption rights, mint authority, and real exit depth
> from live Jupiter quotes. No wallet needed.

3/ *(x-03-perpetuals.png)*
> Arclis perps know the market closes.
>
> Sessions are enforced on chain: no new risk while the market is closed or
> halted, exits always allowed. Splits and dividends are applied through
> cumulative indices. Every oracle update is capped at a 10% move.

4/ *(x-04-agent-treasuries.png)*
> AI agents launching on @clawpump can quote their token in a stock, so fees
> arrive in NVDA or SPY.
>
> An Arclis treasury shorts the matching perp and keeps the runway's dollar
> value steady. Rebalancing is permissionless.

5/ *(x-05-by-the-numbers.png)*
> What shipped:
> · 15 equity and ETF markets
> · 28 on-chain instructions (Rust / Anchor)
> · 79 launchable stock pairs
> · 600+ automated tests
> · 0 instructions that can move user funds to the authority

6/ *(x-06-markets.png)*
> Live on Solana devnet. Connect a wallet, grab test USDC from the in-app
> faucet, and trade.
>
> Demo: arclis.timioni1490.workers.dev
> Code: github.com/Timioni001/arclis
>
> Built for #Stocklana on @solana

**Single post** (with `arclis-intro` exported as MP4, or `x-01-hero.png`)
> Arclis: public equities on Solana, with the rules that make them equities.
>
> A registry of what each tokenized stock is really backed by, and perps that
> respect market hours, halts, splits and dividends.
>
> Live on devnet → arclis.timioni1490.workers.dev

Check each partner's handle on X before tagging. Post the thread when the
demo and repository are live and public.
