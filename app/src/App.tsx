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
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DataSource } from "./lib/protocol/mock";
import { modelledRegistry } from "./lib/registry/data";
import { restoreSession, type Session } from "./lib/auth/session";
import { forgetAccount } from "./lib/auth/passkey";
import { Markets } from "./screens/Markets";
import { Registry } from "./screens/Registry";
import { Trade } from "./screens/Trade";
import { Liquidity } from "./screens/Liquidity";
import { Treasury } from "./screens/Treasury";
import { Portfolio } from "./screens/Portfolio";
import { AuthSheet } from "./components/auth/AuthSheet";
import { Splash } from "./components/motion/Splash";
import { AmbientShader } from "./components/motion/AmbientShader";
import { AddressDisplay, NotificationBell } from "./components/ui/data";
import { useLiveSource } from "./lib/protocol/useLiveSource";
import { explorerAddress, REFRESH_INTERVAL_MS } from "./lib/config";
import { ago } from "./lib/format";
import { Icon } from "./components/ui";
import { Footer } from "./components/ui/Footer";
import { GlassPanel } from "./components/ui/Glass";

const TABS = [
  "Overview",
  "Registry",
  "Trade",
  "Portfolio",
  "Liquidity",
  "Treasuries",
] as const;
type Tab = (typeof TABS)[number];

/** Screens that need a signature to be worth opening. Registry is not one. */
const NEEDS_SESSION: Record<Tab, string | null> = {
  Overview: null,
  Registry: null,
  Trade: null,
  Portfolio: "Sign in to see the positions held by your account.",
  Liquidity: null,
  Treasuries: null,
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

  const registry = useMemo(() => modelledRegistry(), []);

  // Drives the RPC source when there is one, and is inert on the mock. The
  // interval pauses while the tab is hidden; see `useLiveSource`.
  const liveStatus = useLiveSource(
    source,
    session.address,
    REFRESH_INTERVAL_MS,
  );

  const markets = useMemo(() => source.markets(), [source]);
  const view = source.market(symbol) ?? markets[0];

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
          {/* The wordmark is the mark. No logo glyph: the name set in the
            display face at 800 carries it. */}
          <div className="wordmark crisp">arclis</div>

          <button
            className="nav-toggle"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
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
                data-tone={liveStatus.lastError ? "halted" : "open"}
                onClick={liveStatus.refresh}
                title={
                  liveStatus.lastError ??
                  (liveStatus.loadedAt
                    ? `Last read ${ago(liveStatus.loadedAt, now)}`
                    : "Reading the chain")
                }
              >
                <span className="dot" aria-hidden />
                {liveStatus.lastError
                  ? "RPC ERROR"
                  : liveStatus.refreshing
                    ? "SYNCING"
                    : "LIVE"}
              </button>
            )}

            <div className="icon-cluster">
              <button className="icon-btn" aria-label="Search">
                <Icon name="search" />
              </button>
              <NotificationBell count={0} />
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
              onOpen={openMarket}
              onExplore={() => setTab("Registry")}
            />
          )}

          {tab === "Registry" && (
            <Registry registry={registry} now={now} onOpenMarket={openMarket} />
          )}

          {tab === "Trade" && view && (
            <Trade
              view={view}
              position={source.positionFor(view.market.address)}
              corporateActions={source.corporateActions(view.oracle.symbol)}
              now={now}
              onBack={() => setTab("Overview")}
            />
          )}

          {tab === "Portfolio" && (
            <Portfolio
              positions={source.positions()}
              markets={markets}
              activity={source.activity(7)}
              now={now}
              onOpen={openMarket}
            />
          )}

          {tab === "Liquidity" && (
            <Liquidity
              markets={markets}
              lpPositions={(p) => source.lpPosition(p)}
              now={now}
            />
          )}

          {tab === "Treasuries" && (
            <Treasury
              treasuries={source.treasuries()}
              markets={markets}
              positionFor={(t) => source.treasuryPosition(t)}
              now={now}
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
