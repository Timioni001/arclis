/**
 * "How agent treasuries work": the guide at the top of the Treasuries screen.
 *
 * The screen showed treasuries and hedge dials with no explanation of where a
 * treasury comes from or how to read one. This is that explanation: the four
 * steps of the lifecycle, what each number on a treasury card means, and how
 * an agent or operator actually opens one. Collapsible, and the collapsed state
 * is remembered per browser so a returning visitor is not shown it again.
 */
import { useState } from "react";

const KEY = "arclis.treasuryGuide.closed";

function initiallyOpen(): boolean {
  try {
    return localStorage.getItem(KEY) !== "1";
  } catch {
    return true;
  }
}

const STEPS = [
  {
    title: "Launch",
    body: "The agent launches its token through ClawPump, priced in a tokenized stock such as SPY instead of SOL. Its creator fees now arrive in that stock.",
  },
  {
    title: "Deposit",
    body: "The agent moves the stock into its Arclis treasury, an on-chain account only the program controls.",
  },
  {
    title: "Hedge",
    body: "The treasury posts margin and shorts the matching perpetual. When the stock rises the short loses about the same, and when it falls the short gains, so the treasury's dollar value holds.",
  },
  {
    title: "Rebalance",
    body: "As the holding changes, the short is resized to match. Anyone can trigger it, and the Arclis keeper does every five minutes, so the hedge never depends on the agent staying online.",
  },
];

const READING = [
  ["Stock holdings", "The tokenized shares in the treasury, and their dollar value."],
  ["Perp position", "The short on the matching perpetual that offsets the stock."],
  ["Net delta", "How much price exposure is left after the hedge. Near zero means the budget no longer moves with the stock."],
  ["Drift from target", "How far the hedge is from where it should be. The dial shows WITHIN TOLERANCE, or REBALANCE DUE once it leaves the band."],
  ["Hedged NAV vs If unhedged", "What the treasury is worth with the hedge, beside what it would be worth holding the stock alone."],
  ["Funding carry", "What holding the short costs or earns over time."],
];

export function TreasuryGuide() {
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <details
      className="guide"
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(now);
        try {
          localStorage.setItem(KEY, now ? "0" : "1");
        } catch {
          /* private mode: the guide simply opens again next time */
        }
      }}
    >
      <summary>
        <span className="guide-title">How agent treasuries work</span>
        <span className="guide-toggle">{open ? "Hide" : "Show guide"}</span>
      </summary>

      <div className="guide-body">
        <p className="guide-lede">
          An AI agent paid in a stock has a budget that moves with the stock
          market. A treasury holds the stock and shorts the matching perpetual,
          so the budget keeps its dollar value while the agent keeps earning.
        </p>

        <ol className="guide-steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="guide-n">{i + 1}</span>
              <div>
                <b>{s.title}</b>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="guide-example">
          <b>Example.</b> An agent holds $10,000 of SPY. SPY rises 10%: the
          stock gains $1,000 and the short loses about $1,000. SPY falls 10%:
          the stock loses $1,000 and the short gains about $1,000. Either way
          the treasury stays near $10,000.
        </div>

        <h3 className="guide-h">Reading a treasury</h3>
        <dl className="guide-terms">
          {READING.map(([term, def]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{def}</dd>
            </div>
          ))}
        </dl>

        <h3 className="guide-h">Opening one</h3>
        <p className="guide-note">
          <b>Agents:</b> launch against one of the stocks marked{" "}
          <em>Hedgeable</em> below, then deposit the stock into a treasury.
          <br />
          <b>Operators:</b> <code>npm run seed:treasury -- --url &lt;rpc&gt;</code>{" "}
          opens a complete devnet treasury: agent mint, stock deposit, hedge
          margin and the first rebalance.
        </p>
        <p className="guide-note guide-muted">
          ClawPump launches run on Solana mainnet; the treasury program is on
          devnet for now, so the two are not yet linked end to end.
        </p>
      </div>
    </details>
  );
}
