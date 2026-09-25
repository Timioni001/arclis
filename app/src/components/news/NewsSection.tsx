/**
 * "Today's news" on the Overview: stocks and Solana.
 *
 * A running ticker of every headline across the top, then the selected
 * section as a lead story and a column of the rest. Cards rise in one after
 * another when the section loads or the tab changes; the ticker pauses under
 * the pointer. Everything that moves stops for people who ask for reduced
 * motion.
 *
 * Renders nothing until the keeper has headlines, so a demo build or a keeper
 * without a news key shows no empty frame.
 */
import { useState } from "react";
import type { Headline, NewsFeed } from "../../lib/news";

/** Minutes, hours or days: seconds are noise on a headline. */
function since(ts: number, now: number): string {
  const s = Math.max(0, now - ts);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

type Section = "stocks" | "solana";

export function NewsSection({ feed }: { feed: NewsFeed | null }) {
  const [section, setSection] = useState<Section>("stocks");
  if (!feed) return null;
  const now = Date.now() / 1000;

  const items = feed[section].length ? feed[section] : feed.stocks;
  const [lead, ...rest] = items;
  const ticker = [...feed.stocks.slice(0, 6), ...feed.solana.slice(0, 6)];

  return (
    <section aria-labelledby="news-title" className="news">
      <div className="section-head">
        <h2 className="section-title" id="news-title">
          <span className="news-live" aria-hidden="true" />
          Today&apos;s news
        </h2>
        <div className="registry-filter-group" role="tablist" aria-label="News">
          {(
            [
              ["stocks", "Stocks"],
              ["solana", "Solana"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              className="registry-filter"
              aria-selected={section === key}
              aria-pressed={section === key}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {ticker.length > 0 && (
        <div className="news-ticker" aria-label="Latest headlines">
          {/* Two copies back to back, so the loop has no seam. */}
          <div className="news-ticker-track">
            {[0, 1].map((copy) => (
              <div
                className="news-ticker-run"
                key={copy}
                aria-hidden={copy === 1}
              >
                {ticker.map((h) => (
                  <a
                    key={`${copy}-${h.id}`}
                    href={h.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    tabIndex={copy === 1 ? -1 : undefined}
                    className="news-ticker-item"
                  >
                    <span
                      className={
                        h.solana ? "news-dot news-dot-sol" : "news-dot"
                      }
                    />
                    <b>{h.source}</b>
                    {h.headline}
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {lead && (
        <div className="news-grid" key={section}>
          <a
            className="news-lead news-rise"
            href={lead.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            <NewsImage item={lead} />
            <div className="news-lead-body">
              <NewsMeta item={lead} now={now} />
              <h3>{lead.headline}</h3>
              {lead.summary && <p>{lead.summary}</p>}
            </div>
          </a>
          <ol className="news-list">
            {rest.slice(0, 5).map((h, i) => (
              <li
                key={h.id}
                className="news-rise"
                style={{ animationDelay: `${(i + 1) * 70}ms` }}
              >
                <a href={h.url} target="_blank" rel="noreferrer noopener">
                  <NewsImage item={h} small />
                  <div>
                    <NewsMeta item={h} now={now} />
                    <h4>{h.headline}</h4>
                  </div>
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="news-credit">
        Headlines from Finnhub, refreshed every fifteen minutes. Links open the
        publisher&apos;s site.
      </p>
    </section>
  );
}

function NewsMeta({ item, now }: { item: Headline; now: number }) {
  return (
    <div className="news-meta">
      {item.solana && <span className="news-tag">Solana</span>}
      <span>{item.source}</span>
      <span aria-hidden="true">·</span>
      <span>{since(item.datetime, now)}</span>
    </div>
  );
}

/** The story's image, or its source's initial on a tinted block. */
function NewsImage({
  item,
  small = false,
}: {
  item: Headline;
  small?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const cls = small ? "news-thumb" : "news-image";
  if (!item.image || broken) {
    return (
      <div className={`${cls} news-image-fallback`} aria-hidden="true">
        {(item.source || "N").slice(0, 1).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      className={cls}
      src={item.image}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}
