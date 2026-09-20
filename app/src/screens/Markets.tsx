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
  StatTile,
} from "../components/ui";
import { SessionBadge } from "../components/protocol";
import { Sparkline } from "../components/charts/PriceChart";
import { bpsToPct, confidencePct, pct, toPrice, usd } from "../lib/format";
import { PriceTicker } from "../components/ui/data";

export function Markets({
  markets,
  onOpen,
  onExplore,
}: {
  markets: MarketView[];
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
        onCta={() =>
          onExplore
            ? onExplore()
            : document
                .getElementById("market-grid")
                ?.scrollIntoView({ behavior: "smooth" })
        }
      />

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
          <Metric
            label="Corporate actions"
            value="1"
            size="lg"
            sub="AAPL 4:1 split, handled"
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
                <SessionBadge session={oracle.session} />
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
                <Sparkline candles={mv.candles.slice(-40)} />
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

      <div className="stat-tiles">
        <StatTile
          label="Program"
          value="24 instructions"
          sub="sessions, splits, pool, treasuries"
        />
        <StatTile label="On-chain tests" value="114 passing" />
        <StatTile
          label="Interface tests"
          value="34 passing"
          sub="read model vs the program"
        />
        <StatTile
          label="Meteora DBC tooling"
          value="37 passing"
          sub="against the real SDK"
        />
      </div>
    </div>
  );
}
