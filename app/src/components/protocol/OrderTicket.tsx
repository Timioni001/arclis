/**
 * The button that actually trades.
 *
 * The transaction layer in `lib/protocol/tx` was complete and tested, and
 * nothing in the interface called it: "Review trade" was a button with no
 * handler. This component is the connection, and it is deliberately the only
 * place in the interface that asks a wallet to sign an order.
 *
 * # The checks, in the order they run
 *
 *  1. Is this a real deployment? The modelled data source has no chain to send
 *     to, so it says so instead of pretending.
 *  2. Is someone signed in with a key that can sign? A watch-only session can
 *     read positions but must never be offered a signature it cannot make.
 *  3. Is there liquidity on the other side? Every trade settles against the
 *     market's LP pool, so an empty pool is a market that cannot fill.
 *  4. Does the wallet hold enough of the quote token? Read from the chain, not
 *     assumed, so the shortfall is a sentence before the wallet opens rather
 *     than a token-program error after.
 *  5. An explicit review step naming the side, size, collateral, fee and
 *     liquidation price, so the signature is for something the person has
 *     read.
 *  6. `sendInstructions` simulates against current chain state before asking
 *     for a signature, which is where a closed market or a breached margin
 *     check becomes a readable refusal and nothing is signed.
 *
 * No key ever passes through here. The wallet signs; this builds and asks.
 */
import { useEffect, useMemo, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Button, Row } from "../ui";
import type { Session } from "../../lib/auth/session";
import { canTrade } from "../../lib/auth/session";
import { DATA_SOURCE, PROGRAM_ID, QUOTE_MINT, RPC_URL } from "../../lib/config";
import { depositAndOpen } from "../../lib/protocol/tx/actions";
import { TransactionError } from "../../lib/protocol/tx/send";
import { usd } from "../../lib/format";
import { FaucetButton } from "./FaucetButton";

export interface OrderPreview {
  /** Signed base units: negative is a short. */
  size: bigint;
  collateral: bigint;
  fee: bigint;
  notional: bigint;
  liq: bigint | null;
  qty: number;
}

type Step =
  | { kind: "idle" }
  | { kind: "review" }
  | { kind: "sending" }
  | { kind: "done"; signature: string; explorer: string }
  | { kind: "error"; message: string };

let sharedConnection: Connection | null = null;
function connection(): Connection {
  sharedConnection ??= new Connection(RPC_URL, "confirmed");
  return sharedConnection;
}

export function OrderTicket({
  symbol,
  side,
  preview,
  poolLiquidity,
  session,
  onSignIn,
  onFilled,
  priceAgeSecs = 0,
}: {
  symbol: string;
  /**
   * Seconds since the oracle last published. The program refuses a new
   * position against a price over sixty seconds old; the interface reads the
   * chain every thirty, so it warns at ninety to avoid crying wolf.
   */
  priceAgeSecs?: number;
  side: "long" | "short";
  preview: OrderPreview;
  poolLiquidity: bigint;
  session: Session;
  onSignIn: () => void;
  /** Ask the data source to re-read, so the new position appears. */
  onFilled?: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [balance, setBalance] = useState<bigint | null>(null);
  // Lamports for fees. A wallet with none does not exist on chain, and every
  // transaction it signs fails simulation before any program runs.
  const [lamports, setLamports] = useState<number | null>(null);
  const [reads, setReads] = useState(0);

  const live = DATA_SOURCE === "rpc";
  const address = session.address;

  // The wallet's quote balance, read from its associated token account. A
  // missing account is a zero balance, not an error: it is simply a wallet
  // that has never held the token.
  useEffect(() => {
    if (!live || !address) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(QUOTE_MINT),
      new PublicKey(address),
      true,
    );
    connection()
      .getTokenAccountBalance(ata)
      .then((r) => !cancelled && setBalance(BigInt(r.value.amount)))
      .catch(() => !cancelled && setBalance(0n));
    connection()
      .getBalance(new PublicKey(address))
      .then((l) => !cancelled && setLamports(l))
      .catch(() => !cancelled && setLamports(null));
    return () => {
      cancelled = true;
    };
  }, [live, address, step.kind === "done", reads]);

  // Collateral plus the taker fee, which is charged against collateral. Posting
  // only the collateral would open the position a fee's width under the
  // margin the preview promised.
  const deposit = preview.collateral + preview.fee;

  const blocker = useMemo((): string | null => {
    if (!live) return "Demo data. Trading runs against the devnet deployment.";
    if (preview.size === 0n) return "Enter a size above zero.";
    if (priceAgeSecs > 90) {
      return `${symbol}'s price has not updated for ${Math.round(priceAgeSecs / 60) || 1} min, and the program only opens positions against a fresh one. It usually clears within a minute; if it does not, this market's price feed is down.`;
    }
    if (poolLiquidity === 0n) {
      return "No liquidity backs this market yet, so an order cannot fill.";
    }
    if (preview.notional > poolLiquidity) {
      return `This order is larger than the ${usd(poolLiquidity)} of liquidity backing ${symbol}.`;
    }
    if (
      address &&
      canTrade(session) &&
      lamports !== null &&
      lamports < 5_000_000
    ) {
      return "This wallet has no devnet SOL for the network fee. Get some below, or from faucet.solana.com.";
    }
    if (address && canTrade(session) && balance !== null && balance < deposit) {
      return `Needs ${usd(deposit, { compact: false })} of test USDC; this wallet holds ${usd(balance, { compact: false })}.`;
    }
    return null;
  }, [
    live,
    preview,
    priceAgeSecs,
    poolLiquidity,
    symbol,
    address,
    session,
    balance,
    deposit,
  ]);

  async function confirm() {
    setStep({ kind: "sending" });
    try {
      const result = await depositAndOpen(
        {
          connection: connection(),
          session,
          programId: new PublicKey(PROGRAM_ID),
          quoteMint: new PublicKey(QUOTE_MINT),
          symbol,
        },
        deposit,
        preview.size,
      );
      setStep({ kind: "done", ...result });
      onFilled?.();
    } catch (e) {
      setStep({
        kind: "error",
        message:
          e instanceof TransactionError || e instanceof Error
            ? e.message
            : "The transaction did not go through.",
      });
    }
  }

  if (!address) {
    return (
      <Button block variant="primary" onClick={onSignIn}>
        Sign in to trade
      </Button>
    );
  }

  if (!canTrade(session)) {
    return (
      <>
        <Button block disabled>
          Watch-only session
        </Button>
        <p className="metric-sub ticket-note">
          This account can view positions but cannot sign. Sign in with a wallet
          to trade.
        </p>
      </>
    );
  }

  if (step.kind === "done") {
    return (
      <div className="ticket-result" role="status">
        <strong>Order filled.</strong>{" "}
        <a href={step.explorer} target="_blank" rel="noreferrer noopener">
          View transaction
        </a>
        <Button block onClick={() => setStep({ kind: "idle" })}>
          New order
        </Button>
      </div>
    );
  }

  if (step.kind === "review" || step.kind === "sending") {
    return (
      <div className="ticket-review">
        <dl>
          <Row
            label="Order"
            value={`${side === "long" ? "Long" : "Short"} ${preview.qty} ${symbol}`}
          />
          <Row label="Deposit" value={usd(deposit, { compact: false })} />
          <Row
            label="Liquidation"
            value={preview.liq ? usd(preview.liq, { compact: false }) : "n/a"}
          />
        </dl>
        <p className="metric-sub ticket-note">
          Checked against the chain before your wallet is asked to sign. Devnet
          test tokens only.
        </p>
        <div className="ticket-actions">
          <Button
            onClick={() => setStep({ kind: "idle" })}
            disabled={step.kind === "sending"}
          >
            Back
          </Button>
          <Button
            variant="primary"
            onClick={confirm}
            disabled={step.kind === "sending"}
          >
            {step.kind === "sending"
              ? "Waiting for wallet…"
              : "Confirm and sign"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Button
        block
        variant="primary"
        disabled={blocker !== null}
        onClick={() => setStep({ kind: "review" })}
      >
        Review trade
      </Button>
      {(blocker || step.kind === "error") && (
        <p className="metric-sub ticket-note" role="alert">
          {step.kind === "error" ? step.message : blocker}
        </p>
      )}
      {balance !== null && !blocker && step.kind !== "error" && (
        <p className="metric-sub ticket-note">
          Wallet balance {usd(balance, { compact: false })} test USDC
        </p>
      )}
      {((balance !== null && balance < deposit) ||
        (lamports !== null && lamports < 5_000_000)) && (
        <FaucetButton
          address={address}
          onFunded={() => {
            // The mint confirms before the faucet answers; re-read now, and
            // once more shortly after in case the RPC node lags.
            setReads((n) => n + 1);
            setTimeout(() => setReads((n) => n + 1), 3000);
          }}
        />
      )}
    </>
  );
}
