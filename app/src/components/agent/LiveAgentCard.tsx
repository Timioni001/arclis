/**
 * "Live on mainnet": the first Arclis agent, on the Overview.
 *
 * The treasury story is otherwise a devnet demo. This card is the part that
 * is real: an agent token launched through ClawPump, paired with tokenized
 * SPY, earning its creator fees in the stock. Every figure links to a public
 * page a visitor can check for themselves.
 */
import { LIVE_AGENT as A } from "../../lib/agent";
import { AddressDisplay } from "../ui/data";

export function LiveAgentCard({ onTreasuries }: { onTreasuries?: () => void }) {
  return (
    <section className="agent-card" aria-labelledby="agent-title">
      <div className="agent-card-glow" aria-hidden="true" />
      <div className="agent-card-main">
        <div className="agent-card-eyebrow">
          <span className="agent-live-dot" aria-hidden="true" />
          Live on Solana mainnet
        </div>
        <h2 className="agent-card-title" id="agent-title">
          {A.name} <span className="agent-ticker">${A.ticker}</span>
        </h2>
        <p className="agent-card-body">
          The first Arclis agent, launched through ClawPump. Its token trades
          against tokenized {A.pairedWith}, so its creator fees arrive in the
          stock, and an Arclis treasury keeps that income steady in dollars.
        </p>
        <div className="agent-card-actions">
          <a
            className="btn btn-primary btn-sm"
            href={A.pumpUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            View on Pump.fun
          </a>
          <a
            className="btn btn-sm"
            href={A.txUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Launch transaction
          </a>
          {onTreasuries && (
            <button className="btn btn-sm" onClick={onTreasuries}>
              How treasuries work
            </button>
          )}
        </div>
      </div>

      <dl className="agent-card-facts">
        <div>
          <dt>Paired with</dt>
          <dd>
            {A.pairedWith} <span className="agent-muted">{A.pairName}</span>
          </dd>
        </div>
        <div>
          <dt>Creator fee</dt>
          <dd>
            {A.creatorFeePct}% of volume{" "}
            <span className="agent-muted">paid in {A.pairedWith}</span>
          </dd>
        </div>
        <div>
          <dt>Launched with</dt>
          <dd>ClawPump partner API</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>
            <AddressDisplay
              address={A.mint}
              lead={6}
              tail={6}
              explorerHref={A.tokenUrl}
            />
          </dd>
        </div>
      </dl>
    </section>
  );
}
