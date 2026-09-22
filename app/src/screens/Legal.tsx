/**
 * Terms of service and privacy policy.
 *
 * # Why these are real documents rather than placeholders
 *
 * Arclis asks people to connect a wallet and sign transactions. A site that
 * does that with no terms and no privacy policy is either hiding something or
 * has not thought about it, and a reader cannot tell which. Both documents
 * below describe what this software actually does, which is a short list,
 * because the architecture keeps it short: no custody, no accounts, no server
 * holding anything.
 *
 * # What is deliberately absent
 *
 * No arbitration clause, no class-action waiver, no jurisdiction selection,
 * and no limitation of liability dressed up as boilerplate. Those come from a
 * lawyer who knows where the operator is incorporated, and inventing them here
 * would produce something that reads legally binding while being nothing of
 * the sort. What is here instead is an honest description of the risks and of
 * what the software does with data, which is the part the reader actually
 * needs and the part this code can speak to truthfully.
 *
 * The date is a build-time constant rather than `new Date()`: a policy whose
 * "last updated" moves every time someone loads the page tells the reader
 * nothing.
 */

import { Card, Notice } from "../components/ui";

/** Bumped by hand when the text below changes, which is the point. */
const UPDATED = "22 September 2026";

export type LegalDoc = "Terms" | "Privacy";

export function Legal({
  doc,
  onNavigate,
}: {
  doc: LegalDoc;
  onNavigate?: (tab: string) => void;
}) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">
            {doc === "Terms" ? "Terms of service" : "Privacy policy"}
          </h1>
          <p className="page-sub">Last updated {UPDATED}.</p>
        </div>
      </header>

      <div className="legal-switch" role="tablist" aria-label="Legal documents">
        <button
          role="tab"
          aria-selected={doc === "Terms"}
          className={doc === "Terms" ? "is-active" : undefined}
          onClick={() => onNavigate?.("Terms")}
        >
          Terms of service
        </button>
        <button
          role="tab"
          aria-selected={doc === "Privacy"}
          className={doc === "Privacy" ? "is-active" : undefined}
          onClick={() => onNavigate?.("Privacy")}
        >
          Privacy policy
        </button>
      </div>

      {doc === "Terms" ? <Terms /> : <Privacy />}
    </div>
  );
}

function Terms() {
  return (
    <Card large>
      <div className="legal-prose">
        <Notice
          tone="warning"
          title="This is pre-release software on a test network"
        >
          Arclis runs against Solana devnet. Devnet tokens have no monetary
          value, devnet state can be reset by its operators without notice, and
          nothing here should be treated as a live financial venue. Read the
          risks below before connecting anything.
        </Notice>

        <h2>1. What Arclis is</h2>
        <p>
          Arclis is an interface to a set of on-chain programs that quote
          perpetual futures against oracle prices for publicly traded equities.
          The programs run on Solana. This website reads their state and helps
          you build transactions to send to them. It is a way of looking at and
          talking to a public program, not a broker, an exchange, a custodian,
          or a counterparty to any trade you make.
        </p>

        <h2>2. We never hold your assets or your keys</h2>
        <p>
          Arclis has no ability to move your funds. It cannot sign on your
          behalf, it never receives your private key or seed phrase, and no
          part of this site asks for either. Every transaction is built in your
          browser and signed by a wallet you control. If you lose access to
          that wallet, nobody at Arclis can restore it, reverse a transaction,
          or recover a position.
        </p>
        <p>
          Collateral you deposit sits in program-owned vaults on Solana,
          governed by the program&apos;s code rather than by any promise made
          here. The program&apos;s source is in the repository this site is
          built from.
        </p>

        <h2>3. The risks, stated plainly</h2>
        <ul>
          <li>
            <strong>You can lose everything you deposit.</strong> These are
            leveraged instruments. A move against your position that exhausts
            your margin closes it and takes the collateral with it.
          </li>
          <li>
            <strong>Liquidation is automatic and permissionless.</strong> Any
            party may liquidate an under-margined position, and they are paid to
            do so. There is no grace period, no margin call, and no human
            reviewing the decision.
          </li>
          <li>
            <strong>Prices come from an oracle, and oracles fail.</strong> The
            mark price is published by a keeper reading an off-chain data feed.
            A stale, wrong, or manipulated price can liquidate a position that
            a correct price would have left alone. The program refuses prices
            beyond a staleness and deviation bound, which reduces this risk
            without removing it.
          </li>
          <li>
            <strong>Markets close and the interface honours that.</strong>
            Trading that increases risk is refused outside the underlying
            venue&apos;s hours, and during halts. A position opened before a
            close is still exposed to whatever the price does before it opens
            again.
          </li>
          <li>
            <strong>Smart contracts can have bugs.</strong> This program has
            not been audited by a third party. It has tests, and tests are not
            an audit.
          </li>
          <li>
            <strong>Liquidity providers take the other side.</strong> Depositing
            into the liquidity pool means absorbing trader profit and loss. The
            pool can lose money.
          </li>
        </ul>

        <h2>4. Tokenized stocks are issued by other people</h2>
        <p>
          Arclis does not issue tokenized shares and has no relationship with
          the companies whose prices it quotes. The registry reports what
          third-party issuers publish about their own products and what their
          mints do on-chain. It is a description of what those issuers say and
          do, not a verification of it, and not a recommendation. Whether a
          given tokenized share is actually backed is a question for its
          issuer.
        </p>

        <h2>5. Nothing here is advice</h2>
        <p>
          Nothing on this site is investment, legal, tax, or financial advice,
          or an offer or solicitation to buy or sell anything. No content here
          accounts for your circumstances.
        </p>

        <h2>6. Eligibility and your own law</h2>
        <p>
          Derivatives on equities are regulated differently in every
          jurisdiction, and in many of them they are restricted to particular
          categories of participant or prohibited outright. Whether you may
          lawfully use software like this is your responsibility to determine
          before you do. Do not use Arclis where doing so would break the law
          that applies to you.
        </p>

        <h2>7. No warranty</h2>
        <p>
          Arclis is provided as is, without warranty of any kind. The interface
          may be unavailable, may display stale data when a network read fails,
          and may contain errors. Availability of the underlying programs
          depends on Solana, on RPC providers, and on keepers, none of which
          are guaranteed.
        </p>

        <h2>8. Changes</h2>
        <p>
          These terms change when the software does. The date at the top of
          this page moves when the text does, and both are in the repository&apos;s
          history, so you can see exactly what changed and when.
        </p>
      </div>
    </Card>
  );
}

function Privacy() {
  return (
    <Card large>
      <div className="legal-prose">
        <Notice tone="info" title="The short version">
          Arclis has no user accounts and no backend that stores anything about
          you. It does not set analytics cookies, and it does not sell or share
          personal data, because it does not collect any to sell.
        </Notice>

        <h2>What Arclis does not collect</h2>
        <p>
          There is no sign-up, no email address, no password, and no profile.
          The site does not run third-party analytics, advertising, or session
          replay. There is no server-side log tying you to what you looked at,
          because there is no application server between you and the chain.
        </p>

        <h2>What stays in your browser</h2>
        <p>
          Signing in creates a session that lives in your browser&apos;s local
          storage and nowhere else. It holds the public address of the account
          you connected and, if you used a passkey, an identifier for that
          credential. The passkey&apos;s private key never leaves your device;
          that is what a passkey is. Signing out deletes the session, and
          clearing site data has the same effect.
        </p>
        <p>
          Two other small preferences are stored the same way: whether you chose
          light or dark mode, and whether you asked for reduced visual effects.
          Neither identifies you, and neither leaves your device.
        </p>

        <h2>What is public because it is on a blockchain</h2>
        <p>
          A wallet address, its balances, and every transaction it has ever sent
          are public information on Solana, readable by anyone, permanently, and
          not because of anything Arclis does. Connecting a wallet here does not
          publish anything that was not already public, but it does mean that
          anyone who learns your address can see your activity. If that matters
          to you, use an address you are willing to have seen.
        </p>

        <h2>Who your browser talks to</h2>
        <p>
          Loading this page contacts the host serving it and a Solana RPC
          endpoint, which receives your IP address the way any web request does
          and can see which accounts are being read. Those providers have their
          own policies, which Arclis does not control. Fonts are served from the
          same host as the site rather than from a third party, so loading a
          page does not tell a font provider you were here.
        </p>
        <p>
          The optional assistant on the registry, where it is enabled, sends
          the messages you type to Anthropic&apos;s API by way of this
          site&apos;s own server, so that the API key is never exposed to your
          browser. Your browser sends that conversation and nothing else: the
          registry data the assistant reasons over is fetched by the server,
          not taken from your session. If you do not use the assistant, nothing
          is sent.
        </p>

        <h2>Children</h2>
        <p>
          Arclis is not directed at anyone under 18 and should not be used by
          them.
        </p>

        <h2>Questions</h2>
        <p>
          This policy describes software whose source is public. If the
          description and the code ever disagree, the code is the truth and the
          discrepancy is a bug worth reporting.
        </p>
      </div>
    </Card>
  );
}
