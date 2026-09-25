/**
 * What a person can do with a treasury, under its card.
 *
 * Rebalancing is permissionless, so anyone signed in can bring any treasury
 * back to its target. Moving margin and adding stock need the treasury's
 * authority, and are offered only to it. A treasury that has never posted
 * margin gets the one action it is missing: open the hedge.
 */
import { useState } from "react";
import type { MarketView, Position, Treasury } from "../../lib/protocol/types";
import type { Session } from "../../lib/auth/session";
import { sessionOpensAt } from "../../lib/format";
import { NumberField, Segmented } from "../ui";
import { TxButton } from "./TxButton";

const tx = () => import("../../lib/protocol/tx/actions");
const SCALE = 1_000_000;

const OWNER_ACTIONS = ["Add margin", "Withdraw margin", "Add stock"] as const;
type OwnerAction = (typeof OWNER_ACTIONS)[number];

export function TreasuryControls({
  treasury: t,
  view,
  position,
  drift,
  session,
  onSignIn,
  onDone,
}: {
  treasury: Treasury;
  view: MarketView;
  position: Position | undefined;
  /** Net delta minus target, in share units at 1e6. */
  drift: bigint;
  session: Session;
  onSignIn?: () => void;
  onDone?: () => void;
}) {
  const [choice, setChoice] = useState<OwnerAction>("Add margin");
  const [amount, setAmount] = useState("500");
  const isOwner = session.address === t.authority;
  const symbol = view.oracle.symbol;

  const closed =
    view.oracle.session !== "Open"
      ? `The US market is ${view.oracle.session === "Halted" ? "halted" : "closed"}${
          view.oracle.nextOpenTs
            ? `; hedging resumes ${sessionOpensAt(view.oracle.nextOpenTs)}`
            : ""
        }.`
      : null;

  const band = (t.stockQty * BigInt(t.rebalanceToleranceBps)) / 10_000n;
  const within = (drift < 0n ? -drift : drift) <= band;
  const hasHedge = position !== undefined && position.collateral > 0n;

  const rebalanceBlocker = !t.hedgingEnabled
    ? "Hedging is switched off for this treasury."
    : !hasHedge
      ? "No margin is posted yet, so there is no hedge to resize."
      : (closed ??
        (within
          ? "Inside the tolerance band, so there is nothing to rebalance."
          : null));

  // Shares and USDC share the protocol's 1e6 scale.
  const units = BigInt(Math.round((Number(amount) || 0) * SCALE));
  const agent = async () =>
    new (await import("@solana/web3.js")).PublicKey(t.agentMint);

  return (
    <div className="treasury-controls">
      <div className="treasury-controls-row">
        <div>
          <span className="metric-label">Rebalance</span>
          <p className="metric-sub">
            Anyone can trigger it. The keeper does every five minutes.
          </p>
        </div>
        <div className="treasury-controls-btn">
          <TxButton
            symbol={symbol}
            session={session}
            onSignIn={onSignIn}
            onDone={onDone}
            blocker={rebalanceBlocker}
            doneText="Hedge rebalanced."
            action={async (ctx) =>
              (await tx()).rebalanceTreasury(ctx, await agent())
            }
          >
            Rebalance now
          </TxButton>
        </div>
      </div>

      {isOwner && !hasHedge && (
        <div className="treasury-controls-row">
          <div>
            <span className="metric-label">Open the hedge</span>
            <p className="metric-sub">
              Post margin from your test USDC and short the matching perp.
            </p>
            <NumberField
              label="Margin"
              value={amount}
              onChange={setAmount}
              suffix="USDC"
              step="100"
            />
          </div>
          <div className="treasury-controls-btn">
            <TxButton
              variant="primary"
              symbol={symbol}
              session={session}
              onSignIn={onSignIn}
              onDone={onDone}
              blocker={
                closed ?? (units <= 0n ? "Enter a margin above zero." : null)
              }
              doneText="Hedge open."
              action={async (ctx) =>
                (await tx()).fundAndHedge(ctx, await agent(), units)
              }
            >
              Post margin and hedge
            </TxButton>
          </div>
        </div>
      )}

      {isOwner && hasHedge && (
        <div className="treasury-controls-row">
          <div className="treasury-controls-form">
            <span className="metric-label">Manage your treasury</span>
            <Segmented
              label="Treasury action"
              options={OWNER_ACTIONS}
              value={choice}
              onChange={setChoice}
            />
            <NumberField
              label={choice === "Add stock" ? "Shares" : "Amount"}
              value={amount}
              onChange={setAmount}
              suffix={choice === "Add stock" ? symbol : "USDC"}
              step={choice === "Add stock" ? "1" : "100"}
            />
            <p className="metric-sub">
              {choice === "Add margin"
                ? "More margin makes the short safer from liquidation."
                : choice === "Withdraw margin"
                  ? "Returns USDC to your wallet, as long as the short keeps enough margin."
                  : "Mints more of the devnet stand-in stock and deposits it. Rebalance afterwards to grow the short."}
            </p>
          </div>
          <div className="treasury-controls-btn">
            <TxButton
              variant="primary"
              symbol={symbol}
              session={session}
              onSignIn={onSignIn}
              onDone={onDone}
              // Only withdrawing needs a live price: it raises the short's
              // leverage, so the program prices it strictly.
              blocker={
                units <= 0n
                  ? "Enter an amount above zero."
                  : choice === "Withdraw margin"
                    ? closed
                    : null
              }
              doneText="Done."
              action={async (ctx) => {
                const actions = await tx();
                const mint = await agent();
                if (choice === "Add margin")
                  return actions.addHedgeMargin(ctx, mint, units);
                if (choice === "Withdraw margin")
                  return actions.withdrawHedgeMargin(ctx, mint, units);
                const { PublicKey } = await import("@solana/web3.js");
                return actions.addTreasuryStock(
                  ctx,
                  mint,
                  new PublicKey(t.stockMint),
                  units,
                );
              }}
            >
              {choice}
            </TxButton>
          </div>
        </div>
      )}
    </div>
  );
}
