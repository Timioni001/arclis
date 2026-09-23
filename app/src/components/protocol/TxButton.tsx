/**
 * A button that sends one transaction.
 *
 * The order ticket owns opening a position. Every other action a person can
 * take with their money (closing, providing liquidity, withdrawing it) is a
 * single transaction with the same preconditions, so they share this: a real
 * deployment, a session that can sign, simulation before the wallet opens, and
 * the outcome written under the button rather than lost in a console.
 */
import { useState } from "react";
import type { Connection } from "@solana/web3.js";
import { Button } from "../ui";
import type { Session } from "../../lib/auth/session";
import { canTrade } from "../../lib/auth/session";
import { DATA_SOURCE, PROGRAM_ID, QUOTE_MINT, RPC_URL } from "../../lib/config";
import type { ActionContext } from "../../lib/protocol/tx/actions";
import type { SendResult } from "../../lib/protocol/tx/send";

type Step =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done"; explorer: string }
  | { kind: "error"; message: string };

/*
 * web3.js is imported when a button is pressed, not when it is drawn. The
 * Liquidity screen is in the main bundle, and a static import here pulled the
 * whole Solana client into the first page load of every visitor.
 */
let sharedConnection: Connection | null = null;

export async function actionContext(
  session: Session,
  symbol: string,
): Promise<ActionContext> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  sharedConnection ??= new Connection(RPC_URL, "confirmed");
  return {
    connection: sharedConnection,
    session,
    programId: new PublicKey(PROGRAM_ID),
    quoteMint: new PublicKey(QUOTE_MINT),
    symbol,
  };
}

export function TxButton({
  children,
  symbol,
  session,
  action,
  onSignIn,
  onDone,
  blocker = null,
  variant,
  block = true,
  doneText = "Confirmed.",
}: {
  children: string;
  symbol: string;
  session: Session;
  action: (ctx: ActionContext) => Promise<SendResult>;
  onSignIn?: () => void;
  /** Re-read the chain so the result shows. */
  onDone?: () => void;
  /** Why the action is unavailable, or null when it is available. */
  blocker?: string | null;
  variant?: "primary";
  block?: boolean;
  doneText?: string;
}) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const live = DATA_SOURCE === "rpc";

  if (live && !session.address && onSignIn) {
    return (
      <Button block={block} variant={variant} onClick={onSignIn}>
        Sign in to continue
      </Button>
    );
  }

  const reason = !live
    ? "Demo data. This runs against the devnet deployment."
    : session.address && !canTrade(session)
      ? "This session is watch-only and cannot sign."
      : blocker;

  async function run() {
    setStep({ kind: "sending" });
    try {
      const result = await action(await actionContext(session, symbol));
      setStep({ kind: "done", explorer: result.explorer });
      onDone?.();
    } catch (e) {
      setStep({
        kind: "error",
        message:
          e instanceof Error
            ? e.message
            : "The transaction did not go through.",
      });
    }
  }

  const note =
    step.kind === "error" ? step.message : step.kind === "done" ? null : reason;

  return (
    <>
      <Button
        block={block}
        variant={variant}
        disabled={reason !== null || step.kind === "sending"}
        title={reason ?? undefined}
        onClick={run}
      >
        {step.kind === "sending" ? "Waiting for wallet…" : children}
      </Button>
      {step.kind === "done" && (
        <p className="metric-sub ticket-note" role="status">
          {doneText}{" "}
          <a href={step.explorer} target="_blank" rel="noreferrer noopener">
            View transaction
          </a>
        </p>
      )}
      {note && (
        <p className="metric-sub ticket-note" role="alert">
          {note}
        </p>
      )}
    </>
  );
}
