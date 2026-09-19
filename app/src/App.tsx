/**
 * App shell: navigation, wallet state, theme, and routing between screens.
 *
 * Routing is a `useState` rather than a router, deliberately — five screens, no
 * deep-linking requirement yet, and one less dependency to explain. Swapping in
 * a real router later touches only this file.
 */
import { useEffect, useMemo, useState } from "react";
import type { DataSource } from "./lib/protocol/mock";
import { Markets } from "./screens/Markets";
import { Trade } from "./screens/Trade";
import { Liquidity } from "./screens/Liquidity";
import { Treasury } from "./screens/Treasury";
import { Portfolio } from "./screens/Portfolio";
import { shortAddress } from "./lib/format";
import { Icon } from "./components/ui";

const TABS = ["Overview", "Trade", "Portfolio", "Liquidity", "Treasuries"] as const;
type Tab = (typeof TABS)[number];

export function App({ source }: { source: DataSource }) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [symbol, setSymbol] = useState<string>("AAPL");
  const [theme, setTheme] = useState<"light" | "dark">(
    () =>
      (localStorage.getItem("arclis-theme") as "light" | "dark" | null) ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
  // A clock, so "12s ago" stays true without re-fetching anything.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("arclis-theme", theme);
    } catch {
      // Private browsing: the preference just does not persist.
    }
  }, [theme]);

  const markets = useMemo(() => source.markets(), [source]);
  const view = source.market(symbol) ?? markets[0];

  function openMarket(s: string) {
    setSymbol(s);
    setTab("Trade");
  }

  const wallet = source.wallet();

  return (
    <div className="app">
      <header className="topbar">
        {/* The wordmark is the mark. No logo glyph — the name set in the
            display face at 800 carries it. */}
        <div className="wordmark">arclis</div>

        <nav className="nav" aria-label="Primary">
          {TABS.map((t) => (
            <button
              key={t}
              className="nav-item"
              aria-current={t === tab ? "page" : undefined}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>

        <div className="topbar-controls">
          {source.kind === "mock" && (
            <span className="pill demo-pill" data-tone="neutral" title="Reading from the in-memory source, not RPC">
              <span className="dot" aria-hidden />
              DEMO DATA
            </span>
          )}

          <div className="icon-cluster">
            <button className="icon-btn" aria-label="Search"><Icon name="search" /></button>
            <button className="icon-btn" aria-label="Notifications"><Icon name="bell" /></button>
            <button
              className="icon-btn"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>

          {wallet ? (
            <button className="avatar" title={`Connected ${shortAddress(wallet)}`} aria-label={`Wallet ${shortAddress(wallet)}`}>
              <Icon name="wallet" size={18} />
            </button>
          ) : (
            <button className="btn btn-sm btn-primary">Connect wallet</button>
          )}
        </div>
      </header>

      <main>
        {tab === "Overview" && <Markets markets={markets} onOpen={openMarket} />}

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
          <Liquidity markets={markets} lpPositions={(p) => source.lpPosition(p)} now={now} />
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
    </div>
  );
}
