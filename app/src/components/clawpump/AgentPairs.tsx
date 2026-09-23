/**
 * Where an agent can raise: every tokenized stock ClawPump will quote a launch
 * in, and which of them Arclis can hedge.
 *
 * This is the front half of the treasury story, and it belongs next to it. An
 * agent launches its token on Pump.fun through ClawPump, paired against a
 * stock instead of SOL; its creator fees accrue in that stock; and the
 * treasury above shorts the matching perp so the runway stops moving with the
 * company. A stock with an Arclis market is one where all three steps work
 * today, so those are marked and sorted first.
 *
 * Nothing here launches anything. A launch needs a ClawPump key, and a key in
 * this page would be a key every visitor holds, so launching is a command the
 * operator runs. The page says so rather than offering a button that cannot
 * be safe.
 */
import { useMemo, useState } from "react";
import { Card } from "../ui";
import {
  CREATOR_FEE_BPS,
  PAIRS_SNAPSHOT,
  STOCK_PAIRS,
  hedgeable,
  mintUrl,
  type StockPair,
} from "../../lib/clawpump/pairs";

type Filter = "all" | "hedgeable" | "etf";

export function AgentPairs() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("hedgeable");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return STOCK_PAIRS.filter((p) => {
      if (filter === "hedgeable" && !hedgeable(p)) return false;
      if (filter === "etf" && p.kind !== "etf") return false;
      if (!q) return true;
      return (
        p.symbol.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
      );
    }).sort(
      (a, b) =>
        Number(hedgeable(b)) - Number(hedgeable(a)) ||
        a.symbol.localeCompare(b.symbol),
    );
  }, [query, filter]);

  const hedgeableCount = STOCK_PAIRS.filter(hedgeable).length;

  return (
    <Card
      large
      title="Launch an agent against a stock"
      note={`${STOCK_PAIRS.length} tokenized stocks on ClawPump · ${hedgeableCount} hedgeable on Arclis`}
    >
      <ol className="agent-flow">
        <li>
          <strong>Launch through ClawPump.</strong> The agent&apos;s token goes
          live on a Pump.fun curve quoted in the stock, not in SOL.
        </li>
        <li>
          <strong>Earn in the stock.</strong> A creator fee of{" "}
          {CREATOR_FEE_BPS.min / 100}% to {CREATOR_FEE_BPS.max / 100}% of volume
          accrues in the quote asset, and 75% of it is paid to the agent.
        </li>
        <li>
          <strong>Hedge on Arclis.</strong> The agent&apos;s treasury shorts the
          matching perp, so its runway holds its dollar value while it keeps
          earning around the clock.
        </li>
      </ol>

      <div className="pair-toolbar">
        <label className="input-wrap pair-search">
          <input
            type="search"
            placeholder="Search a ticker or company"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search tokenized stocks"
          />
        </label>
        <div className="legal-switch" role="tablist" aria-label="Filter pairs">
          {(
            [
              ["hedgeable", "Hedgeable on Arclis"],
              ["all", "All stocks"],
              ["etf", "ETFs"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={filter === value}
              className={filter === value ? "is-active" : undefined}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="card-note">No tokenized stock matches that search.</p>
      ) : (
        <ul className="pair-grid">
          {rows.map((p) => (
            <PairRow key={p.mint} pair={p} />
          ))}
        </ul>
      )}

      <p className="card-note pair-foot">
        Pairs as listed by ClawPump on {PAIRS_SNAPSHOT}. Launching needs a
        ClawPump key, which never touches this page: operators launch with{" "}
        <code>npm run clawpump -- launch</code>. Pump.fun launches are on
        Solana mainnet.
      </p>
    </Card>
  );
}

function PairRow({ pair }: { pair: StockPair }) {
  const hedge = hedgeable(pair);
  return (
    <li className="pair-row">
      <div className="pair-id">
        <span className="pair-symbol">{pair.symbol}</span>
        <span className="pair-name">{pair.name}</span>
      </div>
      <div className="pair-meta">
        {hedge ? (
          <span className="badge-lime">Hedgeable</span>
        ) : pair.kind === "etf" ? (
          <span className="pair-kind">ETF</span>
        ) : null}
        <a
          className="pair-mint"
          href={mintUrl(pair.mint)}
          target="_blank"
          rel="noreferrer noopener"
          title={pair.mint}
        >
          {pair.mint.slice(0, 4)}…{pair.mint.slice(-4)}
        </a>
      </div>
    </li>
  );
}
