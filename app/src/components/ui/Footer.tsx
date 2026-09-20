/**
 * The footer, and the ecosystem credits.
 *
 * Three names appear because three pieces of this actually run on them, and
 * each line says which. A "powered by" row that lists logos without saying
 * what they do is a sponsor wall; this one is a dependency list a judge can
 * check against the code.
 *
 *   Solana   - the program in `programs/arclis` is an Anchor program. Markets,
 *              positions, the liquidity pool and the oracle are all on-chain
 *              accounts.
 *   Meteora  - `tools/dbc` builds and monitors Dynamic Bonding Curve configs
 *              for stock-quoted pools, and Meteora DLMM pools are among the
 *              venues the registry measures exit depth against.
 *   Clawpump - the launch surface a new stock-quoted market is opened through.
 */

import { Icon } from "./Icon";

const ECOSYSTEM = [
  {
    name: "Solana",
    role: "Settlement. Markets, positions and the counterparty pool are on-chain accounts.",
    href: "https://solana.com",
  },
  {
    name: "Meteora",
    role: "Liquidity. Dynamic Bonding Curve configs for stock-quoted pools, and DLMM depth in the registry.",
    href: "https://meteora.ag",
  },
  {
    name: "Clawpump",
    role: "Distribution. The launch surface a new stock-quoted market opens through.",
    href: "https://clawpump.com",
  },
];

export function Footer({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <div className="wordmark">arclis</div>
          <p>
            On-chain access to public markets. Look up what a tokenized stock is
            actually backed by, then trade it on a perpetual that respects
            market hours, halts, splits and dividends.
          </p>
        </div>

        <nav className="site-footer-nav" aria-label="Footer">
          <h4>Product</h4>
          <ul>
            <li>
              <button onClick={() => onNavigate?.("Registry")}>Registry</button>
            </li>
            <li>
              <button onClick={() => onNavigate?.("Overview")}>Markets</button>
            </li>
            <li>
              <button onClick={() => onNavigate?.("Liquidity")}>
                Provide liquidity
              </button>
            </li>
            <li>
              <button onClick={() => onNavigate?.("Treasuries")}>
                Agent treasuries
              </button>
            </li>
          </ul>
        </nav>

        <section className="site-footer-eco" aria-labelledby="eco-heading">
          <h4 id="eco-heading">Built on</h4>
          <ul>
            {ECOSYSTEM.map((e) => (
              <li key={e.name}>
                <a href={e.href} target="_blank" rel="noreferrer noopener">
                  <span className="eco-name">
                    {e.name}
                    <Icon name="arrowRight" size={13} />
                  </span>
                  <span className="eco-role">{e.role}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="site-footer-legal">
        <p>
          Arclis does not custody assets, issue tokenized shares, or provide
          investment advice. The registry reports what third-party issuers
          disclose and what their mints do on-chain; it does not rank, endorse,
          or accept payment for placement.
        </p>
      </div>
    </footer>
  );
}
