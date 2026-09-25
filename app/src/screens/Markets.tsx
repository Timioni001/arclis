/**
 * The front page.
 *
 * A hero banner sets the product up in one line, then a summary strip, then the
 * market grid. Session state is as prominent as price, because on Arclis it
 * decides what you can actually do. A generic token dashboard would put volume
 * in that slot.
 */
import type { MarketView } from "../lib/protocol/types";
import * as m from "../lib/protocol/math";
import {
  BadgeLime,
  Card,
  CardLink,
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
import { bpsToPct, confidencePct, pct, toPrice, usd } from "../lib/format";
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
  interface: 237,
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
  const movers = [...markets]
    .sort((a, b) => Math.abs(b.changePct24h) - Math.abs(a.changePct24h))
    .slice(0, 4);

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

      <div className="split-2">
        <Card
          title="Biggest movers"
          note="24 hours"
          action={<CardLink>View all</CardLink>}
        >
          <div className="rows">
            {movers.map((mv) => (
              <ListRow
                key={mv.oracle.symbol}
                icon={
                  <Chip accent={mv === movers[0]}>
                    {mv.oracle.symbol.slice(0, 2)}
                  </Chip>
                }
                title={mv.oracle.symbol}
                sub={mv.oracle.name}
                value={<PriceTicker value={toPrice(mv.oracle.price)} />}
                meta={
                  <Delta value={mv.changePct24h}>{pct(mv.changePct24h)}</Delta>
                }
                onClick={() => onOpen(mv.oracle.symbol)}
              />
            ))}
          </div>
        </Card>

        <Card
          title="Why this is different"
          note="What a generic perp venue gets wrong on equities"
        >
          <div className="rows">
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
      </div>

      <div
        className="page-head"
        id="market-grid"
        style={{ marginTop: "var(--space-3)" }}
      >
        <div>
          <h2 className="page-title">Markets</h2>
          <p className="page-sub">
            Oracle-priced perpetuals on tokenized equities.
          </p>
        </div>
      </div>

      <div className="grid grid-markets">
        {markets.map((mv) => {
          const { market, oracle } = mv;
          const oi = m.notional(
            market.openInterestLong + market.openInterestShort,
            oracle.price,
          );
          const nav = m.poolNav(
            mv.pool.vaultBalance,
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
          const rate = m.fundingRateBps(
            m.skewBps(market.openInterestLong, market.openInterestShort),
            market.fundingSensitivityBps,
            util ?? 0n,
          );

          return (
            <Card
              key={oracle.symbol}
              className="card-interactive"
              onClick={() => onOpen(oracle.symbol)}
            >
              <div className="card-head">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-3)",
                  }}
                >
                  <Chip accent={oracle.session === "Open"}>
                    {oracle.symbol.slice(0, 2)}
                  </Chip>
                  <div>
                    <div className="card-title">{oracle.symbol}</div>
                    <div className="card-note">{oracle.name}</div>
                  </div>
                </div>
                <SessionBadge session={oracle.session} symbol={oracle.symbol} />
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "space-between",
                  gap: "var(--space-3)",
                }}
              >
                <Metric
                  value={usd(oracle.price, { compact: false })}
                  size="lg"
                  sub={
                    <Delta value={mv.changePct24h}>
                      {pct(mv.changePct24h)} today
                    </Delta>
                  }
                />
                <Sparkline candles={mv.spark ?? mv.candles.slice(-40)} />
              </div>

              <div className="rows" style={{ marginTop: "var(--space-4)" }}>
                <ListRow
                  title="Open interest"
                  sub={`Funding ${bpsToPct(rate, 3)} / 1h`}
                  value={usd(oi)}
                  meta={
                    rate > 0n
                      ? "longs pay"
                      : rate < 0n
                        ? "shorts pay"
                        : "balanced"
                  }
                />
                <ListRow
                  title="Oracle confidence"
                  sub={`24h volume ${usd(mv.volume24h)}`}
                  value={
                    <BadgeLime>
                      {confidencePct(oracle.price, oracle.confidence).toFixed(
                        1,
                      )}
                      %
                    </BadgeLime>
                  }
                />
              </div>
            </Card>
          );
        })}
      </div>

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

      <div
        className="grid grid-markets"
        role="status"
        aria-label="Loading markets from the chain"
      >
        {Array.from({ length: 6 }, (_, i) => (
          <Card key={i}>
            <div className="card-head">
              <Skeleton width={120} height={20} />
              <Skeleton width={64} height={20} radius="var(--radius-pill)" />
            </div>
            <Skeleton
              width="55%"
              height={30}
              style={{ marginTop: "var(--space-4)" }}
            />
            <div style={{ marginTop: "var(--space-4)" }}>
              <Skeleton height={12} style={{ marginBottom: 10 }} />
              <Skeleton width="85%" height={12} style={{ marginBottom: 10 }} />
              <Skeleton width="70%" height={12} />
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
