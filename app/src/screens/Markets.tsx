/**
 * The front page.
 *
 * A hero banner sets the product up in one line, then a summary strip, then the
 * market grid. Session state is as prominent as price, because on Arclis it
 * decides what you can actually do. A generic token dashboard would put volume
 * in that slot.
 */
import { useMemo, useState } from "react";
import type { MarketView } from "../lib/protocol/types";
import { roundTheClock } from "../lib/markets";
import * as m from "../lib/protocol/math";
import {
  Card,
  Chip,
  Delta,
  Hero,
  Icon,
  ListRow,
  Metric,
  SegBar,
  Skeleton,
  StatTile,
} from "../components/ui";
import { SessionBadge } from "../components/protocol";
import { Sparkline } from "../components/charts/PriceChart";
import { bpsToPct, pct, toPrice, usd } from "../lib/format";
import { PriceTicker } from "../components/ui/data";
import { BrandMark, brandById } from "../components/ui/Brand";
import { INSTRUCTION_COUNT } from "../idl/program-id";

/*
 * Test counts, in one place.
 *
 * These are evidence on the front page, so they have to be true, and they had
 * drifted twice. The instruction count above is generated from the IDL and
 * cannot drift again; a test suite cannot count itself from inside, so these
 * four stay by hand, gathered here so recounting is one edit rather than a
 * hunt through JSX.
 *
 *   cargo test --lib          unit
 *   npm run test:integration  against a validator
 *   npm --prefix app test     interface
 *   npm run test:dbc          DBC tooling
 */
const TESTS = {
  unit: 129,
  integration: 25,
  interface: 244,
  dbc: 37,
};

export function Markets({
  markets,
  corporateActions = 0,
  loading = false,
  onOpen,
  onExplore,
}: {
  markets: MarketView[];
  /** How many splits or dividends this deployment has actually applied. */
  corporateActions?: number;
  /**
   * True until the first read of the chain lands.
   *
   * Without it this page renders its arithmetic over an empty array and shows
   * "0 / 0 markets open" and "$0" liquidity, which reads as a dead protocol
   * rather than as a page that has not loaded. On a cold load against a shared
   * endpoint that is on screen for a second or two, which is long enough for a
   * first impression.
   */
  loading?: boolean;
  onOpen: (symbol: string) => void;
  /** Hand the front page's primary call to action to the registry. */
  onExplore?: () => void;
}) {
  const totalOi = markets.reduce(
    (a, mv) =>
      a +
      m.notional(
        mv.market.openInterestLong + mv.market.openInterestShort,
        mv.oracle.price,
      ),
    0n,
  );
  const totalLiquidity = markets.reduce(
    (a, mv) => a + mv.pool.vaultBalance,
    0n,
  );
  const openCount = markets.filter((mv) => mv.oracle.session === "Open").length;

  return (
    <div className="page">
      <Hero
        eyebrow="ON-CHAIN ACCESS TO PUBLIC MARKETS"
        title="Know exactly what you"
        highlight="own."
        body="Look up any tokenized stock on Solana and see its real backing, custody and redemption rights. Then trade it on a perpetual that respects market hours, halts, splits and dividends."
        cta="Look up a tokenized stock"
        ecosystem
        onCta={() =>
          onExplore
            ? onExplore()
            : document
                .getElementById("market-grid")
                ?.scrollIntoView({ behavior: "smooth" })
        }
      />

      {loading ? (
        <MarketsSkeleton />
      ) : (
        <>
          <div className="grid grid-4">
            <Card>
              <Metric
                label="Markets open"
                value={`${openCount} / ${markets.length}`}
                size="lg"
              />
              <div style={{ marginTop: "var(--space-3)" }}>
                <SegBar
                  value={openCount}
                  max={markets.length}
                  segments={markets.length}
                  ariaLabel="Markets currently open"
                />
              </div>
            </Card>
            <Card>
              <Metric
                label="Total open interest"
                value={usd(totalOi)}
                size="lg"
                sub="across all markets"
              />
            </Card>
            <Card>
              <Metric
                label="Liquidity backing"
                value={usd(totalLiquidity)}
                size="lg"
                sub="LP capital on the other side"
              />
            </Card>
            <Card>
              {/*
            Counted, not asserted. This tile used to read "1 / AAPL 4:1 split,
            handled" as a hardcoded string, which was true of a test fixture
            and not of any running deployment.
          */}
              <Metric
                label="Corporate actions"
                value={String(corporateActions)}
                size="lg"
                sub={
                  corporateActions > 0
                    ? "splits and dividends applied on-chain"
                    : "none since this deployment opened"
                }
              />
            </Card>
          </div>

          <TodaysMovers markets={markets} onOpen={onOpen} />

          <MarketList markets={markets} onOpen={onOpen} />

          <Card
            title="Why this is different"
            note="What a generic perp venue gets wrong on equities"
          >
            <div className="why-grid">
              <ListRow
                icon={
                  <Chip accent>
                    <Icon name="clock" />
                  </Chip>
                }
                title="A market calendar, on-chain"
                sub="Closed means reduce-only, not shut down"
              />
              <ListRow
                icon={
                  <Chip>
                    <Icon name="swap" />
                  </Chip>
                }
                title="Corporate actions"
                sub="A 4:1 split is not a 75% crash"
              />
              <ListRow
                icon={
                  <Chip>
                    <Icon name="layers" />
                  </Chip>
                }
                title="A funded counterparty"
                sub="Winners are paid by the pool, not by other traders"
              />
              <ListRow
                icon={
                  <Chip>
                    <Icon name="target" />
                  </Chip>
                }
                title="Oracle bounds"
                sub="Staleness, confidence and per-update deviation"
              />
            </div>
          </Card>
        </>
      )}

      {/* Counted, not estimated. See TESTS and INSTRUCTION_COUNT above. */}
      <div className="stat-tiles">
        <StatTile
          label="Program"
          value={`${INSTRUCTION_COUNT} instructions`}
          sub="sessions, splits, pool, treasuries"
        />
        <StatTile
          label="Program tests"
          value={`${TESTS.unit + TESTS.integration} passing`}
          sub={`${TESTS.unit} unit, ${TESTS.integration} against a validator`}
        />
        <StatTile
          label="Interface tests"
          value={`${TESTS.interface} passing`}
          sub="read model vs the program"
        />
        {/*
          The one stat tile that carries a mark, and the only place outside
          the hero strip and the footer that does.

          This is a claim about our own tooling - `src/dbc` builds real DBC
          configs and the suite runs against Meteora's published SDK - so the
          mark is evidence, not a placement. The registry deliberately does
          not do this: it lists Meteora DLMM alongside Orca Whirlpool and
          Raydium CLMM as venues, and giving one of them a logo on a page that
          says it "does not rank, endorse, or accept payment for placement"
          would be exactly the thing that sentence promises not to do.
        */}
        <StatTile
          label={
            <span className="metric-label-brand">
              <BrandMark brand={brandById("meteora")} size={14} />
              Meteora DBC tooling
            </span>
          }
          value={`${TESTS.dbc} passing`}
          sub="against the real SDK"
        />
      </div>
    </div>
  );
}

/**
 * The front page's shape, while the first read is in flight.
 *
 * Everything between the hero and the proof tiles is arithmetic over the
 * markets array, so an empty array renders a page of confident zeroes rather
 * than a blank one. "0 / 0 markets open" and "$0 liquidity backing" are claims
 * about the protocol, and they are false ones. This says the same layout is
 * coming without saying anything about what is in it.
 *
 * The hero and the proof tiles are left alone on purpose: neither reads the
 * chain, so both are true before the first byte arrives, and replacing them
 * with grey boxes would make the page look less loaded than it is.
 */
function MarketsSkeleton() {
  return (
    <>
      <div className="grid grid-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i}>
            <Skeleton width="45%" height={11} />
            <Skeleton
              width="65%"
              height={28}
              style={{ marginTop: "var(--space-3)" }}
            />
            <Skeleton
              width="80%"
              height={11}
              style={{ marginTop: "var(--space-3)" }}
            />
          </Card>
        ))}
      </div>

      <Card>
        <div role="status" aria-label="Loading markets from the chain">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="market-row" style={{ cursor: "default" }}>
              <span className="mc-name">
                <Skeleton width={140} height={18} />
              </span>
              <span className="mc-status">
                <Skeleton width={64} height={20} radius="var(--radius-pill)" />
              </span>
              <span className="mc-spark">
                <Skeleton width={90} height={18} />
              </span>
              <span className="mc-price">
                <Skeleton width={70} height={16} />
              </span>
              <span className="mc-change">
                <Skeleton width={50} height={16} />
              </span>
              <span className="mc-oi">
                <Skeleton width={70} height={16} />
              </span>
              <span className="mc-funding">
                <Skeleton width={50} height={16} />
              </span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Today's movers
// ---------------------------------------------------------------------------

const MOVERS_SHOWN = 5;

/**
 * Gainers, losers and the most traded, side by side.
 *
 * With thirty-five markets a single "biggest movers" list of four hid which
 * way anything moved. Split by direction, each list answers one question at a
 * glance. The change is against the previous session's close, so the lists
 * are about today, not a rolling window.
 */
function TodaysMovers({
  markets,
  onOpen,
}: {
  markets: MarketView[];
  onOpen: (symbol: string) => void;
}) {
  const gainers = markets
    .filter((mv) => mv.changePct24h > 0)
    .sort((a, b) => b.changePct24h - a.changePct24h)
    .slice(0, MOVERS_SHOWN);
  const losers = markets
    .filter((mv) => mv.changePct24h < 0)
    .sort((a, b) => a.changePct24h - b.changePct24h)
    .slice(0, MOVERS_SHOWN);
  // Volume first; open interest breaks ties and carries a quiet day, when
  // the day's volume is zero everywhere and would rank nothing.
  const active = [...markets]
    .sort(
      (a, b) =>
        Number(b.volume24h - a.volume24h) ||
        Number(openInterest(b) - openInterest(a)),
    )
    .slice(0, MOVERS_SHOWN);

  return (
    <section aria-labelledby="movers-title">
      <div className="section-head">
        <h2 className="section-title" id="movers-title">
          Today&apos;s movers
        </h2>
        <span className="section-note">Change since the previous close</span>
      </div>
      <div className="movers-grid">
        <MoverList
          title="Top gainers"
          empty="Nothing is up since the last close."
          rows={gainers}
          onOpen={onOpen}
          show="change"
        />
        <MoverList
          title="Top losers"
          empty="Nothing is down since the last close."
          rows={losers}
          onOpen={onOpen}
          show="change"
        />
        <MoverList
          title="Most traded"
          empty="No trades yet today."
          rows={active}
          onOpen={onOpen}
          show="volume"
        />
      </div>
    </section>
  );
}

function MoverList({
  title,
  empty,
  rows,
  onOpen,
  show,
}: {
  title: string;
  empty: string;
  rows: MarketView[];
  onOpen: (symbol: string) => void;
  show: "change" | "volume";
}) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="metric-sub">{empty}</p>
      ) : (
        <div className="rows">
          {rows.map((mv, i) => (
            <ListRow
              key={mv.oracle.symbol}
              icon={<span className="mover-rank num">{i + 1}</span>}
              title={
                <span className="mover-symbol">
                  {mv.oracle.symbol}
                  {roundTheClock(mv.oracle.symbol) && (
                    <span className="badge-lime mover-tag">24/7</span>
                  )}
                </span>
              }
              sub={mv.oracle.name}
              value={<PriceTicker value={toPrice(mv.oracle.price)} />}
              meta={
                show === "change" ? (
                  <Delta value={mv.changePct24h}>{pct(mv.changePct24h)}</Delta>
                ) : mv.volume24h > 0n ? (
                  `${usd(mv.volume24h)} vol`
                ) : (
                  `${usd(openInterest(mv))} OI`
                )
              }
              onClick={() => onOpen(mv.oracle.symbol)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Every market, as a list
// ---------------------------------------------------------------------------

function openInterest(mv: MarketView): bigint {
  return m.notional(
    mv.market.openInterestLong + mv.market.openInterestShort,
    mv.oracle.price,
  );
}

function fundingRate(mv: MarketView): bigint {
  const { market, oracle, pool } = mv;
  const nav = m.poolNav(
    pool.vaultBalance,
    m.netTraderPnl(
      market.openInterestLong,
      market.longEntryNotional,
      market.openInterestShort,
      market.shortEntryNotional,
      oracle.price,
    ),
  );
  const util = m.utilizationBps(
    m.netExposureNotional(
      market.openInterestLong,
      market.openInterestShort,
      oracle.price,
    ),
    nav,
  );
  return m.fundingRateBps(
    m.skewBps(market.openInterestLong, market.openInterestShort),
    market.fundingSensitivityBps,
    util ?? 0n,
  );
}

const FILTERS = ["All", "Open now", "24/7"] as const;
type Filter = (typeof FILTERS)[number];
type SortKey = "move" | "gainers" | "losers" | "oi" | "az";

/**
 * All markets in one scannable list.
 *
 * Thirty-five cards was a page of scrolling where the one number people look
 * for, today's change, sat in a different place on every card. A row per
 * market lines the columns up, and search, a session filter and a sort make
 * a long list short.
 */
function MarketList({
  markets,
  onOpen,
}: {
  markets: MarketView[];
  onOpen: (symbol: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [sort, setSort] = useState<SortKey>("move");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = markets.filter((mv) => {
      if (filter === "Open now" && mv.oracle.session !== "Open") return false;
      if (filter === "24/7" && !roundTheClock(mv.oracle.symbol)) return false;
      if (!q) return true;
      return (
        mv.oracle.symbol.toLowerCase().includes(q) ||
        mv.oracle.name.toLowerCase().includes(q)
      );
    });
    const by: Record<SortKey, (a: MarketView, b: MarketView) => number> = {
      move: (a, b) => Math.abs(b.changePct24h) - Math.abs(a.changePct24h),
      gainers: (a, b) => b.changePct24h - a.changePct24h,
      losers: (a, b) => a.changePct24h - b.changePct24h,
      oi: (a, b) => Number(openInterest(b) - openInterest(a)),
      az: (a, b) => a.oracle.symbol.localeCompare(b.oracle.symbol),
    };
    return list.sort(by[sort]);
  }, [markets, query, filter, sort]);

  const count = (f: Filter) =>
    f === "All"
      ? markets.length
      : f === "Open now"
        ? markets.filter((mv) => mv.oracle.session === "Open").length
        : markets.filter((mv) => roundTheClock(mv.oracle.symbol)).length;

  return (
    <section aria-labelledby="market-grid-title" id="market-grid">
      <div className="section-head">
        <h2 className="section-title" id="market-grid-title">
          All markets
        </h2>
        <span className="section-note">
          Oracle-priced perpetuals on tokenized equities
        </span>
      </div>

      <div className="market-tools">
        <label className="registry-search">
          <Icon name="search" size={17} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ticker or company"
            aria-label="Search markets"
          />
        </label>
        <div
          className="registry-filter-group"
          role="group"
          aria-label="Filter markets"
        >
          {FILTERS.map((f) => (
            <button
              key={f}
              className="registry-filter"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f} <span className="filter-count">{count(f)}</span>
            </button>
          ))}
        </div>
        <label className="registry-sort">
          <span className="sr-only">Sort markets</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="move">Biggest move</option>
            <option value="gainers">Gainers first</option>
            <option value="losers">Losers first</option>
            <option value="oi">Open interest</option>
            <option value="az">A to Z</option>
          </select>
        </label>
      </div>

      <Card className="market-table-card">
        <div className="market-row market-row-head" aria-hidden="true">
          <span className="mc-name">Market</span>
          <span className="mc-status">Status</span>
          <span className="mc-spark">7 days</span>
          <span className="mc-price">Price</span>
          <span className="mc-change">Today</span>
          <span className="mc-oi">Open interest</span>
          <span className="mc-funding">Funding / 1h</span>
        </div>
        {rows.length === 0 && (
          <p className="metric-sub market-empty">
            No market matches &ldquo;{query}&rdquo;.
          </p>
        )}
        {rows.map((mv) => {
          const rate = fundingRate(mv);
          return (
            <button
              key={mv.oracle.symbol}
              className="market-row"
              onClick={() => onOpen(mv.oracle.symbol)}
            >
              <span className="mc-name">
                <Chip small accent={mv.oracle.session === "Open"}>
                  {mv.oracle.symbol.slice(0, 2)}
                </Chip>
                <span className="mc-name-text">
                  <span className="mc-symbol">{mv.oracle.symbol}</span>
                  <span className="mc-company">{mv.oracle.name}</span>
                </span>
              </span>
              <span className="mc-status">
                <SessionBadge
                  session={mv.oracle.session}
                  symbol={mv.oracle.symbol}
                />
              </span>
              <span className="mc-spark">
                <Sparkline
                  candles={mv.spark ?? mv.candles.slice(-40)}
                  width={96}
                  height={26}
                />
              </span>
              <span className="mc-price num">
                {usd(mv.oracle.price, { compact: false })}
              </span>
              <span className="mc-change num">
                <Delta value={mv.changePct24h}>{pct(mv.changePct24h)}</Delta>
              </span>
              <span className="mc-oi num">{usd(openInterest(mv))}</span>
              <span className="mc-funding num">{bpsToPct(rate, 3)}</span>
            </button>
          );
        })}
      </Card>
    </section>
  );
}
