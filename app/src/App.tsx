/**
 * App shell: navigation, session, theme, and routing between screens.
 *
 * Routing is a `useState` rather than a router, deliberately: six screens, no
 * deep-linking requirement yet, and one less dependency to explain. Swapping in
 * a real router later touches only this file.
 *
 * One structural rule, enforced here rather than remembered per screen: the
 * session is passed *down*, and no screen fetches it for itself. The Registry
 * does not receive it at all, which is what makes "this page never asks for a
 * wallet" a property of the code rather than a promise in a comment.
 */
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import type { DataSource } from "./lib/protocol/mock";
import { modelledRegistry } from "./lib/registry/data";
import { loadRegistry, type LiveRegistry } from "./lib/registry/live";
import { restoreSession, type Session } from "./lib/auth/session";
import { forgetAccount } from "./lib/auth/passkey";
import { Markets } from "./screens/Markets";
import { Registry } from "./screens/Registry";
import { Liquidity } from "./screens/Liquidity";
import { Treasury } from "./screens/Treasury";
import { Legal } from "./screens/Legal";
import { Portfolio } from "./screens/Portfolio";
import { AuthSheet } from "./components/auth/AuthSheet";
import { Splash } from "./components/motion/Splash";
import { AmbientShader } from "./components/motion/AmbientShader";
import { AddressDisplay } from "./components/ui/data";
import { useLiveSource } from "./lib/protocol/useLiveSource";
import { useMarketSummary, withSummary } from "./lib/protocol/keeperHistory";
import {
  toActivity,
  toCorporateAction,
  useKeeperEvents,
} from "./lib/protocol/keeperEvents";
import { explorerAddress, REFRESH_INTERVAL_MS } from "./lib/config";
import { ago } from "./lib/format";
import { Icon } from "./components/ui";
import { Footer } from "./components/ui/Footer";
import { Wordmark } from "./components/ui/Brand";
import { GlassPanel } from "./components/ui/Glass";

/*
 * The Trade screen loads on demand. It carries the charting library, which is
 * a sixth of the bundle, and a visitor reading the Overview or looking a stock
 * up in the Registry never needs it.
 */
const Trade = lazy(() =>
  import("./screens/Trade").then((m) => ({ default: m.Trade })),
);

const TABS = [
  "Overview",
  "Registry",
  "Trade",
  "Portfolio",
  "Liquidity",
  "Treasuries",
] as const;

/**
 * Terms and Privacy are screens but not tabs.
 *
 * They belong in the footer, where a reader looks for them, and not in a
 * six-item primary nav where they would push the product out of the way. So
 * the nav renders `TABS` and the router accepts a wider set.
 */
const FOOTER_ONLY = ["Terms", "Privacy"] as const;
type Tab = (typeof TABS)[number] | (typeof FOOTER_ONLY)[number];

/** Screens that need a signature to be worth opening. Registry is not one. */
const NEEDS_SESSION: Record<Tab, string | null> = {
  Overview: null,
  Registry: null,
  Trade: null,
  Portfolio: "Sign in to see the positions held by your account.",
  Liquidity: null,
  Treasuries: null,
  Terms: null,
  Privacy: null,
};

export function App({ source }: { source: DataSource }) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [symbol, setSymbol] = useState<string>("AAPL");
  const [theme, setTheme] = useState<"light" | "dark">(
    () =>
      (document.documentElement.getAttribute("data-theme") as
        "light" | "dark") ?? "light",
  );
  const [session, setSession] = useState<Session>(restoreSession);
  const [authOpen, setAuthOpen] = useState(false);
  const [authReason, setAuthReason] = useState<string | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);

  // A clock, so "12s ago" stays true without re-fetching anything.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    // Keeps form controls, scrollbars and the mobile browser chrome on the
    // same side of the theme as the page. Without it a dark page renders a
    // white select menu.
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem("arclis-theme", theme);
    } catch {
      // Private browsing: the preference just does not persist.
    }
  }, [theme]);

  // The modelled dataset renders immediately; a live snapshot replaces it if
  // the pipeline has written one recently. The fallback direction is the point:
  // a failed pipeline degrades to a clearly-labelled demo, never to an empty
  // page or to stale numbers presented as current.
  const [registry, setRegistry] = useState<LiveRegistry>(() => ({
    ...modelledRegistry(),
    failures: [],
  }));

  useEffect(() => {
    let cancelled = false;
    void loadRegistry().then((loaded) => {
      if (!cancelled) setRegistry(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Drives the RPC source when there is one, and is inert on the mock. The
  // interval pauses while the tab is hidden; see `useLiveSource`.
  const liveStatus = useLiveSource(
    source,
    session.address,
    REFRESH_INTERVAL_MS,
  );

  /*
   * Read every render. Not memoised, and that is the point.
   *
   * This was `useMemo(() => source.markets(), [source])`, which looks
   * obviously right and is obviously wrong: the source is a mutable snapshot
   * holder whose identity never changes, by design, so the memo ran once - on
   * the first render, before the first read of the chain had landed - and
   * returned the same empty array forever after.
   *
   * Overview, Portfolio, Liquidity and Treasuries all take `markets`, so all
   * four rendered their "nothing here" state permanently while the chain had
   * five markets on it. Trade was the only screen that worked, purely because
   * it read `source.market(symbol)` directly instead.
   *
   * `markets()` hands back the snapshot's own array, so this is a property
   * read, and its identity changes only when a refresh replaces the snapshot -
   * which is exactly when these screens should re-render anyway.
   */
  // Each market's daily change is measured against the previous session's
  // close, which the keeper serves with a month of daily closes for the
  // sparkline. Without it the oracle's own history is too short to say how a
  // market has moved today, and every market read 0.00%.
  const summary = useMarketSummary();
  // The chain-backed source cannot read emitted events; the keeper indexes
  // them. Off-chain, the modelled source supplies its own.
  const indexed = useKeeperEvents();
  const activity = indexed.length
    ? indexed
        .map(toActivity)
        .filter((a) => a !== null)
        .slice(0, 7)
    : source.activity(7);
  const indexedActions = indexed
    .map(toCorporateAction)
    .filter((a) => a !== null);
  const corporateActions = (symbol?: string) =>
    indexedActions.length
      ? indexedActions.filter((a) => !symbol || a.symbol === symbol)
      : source.corporateActions(symbol);
  const markets = source
    .markets()
    .map((mv) => withSummary(mv, summary[mv.oracle.symbol]));

  /*
   * One failed poll is not an outage.
   *
   * `api.devnet.solana.com` is shared and rate limits under load, so a
   * dropped read is routine; the previous snapshot is still good and the next
   * poll usually succeeds. Flipping the badge to RPC ERROR on the first one
   * made the interface flash red and recover repeatedly, which reads as a
   * malfunction rather than as a retry - and trains anyone watching to
   * discount the badge when it finally means something.
   */
  const ERROR_AFTER_CONSECUTIVE = 3;
  const degraded =
    liveStatus.lastError !== null &&
    liveStatus.consecutiveErrors >= ERROR_AFTER_CONSECUTIVE;

  /*
   * The first read has not landed yet.
   *
   * Screens that do arithmetic over an empty array render confident zeroes,
   * and screens with empty states assert that nothing exists. Both are claims
   * about the protocol rather than about the fetch, and on a cold load against
   * a shared endpoint they are on screen long enough to be the first thing
   * anyone sees. The mock source is never in this state, which is why it went
   * unnoticed.
   */
  const loadingFirstRead = liveStatus.live && liveStatus.loadedAt === null;
  const view = markets.find((mv) => mv.oracle.symbol === symbol) ?? markets[0];

  const openMarket = useCallback((s: string) => {
    setSymbol(s);
    setTab("Trade");
    setMenuOpen(false);
  }, []);

  const requestSignIn = useCallback((reason?: string) => {
    setAuthReason(reason);
    setAuthOpen(true);
  }, []);

  function selectTab(next: Tab) {
    setTab(next);
    setMenuOpen(false);
    const reason = NEEDS_SESSION[next];
    if (reason && session.capability === "anonymous") requestSignIn(reason);
  }

  function signOut() {
    if (session.method === "passkey") {
      const confirmed = window.confirm(
        "Sign out and forget this account on this device?\n\n" +
          "The encrypted key is stored here and nowhere else. Once removed, the passkey alone " +
          "cannot recover it.",
      );
      if (!confirmed) return;
      forgetAccount();
    }
    setSession(restoreSession());
  }

  return (
    <>
      <Splash />
      <AmbientShader />
      <div className="app">
        <GlassPanel
          weight="chrome"
          radius={0}
          className="topbar-shell topbar-glass"
          innerClassName="topbar"
          as="header"
        >
          {/* Mark and word together. The mark had to be drawn for the tab
            icon and the link preview anyway; putting it here is what makes
            those two surfaces recognisable as this one. */}
          <div className="crisp">
            <Wordmark />
          </div>

          <button
            className="nav-toggle"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            // The visible label is hidden on narrow screens to buy back the
            // width that keeps the bar on one row, so the name has to come
            // from somewhere that CSS cannot take away.
            aria-label="Menu"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Icon name={menuOpen ? "plus" : "layers"} size={18} />
            <span>Menu</span>
          </button>

          <nav
            className="nav crisp"
            id="primary-nav"
            aria-label="Primary"
            data-open={menuOpen ? "true" : "false"}
          >
            {TABS.map((t) => (
              <button
                key={t}
                className="nav-item"
                aria-current={t === tab ? "page" : undefined}
                onClick={() => selectTab(t)}
              >
                {t}
              </button>
            ))}
          </nav>

          <div className="topbar-controls crisp">
            {source.kind === "mock" ? (
              <span
                className="pill demo-pill"
                data-tone="neutral"
                title="Reading from the in-memory source, not RPC"
              >
                <span className="dot" aria-hidden />
                DEMO DATA
              </span>
            ) : (
              <button
                className="pill demo-pill"
                data-tone={degraded ? "halted" : "open"}
                onClick={liveStatus.refresh}
                title={
                  degraded
                    ? (liveStatus.lastError ?? "The endpoint is not answering")
                    : liveStatus.loadedAt
                      ? `Last read ${ago(liveStatus.loadedAt, now)}`
                      : "Reading the chain"
                }
              >
                <span className="dot" aria-hidden />
                {degraded
                  ? "RPC ERROR"
                  : liveStatus.refreshing
                    ? "SYNCING"
                    : "LIVE"}
              </button>
            )}

            <div className="icon-cluster">
              {/*
                There were a search button and a notification bell here. Both
                did nothing: no handler on one, no notifications behind the
                other. A control that does not respond is a defect a viewer
                finds in the first ten seconds, and neither was load-bearing,
                so neither is here now. A market search is worth building
                properly when there is something to search that the Overview
                grid does not already show.
              */}
              <button
                className="icon-btn"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              >
                <Icon name={theme === "dark" ? "sun" : "moon"} />
              </button>
            </div>

            {session.address ? (
              <div className="account-cluster">
                <AddressDisplay
                  address={session.address}
                  label={
                    <Icon
                      name={session.method === "passkey" ? "shield" : "wallet"}
                      size={14}
                    />
                  }
                  explorerHref={explorerAddress(session.address)}
                />
                {session.capability === "watching" && (
                  <span className="account-locked">locked</span>
                )}
                <button className="account-signout" onClick={signOut}>
                  Sign out
                </button>
              </div>
            ) : (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => requestSignIn()}
              >
                Sign in
              </button>
            )}
          </div>
        </GlassPanel>

        <main>
          {tab === "Overview" && (
            <Markets
              markets={markets}
              corporateActions={corporateActions().length}
              loading={loadingFirstRead}
              onOpen={openMarket}
              onExplore={() => setTab("Registry")}
            />
          )}

          {tab === "Registry" && (
            <Registry registry={registry} now={now} onOpenMarket={openMarket} />
          )}

          {tab === "Trade" && view && (
            <Suspense
              fallback={
                <div
                  className="skeleton-chart"
                  role="status"
                  aria-label="Loading the market"
                  style={{ height: 320 }}
                />
              }
            >
              <Trade
                view={view}
                position={source.positionFor(view.market.address)}
                corporateActions={corporateActions(view.oracle.symbol)}
                now={now}
                onBack={() => setTab("Overview")}
                session={session}
                onSignIn={() =>
                  requestSignIn("Sign in with a wallet to trade.")
                }
                onFilled={liveStatus.refresh}
              />
            </Suspense>
          )}

          {tab === "Portfolio" && (
            <Portfolio
              positions={source.positions()}
              markets={markets}
              activity={activity}
              now={now}
              onOpen={openMarket}
              loading={loadingFirstRead}
            />
          )}

          {tab === "Liquidity" && (
            <Liquidity
              markets={markets}
              lpPositions={(p) => source.lpPosition(p)}
              now={now}
              loading={loadingFirstRead}
              session={session}
              onSignIn={() =>
                requestSignIn("Sign in with a wallet to provide liquidity.")
              }
              onDone={liveStatus.refresh}
            />
          )}

          {(tab === "Terms" || tab === "Privacy") && (
            <Legal doc={tab} onNavigate={(t) => selectTab(t as Tab)} />
          )}

          {tab === "Treasuries" && (
            <Treasury
              treasuries={source.treasuries()}
              markets={markets}
              positionFor={(t) => source.treasuryPosition(t)}
              now={now}
              loading={loadingFirstRead}
            />
          )}
        </main>

        <Footer onNavigate={(t) => selectTab(t as Tab)} />

        <AuthSheet
          open={authOpen}
          reason={authReason}
          onClose={() => setAuthOpen(false)}
          onSession={setSession}
        />
      </div>
    </>
  );
}
