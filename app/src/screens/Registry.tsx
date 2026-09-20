/**
 * The registry: a public lookup for tokenized equities on Solana.
 *
 * # Why this screen refuses a wallet
 *
 * Every other surface in Arclis is a trading interface and asks for a wallet
 * when it needs one. This one never does, and the code enforces it: nothing
 * here reads `source.wallet()`, there is no connect prompt, and no action
 * anywhere on the page produces a transaction.
 *
 * That is a product decision, not an omission. The people who most need to
 * know whether their token is a redeemable share claim or a price tracker with
 * a logo are the ones who already bought it, and asking them to connect a
 * wallet to find out is both a trust barrier and an excellent way to make the
 * page unshareable and unindexable. A link that opens straight into the answer
 * is the distribution.
 *
 * # Why it lives inside Arclis rather than beside it
 *
 * The temptation is to keep them separate: Arclis trades, the registry
 * informs, and never the two shall meet. But the registry's central metric is
 * NAV deviation, and NAV deviation is meaningless without knowing whether the
 * reference venue is open. That is the same session matrix the perp engine
 * enforces on-chain, and building it twice would mean maintaining two
 * definitions of "is this price safe to act on".
 *
 * What is kept strictly apart is endorsement. A registry row linking to an
 * Arclis market is a cross-reference, never a recommendation, and a low
 * backing score does not stop the link from appearing.
 */

import { useMemo, useState } from "react";
import {
  assessBacking,
  assessControl,
  assessDeviation,
  assessLiquidity,
  circulatingValue,
  exitCoverageBps,
} from "../lib/registry/scoring";
import { issuerById, type RegistrySource } from "../lib/registry/data";
import {
  BACKING_LABEL,
  BACKING_RANK,
  REDEMPTION_LABEL,
  ATTESTATION_LABEL,
  type BackingTier,
  type TokenizedStock,
} from "../lib/registry/types";
import { SESSION_LABEL } from "../lib/protocol/session";
import {
  Card,
  Chip,
  Icon,
  Notice,
  SegBar,
  StatusPill,
  type Tone,
} from "../components/ui";
import { GlassPanel } from "../components/ui/Glass";
import { Reveal, WordReveal } from "../components/motion/Reveal";
import { AssistantPanel } from "../components/assistant/AssistantPanel";
import { AnimatedCounter, StepPlayer } from "../components/ui/data";
import { ago, usd } from "../lib/format";

/** Backing tiers get their own tone, so the colour is the claim, not a score. */
const BACKING_TONE: Record<BackingTier, Tone> = {
  Redeemable: "open",
  CustodyBacked: "info",
  IssuerAttested: "preopen",
  Synthetic: "halted",
};

type SortKey = "backing" | "deviation" | "liquidity" | "size";

export function Registry({
  registry,
  now,
  onOpenMarket,
}: {
  registry: RegistrySource;
  now: number;
  onOpenMarket: (symbol: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<BackingTier | "All">("All");
  const [sort, setSort] = useState<SortKey>("backing");
  const [selected, setSelected] = useState<string | null>(null);

  const stocks = registry.stocks();

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = stocks.filter((s) => {
      if (tier !== "All" && s.backing !== tier) return false;
      if (!q) return true;
      return (
        s.symbol.toLowerCase().includes(q) ||
        s.underlying.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (issuerById(s.issuerId)?.name.toLowerCase().includes(q) ?? false)
      );
    });

    const withScores = filtered.map((s) => {
      const issuer = issuerById(s.issuerId)!;
      return {
        stock: s,
        issuer,
        backing: assessBacking(s, issuer.attestation, issuer.regulator),
        deviation: assessDeviation(s, now),
        liquidity: assessLiquidity(s.pools),
        value: circulatingValue(s),
      };
    });

    return withScores.sort((a, b) => {
      switch (sort) {
        case "backing":
          // Rank first so the tiers stay grouped, then score inside a tier.
          return (
            BACKING_RANK[b.stock.backing] - BACKING_RANK[a.stock.backing] ||
            b.backing.score - a.backing.score
          );
        case "deviation":
          return Math.abs(b.deviation.bps) - Math.abs(a.deviation.bps);
        case "liquidity":
          return a.liquidity.bestSellImpactBps - b.liquidity.bestSellImpactBps;
        case "size":
          return a.value > b.value ? -1 : a.value < b.value ? 1 : 0;
      }
    });
  }, [stocks, query, tier, sort, now]);

  const detail = selected ? stocks.find((s) => s.symbol === selected) : null;

  return (
    <div className="page">
      <section className="registry-hero">
        <div className="registry-hero-body">
          <div className="registry-eyebrow eyebrow-mono">
            Tokenized equity registry
          </div>
          <WordReveal
            as="h1"
            className="registry-title"
            text="Four issuers. One price chart. Four different things."
            accentFrom={5}
            stagger={0.055}
          />
          <Reveal as="p" className="registry-lede" delay={0.1}>
            Explore tokenized equity instruments and their underlying
            structures. Each listing provides details on the issuer, underlying
            claim, custody arrangement, and redemption mechanism.
          </Reveal>
          <div className="registry-hero-meta crisp">
            <span>
              <AnimatedCounter value={stocks.length} gradient />
              <span className="registry-hero-unit"> tokens</span>
            </span>
            <span aria-hidden>·</span>
            <span>
              <AnimatedCounter value={registry.issuers().length} gradient />
              <span className="registry-hero-unit"> issuers</span>
            </span>
            <span aria-hidden>·</span>
            <span>Updated {ago(registry.asOf(), now)}</span>
          </div>
        </div>
      </section>

      {registry.kind === "modelled" && (
        <Notice
          tone="warning"
          title="This is a modelled dataset, not a live feed"
        >
          Every row below is shaped from public issuer disclosures to build and
          test the pipeline. Before this page goes live, each field is replaced
          by its source: mint authorities and supply from{" "}
          <code>getAccountInfo</code>, depth from Jupiter quotes, and structure
          from the issuer disclosure linked on each row. Do not trade on these
          numbers.
        </Notice>
      )}

      <GlassPanel
        weight="chrome"
        radius={28}
        className="registry-filters-shell"
        innerClassName="registry-filters"
      >
        <label className="registry-search">
          <Icon name="search" size={17} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ticker, company or issuer"
            aria-label="Search the registry"
          />
        </label>

        <div
          className="registry-filter-group"
          role="group"
          aria-label="Filter by backing"
        >
          {(
            [
              "All",
              "Redeemable",
              "CustodyBacked",
              "IssuerAttested",
              "Synthetic",
            ] as const
          ).map((t) => (
            <button
              key={t}
              className="registry-filter"
              aria-pressed={tier === t}
              onClick={() => setTier(t)}
            >
              {t === "All" ? "All" : BACKING_LABEL[t]}
            </button>
          ))}
        </div>

        <label className="registry-sort">
          <span className="sr-only">Sort by</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="backing">Strongest claim first</option>
            <option value="deviation">Widest NAV gap first</option>
            <option value="liquidity">Easiest to exit first</option>
            <option value="size">Largest supply first</option>
          </select>
        </label>
      </GlassPanel>

      <Reveal className="registry-explainer">
        <StepPlayer
          duration={7}
          steps={[
            {
              title: "The claim",
              body: (
                <p>
                  A token named after a stock can be a redeemable certificate, a
                  note against custody you cannot reach, an exchange IOU, or a
                  tracker holding nothing. The claim score breaks that into four
                  parts and shows each one, so the number can be argued with
                  rather than trusted.
                </p>
              ),
            },
            {
              title: "The price gap",
              body: (
                <p>
                  A token drifting from the stock it tracks is usually the
                  clock, not a mispricing. When the reference market is shut its
                  price is frozen and the token keeps trading, so the tolerance
                  widens. Past roughly 5% it stops being a spread and starts
                  meaning redemption is not working.
                </p>
              ),
            },
            {
              title: "The exit",
              body: (
                <p>
                  Ranked by what selling actually costs, not by pool size. A
                  large pool that is mostly one-sided will not let you out, and
                  total value locked will happily call it the deepest venue.
                </p>
              ),
            },
            {
              title: "The mint",
              body: (
                <p>
                  Freeze and mint authorities are read from the chain, not from
                  the issuer, and reported rather than scored. A freeze
                  authority is required on a regulated security token and is a
                  very different fact on one marketed as permissionless.
                </p>
              ),
            },
          ]}
        />
      </Reveal>

      <AssistantPanel />

      <div className="registry-grid">
        {rows.map(({ stock, issuer, backing, deviation, liquidity, value }) => (
          <Card
            key={stock.symbol}
            className={`registry-card ${selected === stock.symbol ? "is-open" : ""}`}
          >
            <header className="registry-card-head">
              <div className="registry-ident">
                <Chip accent={stock.backing === "Redeemable"}>
                  <Icon name="layers" size={17} />
                </Chip>
                <div className="registry-ident-text">
                  <div className="registry-symbol">{stock.symbol}</div>
                  <div className="registry-name">{stock.name}</div>
                </div>
              </div>
              <StatusPill tone={BACKING_TONE[stock.backing]}>
                {BACKING_LABEL[stock.backing]}
              </StatusPill>
            </header>

            <div className="registry-issuer">
              <span>{issuer.name}</span>
              <a
                href={issuer.disclosureUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Disclosure
                <Icon name="arrowRight" size={13} />
              </a>
            </div>

            <div className="registry-metrics crisp">
              <div className="registry-metric">
                <div className="registry-metric-label">Claim strength</div>
                <div className="registry-metric-value num">
                  {backing.score}/100
                </div>
                <SegBar
                  value={Math.round(backing.score / 10)}
                  max={10}
                  segments={10}
                  ariaLabel={`Claim strength ${backing.score} out of 100`}
                />
              </div>

              <div className="registry-metric">
                <div className="registry-metric-label">
                  vs. {stock.underlying}
                </div>
                <div
                  className="registry-metric-value num"
                  data-verdict={deviation.verdict.toLowerCase()}
                >
                  {deviation.bps > 0 ? "+" : ""}
                  {(deviation.bps / 100).toFixed(2)}%
                </div>
                <div className="registry-metric-sub">{deviation.verdict}</div>
              </div>

              <div className="registry-metric">
                <div className="registry-metric-label">Exit impact</div>
                <div className="registry-metric-value num">
                  {liquidity.bestVenue === null
                    ? "n/a"
                    : `${(liquidity.bestSellImpactBps / 100).toFixed(2)}%`}
                </div>
                <div
                  className="registry-metric-sub"
                  title={liquidity.bestVenue ?? undefined}
                >
                  {liquidity.verdict}
                  {liquidity.bestVenue ? ` · ${liquidity.bestVenue}` : ""}
                </div>
              </div>
            </div>

            <p className="registry-note">{deviation.note}</p>

            <footer className="registry-card-foot">
              <span className="registry-supply num">
                {usd(value)} circulating
                <span className="registry-coverage">
                  {" "}
                  · {(exitCoverageBps(stock) / 100).toFixed(1)}% pooled
                </span>
              </span>
              <div className="registry-card-actions">
                {stock.arclisSymbol && (
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => onOpenMarket(stock.arclisSymbol!)}
                  >
                    Perp market
                  </button>
                )}
                <button
                  className="btn btn-sm btn-primary"
                  aria-expanded={selected === stock.symbol}
                  onClick={() =>
                    setSelected(selected === stock.symbol ? null : stock.symbol)
                  }
                >
                  {selected === stock.symbol ? "Close" : "What do I own?"}
                </button>
              </div>
            </footer>
          </Card>
        ))}

        {rows.length === 0 && (
          <Card>
            <div className="empty">
              <h4>Nothing matches that</h4>
              <p>
                Try a company name, a ticker, or an issuer. The registry
                currently covers {stocks.length} tokens across{" "}
                {registry.issuers().length} issuers.
              </p>
            </div>
          </Card>
        )}
      </div>

      {detail && (
        <StockDetail
          stock={detail}
          now={now}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/**
 * The per-token answer.
 *
 * Ordered by what actually decides whether a holder is exposed: what the claim
 * is, who can exercise it, what the mint's authorities can do to their balance,
 * and how they would get out if the answer to the first three is bad. Price
 * comes last, because price is the thing they already know.
 */
function StockDetail({
  stock,
  now,
  onClose,
}: {
  stock: TokenizedStock;
  now: number;
  onClose: () => void;
}) {
  const issuer = issuerById(stock.issuerId)!;
  const backing = assessBacking(stock, issuer.attestation, issuer.regulator);
  const liquidity = assessLiquidity(stock.pools);
  const control = assessControl(stock);
  const deviation = assessDeviation(stock, now);

  return (
    <GlassPanel
      weight="lens"
      radius={28}
      className="registry-detail-shell"
      innerClassName="registry-detail"
      as="section"
    >
      <header className="registry-detail-head crisp">
        <div>
          <div className="registry-detail-eyebrow">WHAT YOU ACTUALLY OWN</div>
          <h2>
            {stock.symbol}{" "}
            <span className="registry-detail-underlying">
              references {stock.underlying}
            </span>
          </h2>
        </div>
        <button
          className="icon-btn"
          onClick={onClose}
          aria-label="Close details"
        >
          <Icon name="plus" size={18} />
        </button>
      </header>

      <div className="registry-detail-body crisp">
        <div className="registry-detail-col">
          <h4 className="registry-detail-h">The claim</h4>
          <dl className="registry-facts">
            <div>
              <dt>Legal structure</dt>
              <dd>{issuer.structure}</dd>
            </div>
            <div>
              <dt>Jurisdiction</dt>
              <dd>{issuer.jurisdiction}</dd>
            </div>
            <div>
              <dt>Regulator</dt>
              <dd>{issuer.regulator ?? "None stated"}</dd>
            </div>
            <div>
              <dt>Custodian</dt>
              <dd>{stock.custodian ?? "None named"}</dd>
            </div>
            <div>
              <dt>Who can redeem</dt>
              <dd>{REDEMPTION_LABEL[stock.redemption]}</dd>
            </div>
            <div>
              <dt>Independent attestation</dt>
              <dd>
                {ATTESTATION_LABEL[issuer.attestation]}
                {issuer.attestationUrl && (
                  <>
                    {" "}
                    <a
                      href={issuer.attestationUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      view
                    </a>
                  </>
                )}
              </dd>
            </div>
          </dl>

          <h4 className="registry-detail-h">How the score is built</h4>
          <ul className="registry-breakdown">
            {backing.components.map((c) => (
              <li key={c.label}>
                <div className="registry-breakdown-head">
                  <span>{c.label}</span>
                  <span className="num">
                    {c.points}/{c.max}
                  </span>
                </div>
                <SegBar
                  value={c.points}
                  max={c.max}
                  segments={Math.min(c.max, 10)}
                  ariaLabel={`${c.label}: ${c.points} of ${c.max}`}
                />
                <p>{c.detail}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="registry-detail-col">
          <h4 className="registry-detail-h">
            What the issuer can do to your balance
          </h4>
          <ul className="registry-control">
            {control.map((f) => (
              <li key={f.label} data-tone={f.tone}>
                <Icon name={f.tone === "watch" ? "alert" : "check"} size={16} />
                <div>
                  <strong>{f.label}</strong>
                  <p>{f.detail}</p>
                </div>
              </li>
            ))}
          </ul>

          <h4 className="registry-detail-h">Getting out</h4>
          <p className="registry-detail-note">{liquidity.note}</p>
          <table className="table registry-pools">
            <thead>
              <tr>
                <th scope="col">Venue</th>
                <th scope="col" className="ta-right">
                  Pooled
                </th>
                <th scope="col" className="ta-right">
                  Sell impact
                </th>
                <th scope="col" className="ta-right">
                  24h volume
                </th>
              </tr>
            </thead>
            <tbody>
              {stock.pools.map((p) => (
                <tr key={p.poolAddress}>
                  <th scope="row">{p.venue}</th>
                  <td className="ta-right num">{usd(p.quoteLiquidity)}</td>
                  <td className="ta-right num">
                    {(p.sellImpactBps / 100).toFixed(2)}%
                  </td>
                  <td className="ta-right num">{usd(p.volume24h)}</td>
                </tr>
              ))}
              {stock.pools.length === 0 && (
                <tr>
                  <td colSpan={4}>No DEX pool found for this token.</td>
                </tr>
              )}
            </tbody>
          </table>

          <h4 className="registry-detail-h">Corporate actions and income</h4>
          <dl className="registry-facts">
            <div>
              <dt>Dividends</dt>
              <dd>{stock.dividendTreatment}</dd>
            </div>
            <div>
              <dt>Splits and mergers</dt>
              <dd>{stock.corporateActionPolicy}</dd>
            </div>
          </dl>

          <h4 className="registry-detail-h">If the issuer disappears</h4>
          <p className="registry-detail-note">{stock.issuerRisk}</p>
        </div>
      </div>

      <footer className="registry-detail-foot crisp">
        <div className="registry-detail-price">
          <span className="registry-metric-label">On-chain</span>
          <span className="num">
            {usd(stock.onChainPrice, { compact: false })}
          </span>
        </div>
        <div className="registry-detail-price">
          <span className="registry-metric-label">
            {stock.underlying} reference ·{" "}
            {SESSION_LABEL[stock.referenceSession]}
          </span>
          <span className="num">
            {usd(stock.referencePrice, { compact: false })}
          </span>
        </div>
        <div className="registry-detail-price">
          <span className="registry-metric-label">Deviation</span>
          <span className="num" data-verdict={deviation.verdict.toLowerCase()}>
            {deviation.bps > 0 ? "+" : ""}
            {(deviation.bps / 100).toFixed(2)}%
          </span>
        </div>
        <a
          className="btn btn-sm btn-ghost"
          href={`https://solscan.io/token/${stock.mint.mint}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          Mint on Solscan
        </a>
      </footer>
    </GlassPanel>
  );
}
