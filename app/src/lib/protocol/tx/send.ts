/**
 * Signing and sending, and saying something useful when it fails.
 *
 * Two signer kinds reach this file and they sign at different levels:
 *
 *   - A **wallet** signs a whole transaction. It owns the UX (its own approval
 *     popup), and some wallets prefer to broadcast themselves, so both
 *     `signAndSendTransaction` and `signTransaction` are supported and the
 *     wallet's preference wins.
 *   - A **passkey account** signs raw bytes. A Solana signature is ed25519 over
 *     the serialized message, which is exactly what `crypto.subtle.sign`
 *     produces, so the signature is attached to the transaction directly.
 *
 * Both paths simulate first. A simulation costs one RPC round trip and turns
 * "custom program error: 0x1773" into "the market is closed, so new positions
 * would be a free bet on the next open" before the user has approved anything.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type SendOptions,
} from "@solana/web3.js";
import { errorMessage, errorName } from "../rpc/decode";
import type { Session } from "../../auth/session";
import { connectedWallet } from "../../auth/wallet";
import { encodeBase58 } from "../../auth/base58";

export interface SendResult {
  signature: string;
  /** The explorer URL, ready to link. */
  explorer: string;
}

/**
 * A failure a person can act on.
 *
 * `code` and `name` are present when the program itself rejected, which is the
 * common case and the one worth explaining. Everything else (a dropped
 * connection, a rejected approval) carries only `message`.
 */
export class TransactionError extends Error {
  readonly code: number | null;
  readonly name: string;
  readonly logs: string[];

  constructor(
    message: string,
    opts: { code?: number | null; name?: string; logs?: string[] } = {},
  ) {
    super(message);
    this.code = opts.code ?? null;
    this.name = opts.name ?? "TransactionError";
    this.logs = opts.logs ?? [];
  }
}

/** Anchor error codes arrive as `custom program error: 0x1770` in the logs. */
function decodeProgramError(
  err: unknown,
  logs: string[],
): { code: number; name: string; message: string } | null {
  const haystack = `${JSON.stringify(err ?? "")} ${logs.join(" ")}`;

  const hex = haystack.match(/custom program error: 0x([0-9a-fA-F]+)/);
  // Some RPCs return the structured form with no log line to match.
  const structured = haystack.match(/"Custom":(\d+)/);
  if (hex || structured) {
    const code = hex ? parseInt(hex[1], 16) : Number(structured![1]);
    return {
      code,
      name: errorName(code) ?? "UnknownProgramError",
      message:
        errorMessage(code) ?? `The program rejected this (code ${code}).`,
    };
  }

  // Anchor also logs the name directly, which survives when the numeric form
  // does not (for instance through some wallet error wrappers).
  const named = logs.find((l) => l.includes("AnchorError"));
  const name = named?.match(/Error Code: (\w+)/)?.[1];
  if (name) {
    const msg = named.match(/Error Message: (.+?)\.?$/)?.[1];
    return { code: -1, name, message: msg ?? name };
  }

  // Not a program error: a system or token-program failure. Name the common
  // ones, and otherwise show what the RPC said, because "would fail" on its
  // own sends people to a support channel with nothing to report.
  const text = haystack.toLowerCase();
  const known: [RegExp, string][] = [
    [/insufficient lamports|insufficient funds for (rent|fee)/, "Your wallet has no devnet SOL to pay the network fee. Get some from the account panel or faucet.solana.com."],
    [/insufficient funds/, "Your wallet does not hold enough test USDC for this deposit."],
    // A fee payer with zero SOL does not exist on chain, so simulation reports
    // AccountNotFound before any program runs. It is by far the commonest cause.
    [/accountnotfound|could not find account/, "Your wallet has no devnet SOL to pay the network fee. Open your account (the address button, top right) to get some, or use faucet.solana.com."],
    [/blockhashnotfound|blockhash not found/, "The network moved on before the check finished. Try again."],
  ];
  for (const [re, message] of known) {
    if (re.test(text)) return { code: -1, name: "SystemError", message };
  }
  const tail = logs.filter((l) => /program log|error/i.test(l)).slice(-2).join(" ");
  const detail = tail || (typeof err === "string" ? err : JSON.stringify(err));
  return detail
    ? { code: -1, name: "SimulationFailed", message: `This transaction would fail: ${detail.slice(0, 220)}` }
    : null;
}

export interface SendContext {
  connection: Connection;
  session: Session;
  /** Skip the pre-flight simulation. Only for a caller that already ran one. */
  skipSimulation?: boolean;
  sendOptions?: SendOptions;
}

/**
 * Build, sign, send and confirm.
 *
 * Returns the signature. Throws `TransactionError` with a human-readable
 * message on any failure, including a simulation that fails before anything is
 * signed, which is the failure worth having.
 */
export async function sendInstructions(
  ctx: SendContext,
  instructions: TransactionInstruction[],
): Promise<SendResult> {
  const { connection, session } = ctx;
  if (!session.address) {
    throw new TransactionError("Sign in before sending a transaction.");
  }
  const payer = new PublicKey(session.address);

  const tx = new Transaction();
  tx.add(...instructions);
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer;

  if (!ctx.skipSimulation) {
    await simulate(connection, tx);
  }

  const signed = await signOnly(ctx, tx);
  let signature: string;
  let confirmation: { value: { err: unknown } };
  if (signed) {
    signature = encodeBase58(signed.subarray(1, 65));
    confirmation = await broadcastUntilConfirmed(
      connection,
      signed,
      signature,
      lastValidBlockHeight,
    );
  } else {
    signature = await signAndSend(ctx, tx);
    confirmation = await connection
      .confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed")
      .catch(async (e) => {
        // Expiry is not proof of failure: check before saying so.
        const st = (await connection.getSignatureStatuses([signature])).value[0];
        if (st && !st.err && st.confirmationStatus) return { value: { err: null } };
        throw expired(e);
      });
  }
  if (confirmation.value.err) {
    const logs = await fetchLogs(connection, signature);
    const decoded = decodeProgramError(confirmation.value.err, logs);
    throw new TransactionError(
      decoded?.message ?? "The transaction was rejected on-chain.",
      { code: decoded?.code, name: decoded?.name, logs },
    );
  }

  return { signature, explorer: explorerFor(connection, signature) };
}

/**
 * Run the transaction against the current chain state without signing it.
 *
 * This is where a closed market, an insufficient balance or a breached margin
 * check becomes a sentence instead of a hex code, and it happens before the
 * user is asked to approve anything.
 */
export async function simulate(
  connection: Connection,
  tx: Transaction,
): Promise<string[]> {
  const result = await connection.simulateTransaction(tx);
  const logs = result.value.logs ?? [];
  if (result.value.err) {
    const decoded = decodeProgramError(result.value.err, logs);
    throw new TransactionError(
      decoded?.message ?? "This transaction would fail. Nothing was sent.",
      { code: decoded?.code, name: decoded?.name, logs },
    );
  }
  return logs;
}

/**
 * Sign without broadcasting. Wallets that support it return signed bytes and
 * the app sends them to its own cluster; passkey accounts always do.
 */
async function signOnly(ctx: SendContext, tx: Transaction): Promise<Uint8Array | null> {
  const { session } = ctx;
  if (session.method === "wallet") {
    const wallet = connectedWallet();
    if (!wallet) {
      throw new TransactionError(
        "The wallet connection was lost. Reconnect and try again.",
      );
    }
    return wallet.signOnly(tx);
  }
  if (session.method === "passkey" && session.sign) {
    const signature = await session.sign(new Uint8Array(tx.serializeMessage()));
    tx.addSignature(new PublicKey(session.address!), Buffer.from(signature));
    if (!tx.verifySignatures()) {
      throw new TransactionError(
        "The signature did not verify. This is a bug, not a rejected approval.",
      );
    }
    return new Uint8Array(tx.serialize());
  }
  return null;
}

/**
 * Send the signed bytes, and keep re-sending every two seconds until the
 * cluster confirms or the blockhash expires. Public devnet drops transactions
 * under load; a single send and a long wait is what produced "block height
 * exceeded" on a transaction that would have landed on a second try.
 */
export async function broadcastUntilConfirmed(
  connection: Connection,
  raw: Uint8Array,
  signature: string,
  lastValidBlockHeight: number,
): Promise<{ value: { err: unknown } }> {
  const send = () =>
    connection
      .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
      .catch(() => undefined);
  await send();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) return { value: { err: status.err } };
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return { value: { err: null } };
    }
    const height = await connection.getBlockHeight("confirmed").catch(() => 0);
    if (height > lastValidBlockHeight) {
      const last = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (last && !last.err) return { value: { err: null } };
      throw expired();
    }
    await send();
  }
}

function expired(cause?: unknown): TransactionError {
  void cause;
  return new TransactionError(
    "The network did not confirm this in time, so nothing happened and nothing was charged. Try again.",
  );
}

async function signAndSend(ctx: SendContext, tx: Transaction): Promise<string> {
  const { connection, session } = ctx;

  if (session.method === "wallet") {
    const wallet = connectedWallet();
    if (!wallet) {
      throw new TransactionError(
        "The wallet connection was lost. Reconnect and try again.",
      );
    }
    return wallet.signAndSend(tx, connection, ctx.sendOptions);
  }

  if (session.method === "passkey") {
    if (!session.sign) {
      throw new TransactionError(
        "Unlock your account with your passkey before sending a transaction.",
      );
    }
    // A Solana signature is ed25519 over the serialized message, which is what
    // the passkey-unwrapped key produces. Nothing here needs the private key
    // itself, and it is non-extractable anyway.
    const message = tx.serializeMessage();
    const signature = await session.sign(new Uint8Array(message));
    tx.addSignature(new PublicKey(session.address!), Buffer.from(signature));

    if (!tx.verifySignatures()) {
      throw new TransactionError(
        "The signature did not verify. This is a bug, not a rejected approval.",
      );
    }
    return connection.sendRawTransaction(tx.serialize(), ctx.sendOptions);
  }

  throw new TransactionError("Sign in before sending a transaction.");
}

async function fetchLogs(
  connection: Connection,
  signature: string,
): Promise<string[]> {
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    return tx?.meta?.logMessages ?? [];
  } catch {
    // Logs are a nicety; failing to fetch them must not replace the real error.
    return [];
  }
}

function explorerFor(connection: Connection, signature: string): string {
  const endpoint = connection.rpcEndpoint;
  const cluster = endpoint.includes("devnet")
    ? "?cluster=devnet"
    : endpoint.includes("testnet")
      ? "?cluster=testnet"
      : endpoint.includes("127.0.0.1") || endpoint.includes("localhost")
        ? "?cluster=custom"
        : "";
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}

export { decodeProgramError };
