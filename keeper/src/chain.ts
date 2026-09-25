/**
 * Shared chain plumbing for the daemons.
 *
 * The keeper, the funding crank and the liquidator all need the same four
 * things: a connection, a signing keypair, a way to send a transaction that
 * survives a dropped blockhash, and the ability to turn a program error code
 * back into a name. Doing it once means a retry policy that is actually
 * consistent across all three rather than three slightly different guesses.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import idl from "../../idl/arclis.json";

export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);

export interface ChainConfig {
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;
  /** Log a line. Injected so tests can capture it and a service can ship it. */
  log: (
    level: "info" | "warn" | "error",
    message: string,
    extra?: unknown,
  ) => void;
}

/** Load a keypair from a Solana CLI JSON file, or from a base64 env var. */
export function loadKeypair(source: string): Keypair {
  const trimmed = source.trim();

  // A path, the usual case.
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith(".") ||
    trimmed.endsWith(".json")
  ) {
    const bytes = JSON.parse(readFileSync(trimmed, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }

  // A JSON array pasted into an env var.
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(trimmed) as number[]),
    );
  }

  // Base64, for the secret managers that only take a string.
  return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(trimmed, "base64")));
}

export function consoleLogger(service: string): ChainConfig["log"] {
  return (level, message, extra) => {
    // One line per event, with the service and a timestamp, so several daemons
    // sharing a log stream stay readable and greppable.
    const line = `${new Date().toISOString()} [${service}] ${level.toUpperCase()} ${message}`;
    const payload = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
    if (level === "error") console.error(line + payload);
    else if (level === "warn") console.warn(line + payload);
    else console.log(line + payload);
  };
}

/** Resolve an Anchor error code to the name in the IDL. */
export function errorName(code: number): string | null {
  const errors = (idl as { errors?: Array<{ code: number; name: string }> })
    .errors;
  return errors?.find((e) => e.code === code)?.name ?? null;
}

/**
 * Pull a program error name out of whatever the RPC threw.
 *
 * Returns null for anything that is not a program rejection, which is the
 * distinction the callers act on: a program error is usually expected and
 * benign (`FundingNotDue`, `PositionHealthy`), while a network error is worth
 * retrying and worth logging loudly.
 */
export function programError(err: unknown): string | null {
  const text = `${String((err as Error)?.message ?? "")} ${JSON.stringify(
    (err as { logs?: string[] })?.logs ?? [],
  )}`;

  const hex = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex) return errorName(parseInt(hex[1], 16)) ?? `Custom(0x${hex[1]})`;

  const named = text.match(/Error Code: (\w+)/);
  return named ? named[1] : null;
}

/** Errors that mean "not yet", not "broken". Logged quietly, never retried. */
export const BENIGN = new Set([
  "FundingNotDue",
  "PositionHealthy",
  "SessionNotOpen",
  "MarketHalted",
  "CannotIncreaseRiskWhileClosed",
  "RebalanceNotNeeded",
  "CooldownNotElapsed",
  "OracleDeviationTooLarge",
]);

export interface SendOutcome {
  ok: boolean;
  signature?: string;
  /** The program error name, when the program rejected it. */
  error?: string;
  /** True when the rejection is an expected "not yet" rather than a fault. */
  benign?: boolean;
  /** The program rejected it, as opposed to a transport failure. */
  rejected?: boolean;
}

/**
 * Send with retries, and classify the failure.
 *
 * Retries only transport failures. A program rejection is deterministic given
 * the same chain state, so retrying it burns fees to get the same answer; the
 * one exception is a blockhash that expired, which is a timing failure wearing
 * a program error's clothes.
 */
export async function send(
  config: ChainConfig,
  instructions: TransactionInstruction[],
  label: string,
  attempts = 3,
): Promise<SendOutcome> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const tx = new Transaction().add(...instructions);
      const signature = await sendAndConfirmTransaction(
        config.connection,
        tx,
        [config.payer],
        { commitment: "confirmed", maxRetries: 3 },
      );
      return { ok: true, signature };
    } catch (err) {
      const name = programError(err);

      if (name) {
        const benign = BENIGN.has(name);
        if (!benign) {
          config.log("warn", `${label} rejected`, { error: name });
        }
        return { ok: false, error: name, benign, rejected: true };
      }

      const message = String((err as Error)?.message ?? err);
      const expired = /blockhash not found|block height exceeded/i.test(
        message,
      );
      if (attempt === attempts) {
        config.log("error", `${label} failed after ${attempts} attempts`, {
          message,
        });
        return { ok: false, error: message };
      }
      config.log("info", `${label} retrying`, { attempt, expired, message });
      // Exponential backoff. A validator under load recovers on a timescale
      // that a tight retry loop only makes worse.
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  return { ok: false, error: "unreachable" };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `work` forever on an interval, never letting a throw kill the loop.
 *
 * A daemon that exits on the first unhandled rejection is a daemon that is
 * down at 3am with nobody watching. The interval is measured from the end of
 * one run to the start of the next, so a slow run does not stack.
 */
export async function loop(
  config: ChainConfig,
  name: string,
  intervalMs: number,
  work: () => Promise<void>,
  signal?: AbortSignal,
  /**
   * Called after every pass, with whether it threw. Optional: this is where
   * the health endpoint learns the loop is still turning, and the loop is the
   * only place that knows, since it owns both the catch and the schedule.
   */
  report?: (outcome: { ok: boolean; error?: string }) => void,
): Promise<void> {
  config.log("info", `${name} started`, { intervalMs });
  while (!signal?.aborted) {
    const started = Date.now();
    try {
      await work();
      report?.({ ok: true });
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      config.log("error", `${name} threw`, { message });
      report?.({ ok: false, error: message });
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(0, intervalMs - elapsed));
  }
  config.log("info", `${name} stopped`);
}
