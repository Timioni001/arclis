/**
 * "Open a treasury": the whole agent-treasury lifecycle from the browser.
 *
 * Until this existed a treasury could only be opened with
 * `npm run seed:treasury`, so the screen explained a product nobody visiting
 * could try. Three approvals take a connected wallet from nothing to a live,
 * hedged treasury:
 *
 *   1. Create the agent's token and the stock it raised.
 *   2. Open the treasury, set its policy and deposit the stock.
 *   3. Post margin and open the short.
 *
 * Progress is read back from the chain rather than remembered, so a reload,
 * a closed tab or a failed step resumes where the chain actually is. The only
 * thing kept in the browser is which two mints belong to the draft.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketView } from "../../lib/protocol/types";
import type { Session } from "../../lib/auth/session";
import { DATA_SOURCE } from "../../lib/config";
import { sessionOpensAt, shares as fmtShares, usd } from "../../lib/format";
import { Button, NumberField } from "../ui";
import { TxButton, actionContext } from "./TxButton";

const tx = () => import("../../lib/protocol/tx/actions");
const SCALE = 1_000_000;

/** The defaults `scripts/seed-treasury.ts` uses, for the same reasons. */
const HEDGE_RATIO_BPS = 9_000;
const TOLERANCE_BPS = 250;
const TOKENS_OUTSTANDING = 1_000_000n * BigInt(SCALE);

interface Draft {
  symbol: string;
  name: string;
  ticker: string;
  agentMint: string;
  stockMint: string;
  /** Stock base units at 1e6, as a string for JSON. */
  stockQty: string;
}

type Stage = "mints" | "open" | "hedge" | "done";

const draftKey = (address: string) => `arclis.treasuryDraft.${address}`;

function loadDraft(address: string | null): Draft | null {
  if (!address) return null;
  try {
    const raw = localStorage.getItem(draftKey(address));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

function saveDraft(address: string, draft: Draft | null) {
  try {
    if (draft) localStorage.setItem(draftKey(address), JSON.stringify(draft));
    else localStorage.removeItem(draftKey(address));
  } catch {
    /* private mode: the flow still works, it just cannot resume */
  }
}

const STEPS: { stage: Stage; title: string }[] = [
  { stage: "mints", title: "Create the agent token and its stock" },
  { stage: "open", title: "Open the treasury and deposit the stock" },
  { stage: "hedge", title: "Post margin and open the hedge" },
];

export function TreasuryWizard({
  markets,
  session,
  onSignIn,
  onDone,
}: {
  markets: MarketView[];
  session: Session;
  onSignIn?: () => void;
  onDone?: () => void;
}) {
  const address = session.address ?? null;
  const [draft, setDraft] = useState<Draft | null>(() => loadDraft(address));
  const [stage, setStage] = useState<Stage>("mints");
  const [probing, setProbing] = useState(false);
  // The session object is rebuilt on every render of the app; only its
  // address says whether the probe needs to run again.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const defaultSymbol =
    markets.find((m) => m.oracle.symbol === "SPY")?.oracle.symbol ??
    markets[0]?.oracle.symbol ??
    "";
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [name, setName] = useState("My Agent");
  const [ticker, setTicker] = useState("AGENT");
  const [stockUsd, setStockUsd] = useState("5000");
  const [margin, setMargin] = useState("1500");

  useEffect(() => setDraft(loadDraft(address)), [address]);
  useEffect(() => {
    if (!symbol && defaultSymbol) setSymbol(defaultSymbol);
  }, [symbol, defaultSymbol]);

  const activeSymbol = draft?.symbol ?? symbol;
  const view = markets.find((m) => m.oracle.symbol === activeSymbol);

  /*
   * Where the draft stands, read from the chain. Each step's account either
   * exists or it does not, which is a better record than anything this
   * component could remember across a reload.
   */
  const probe = useCallback(async () => {
    if (!draft || !address || DATA_SOURCE !== "rpc") {
      setStage("mints");
      return;
    }
    setProbing(true);
    try {
      const [{ PublicKey }, build, ctx] = await Promise.all([
        import("@solana/web3.js"),
        import("../../lib/protocol/tx/build"),
        actionContext(sessionRef.current, draft.symbol),
      ]);
      const agentMint = new PublicKey(draft.agentMint);
      const a = build.treasuryAddresses(ctx.programId, draft.symbol, agentMint);
      const [mint, treasury, position] =
        await ctx.connection.getMultipleAccountsInfo([
          agentMint,
          a.treasury,
          a.position,
        ]);
      setStage(
        !mint ? "mints" : !treasury ? "open" : !position ? "hedge" : "done",
      );
    } catch {
      /* leave the stage where it was; the next action re-probes */
    } finally {
      setProbing(false);
    }
  }, [draft, address]);

  useEffect(() => {
    void probe();
  }, [probe]);

  const price = view ? Number(view.oracle.price) / SCALE : 0;
  const stockQty = useMemo(() => {
    const dollars = Number(stockUsd) || 0;
    if (!price || dollars <= 0) return 0n;
    return BigInt(Math.floor((dollars / price) * SCALE));
  }, [stockUsd, price]);
  const marginUnits = BigInt(Math.round((Number(margin) || 0) * SCALE));

  const closed = view && view.oracle.session !== "Open";
  const hedgeBlocker = !view
    ? "That market is not available."
    : closed
      ? `The US market is ${view.oracle.session === "Halted" ? "halted" : "closed"}. The hedge can open ${view.oracle.nextOpenTs ? `from ${sessionOpensAt(view.oracle.nextOpenTs)}` : "when it reopens"}; your treasury is safe until then.`
      : marginUnits <= 0n
        ? "Enter a margin above zero."
        : null;

  const finish = () => {
    if (address) saveDraft(address, null);
    setDraft(null);
    setStage("mints");
  };

  if (markets.length === 0) return null;

  const current = STEPS.findIndex((s) => s.stage === stage);

  return (
    <section className="card card-lg wizard">
      <header className="card-head">
        <div>
          <h3 className="card-title">Open a treasury</h3>
          <div className="card-note">
            Three approvals from your wallet. On devnet the stock is a stand-in
            token for the real tokenized share.
          </div>
        </div>
        {draft && stage !== "done" && (
          <Button small onClick={finish}>
            Start over
          </Button>
        )}
      </header>

      <ol className="wizard-steps">
        {STEPS.map((s, i) => (
          <li
            key={s.stage}
            className={
              stage === "done" || i < current
                ? "is-done"
                : i === current
                  ? "is-current"
                  : ""
            }
          >
            <span className="guide-n">
              {stage === "done" || i < current ? "✓" : i + 1}
            </span>
            <span>{s.title}</span>
          </li>
        ))}
      </ol>

      {probing && <p className="metric-sub">Checking the chain…</p>}

      {!probing && stage === "mints" && (
        <div className="wizard-body">
          <div className="wizard-fields">
            <label className="field">
              <span className="field-label">Stock the agent raised in</span>
              <span className="input-wrap">
                <select
                  className="wizard-select"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                >
                  {markets.map((m) => (
                    <option key={m.oracle.symbol} value={m.oracle.symbol}>
                      {m.oracle.symbol} · {m.oracle.name}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className="field">
              <span className="field-label">Agent name</span>
              <span className="input-wrap">
                <input
                  type="text"
                  value={name}
                  maxLength={32}
                  onChange={(e) => setName(e.target.value)}
                />
              </span>
            </label>
            <label className="field">
              <span className="field-label">Agent token ticker</span>
              <span className="input-wrap">
                <input
                  type="text"
                  value={ticker}
                  maxLength={10}
                  onChange={(e) =>
                    setTicker(
                      e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                    )
                  }
                />
              </span>
            </label>
            <NumberField
              label="Stock value to hold"
              value={stockUsd}
              onChange={setStockUsd}
              suffix="USD"
              step="500"
            />
          </div>
          <p className="metric-sub">
            {stockQty > 0n && view
              ? `${fmtShares(stockQty, { dp: 2 })} ${view.oracle.symbol} at ${usd(view.oracle.price, { compact: false })}.`
              : "Enter an amount above zero."}
          </p>
          <TxButton
            variant="primary"
            symbol={symbol}
            session={session}
            onSignIn={onSignIn}
            blocker={
              !name.trim()
                ? "Give the agent a name."
                : !ticker
                  ? "Give the agent token a ticker."
                  : stockQty <= 0n
                    ? "Enter a stock value above zero."
                    : null
            }
            doneText="Tokens created."
            onDone={() => void probe()}
            action={async (ctx) => {
              const { Keypair } = await import("@solana/web3.js");
              const agentMint = Keypair.generate();
              const stockMint = Keypair.generate();
              const next: Draft = {
                symbol,
                name: name.trim(),
                ticker,
                agentMint: agentMint.publicKey.toBase58(),
                stockMint: stockMint.publicKey.toBase58(),
                stockQty: stockQty.toString(),
              };
              // Remembered before sending: if confirmation is slow and the
              // page reloads, the probe still finds the mints that landed.
              if (address) saveDraft(address, next);
              const result = await (
                await tx()
              ).createTreasuryMints(ctx, {
                agentMint,
                stockMint,
                agentName: next.name,
                agentTicker: next.ticker,
                stockQty,
              });
              setDraft(next);
              return result;
            }}
          >
            Create tokens
          </TxButton>
        </div>
      )}

      {!probing && stage === "open" && draft && (
        <div className="wizard-body">
          <dl className="wizard-summary">
            <div>
              <dt>Agent</dt>
              <dd>
                {draft.name} ({draft.ticker})
              </dd>
            </div>
            <div>
              <dt>Deposit</dt>
              <dd>
                {fmtShares(BigInt(draft.stockQty), { dp: 2 })} {draft.symbol}
              </dd>
            </div>
            <div>
              <dt>Hedge target</dt>
              <dd>90% short, rebalanced outside ±2.5%</dd>
            </div>
          </dl>
          <TxButton
            variant="primary"
            symbol={draft.symbol}
            session={session}
            onSignIn={onSignIn}
            doneText="Treasury opened."
            onDone={() => {
              void probe();
              onDone?.();
            }}
            action={async (ctx) => {
              const { PublicKey } = await import("@solana/web3.js");
              return (await tx()).openTreasury(ctx, {
                agentMint: new PublicKey(draft.agentMint),
                stockMint: new PublicKey(draft.stockMint),
                stockQty: BigInt(draft.stockQty),
                tokensOutstanding: TOKENS_OUTSTANDING,
                hedgeRatioBps: HEDGE_RATIO_BPS,
                toleranceBps: TOLERANCE_BPS,
              });
            }}
          >
            Open treasury
          </TxButton>
        </div>
      )}

      {!probing && stage === "hedge" && draft && (
        <div className="wizard-body">
          <div className="wizard-fields">
            <NumberField
              label="Margin behind the short"
              value={margin}
              onChange={setMargin}
              suffix="USDC"
              step="100"
            />
          </div>
          <p className="metric-sub">
            Paid from your test USDC. Short about{" "}
            {view
              ? usd(
                  (BigInt(draft.stockQty) * view.oracle.price * 9n) /
                    10n /
                    BigInt(SCALE),
                  { compact: false },
                )
              : "90% of the stock"}{" "}
            of {draft.symbol}. Need USDC? Open your account from the header.
          </p>
          <TxButton
            variant="primary"
            symbol={draft.symbol}
            session={session}
            onSignIn={onSignIn}
            blocker={hedgeBlocker}
            doneText="Hedge open."
            onDone={() => {
              void probe();
              onDone?.();
            }}
            action={async (ctx) => {
              const { PublicKey } = await import("@solana/web3.js");
              return (await tx()).fundAndHedge(
                ctx,
                new PublicKey(draft.agentMint),
                marginUnits,
              );
            }}
          >
            Post margin and hedge
          </TxButton>
        </div>
      )}

      {!probing && stage === "done" && draft && (
        <div className="wizard-body">
          <p>
            <b>{draft.name}</b> is live and hedged. Its card is below, with
            controls to rebalance, move margin and add stock. The Arclis keeper
            rebalances it every five minutes from now on.
          </p>
          <div>
            <Button small onClick={finish}>
              Open another treasury
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
