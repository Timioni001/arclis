/**
 * The devnet test-USDC faucet.
 *
 * Markets settle in a test token whose mint authority is the keeper's key, so
 * until now the only way to get any was to ask the operator to run the seed
 * script with `--airdrop`. That is a dead end for anyone evaluating the
 * deployment on their own. This hands out a fixed amount per wallet per day,
 * plus a little devnet SOL for fees when the wallet has none.
 *
 * # Limits, and why each exists
 *
 * - **Per wallet, once a day.** The token is worthless, but the keeper's SOL
 *   is not: every grant pays rent for a token account and a fee, and the same
 *   key publishes prices. A drained keeper is a stale oracle.
 * - **Per client IP, a few a day**, so rotating addresses is not free.
 * - **A global daily cap**, the backstop if both of those are evaded.
 * - **A SOL floor.** SOL is sent only while the keeper holds comfortably more
 *   than it needs to keep publishing.
 * - **Never retried.** A mint whose confirmation timed out may still have
 *   landed; sending it again would double it. The caller is told to try later.
 *
 * Off unless `FAUCET_ENABLED=yes`, and refused at startup unless the keeper's
 * key really is the quote mint's authority: on a deployment settling in real
 * USDC this cannot mint anything, and must not pretend to.
 */
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { send, type ChainConfig } from "./chain";

const DAY_MS = 86_400_000;

export interface FaucetLimits {
  /** Test USDC per grant, in base units (6 decimals). */
  amount: bigint;
  perIpPerDay: number;
  dailyCap: number;
  /** SOL sent to a wallet holding less than `solIfBelow`. */
  solGrant: number;
  solIfBelow: number;
  /** Keeper balance below which no SOL is given away. */
  solFloor: number;
}

export const DEFAULT_LIMITS: FaucetLimits = {
  amount: 10_000_000_000n,
  perIpPerDay: 3,
  dailyCap: 300,
  solGrant: 0.05,
  solIfBelow: 0.01,
  solFloor: 2,
};

export type Verdict = { ok: true } | { ok: false; status: number; error: string };

/**
 * Who may be granted what, when. Pure bookkeeping, no chain access, so the
 * limits are testable without a validator.
 */
export class FaucetPolicy {
  private readonly byAddress = new Map<string, number>();
  private readonly byIp = new Map<string, number[]>();
  private readonly inFlight = new Set<string>();
  private day: number[] = [];

  constructor(private readonly limits: FaucetLimits = DEFAULT_LIMITS) {}

  check(address: string, ip: string, now: number): Verdict {
    if (this.inFlight.has(address)) {
      return { ok: false, status: 409, error: "A grant to this wallet is already in progress." };
    }
    const last = this.byAddress.get(address);
    if (last !== undefined && now - last < DAY_MS) {
      const hours = Math.ceil((DAY_MS - (now - last)) / 3_600_000);
      return {
        ok: false,
        status: 429,
        error: `This wallet was funded recently. Try again in ${hours} h.`,
      };
    }
    const fromIp = (this.byIp.get(ip) ?? []).filter((t) => now - t < DAY_MS);
    if (fromIp.length >= this.limits.perIpPerDay) {
      return { ok: false, status: 429, error: "Daily limit reached for this network." };
    }
    this.day = this.day.filter((t) => now - t < DAY_MS);
    if (this.day.length >= this.limits.dailyCap) {
      return { ok: false, status: 503, error: "The faucet's daily budget is spent. Try tomorrow." };
    }
    return { ok: true };
  }

  begin(address: string) {
    this.inFlight.add(address);
  }

  /** Record a grant that landed. A failed one is not counted against anyone. */
  finish(address: string, ip: string, now: number, granted: boolean) {
    this.inFlight.delete(address);
    if (!granted) return;
    this.byAddress.set(address, now);
    const fromIp = (this.byIp.get(ip) ?? []).filter((t) => now - t < DAY_MS);
    this.byIp.set(ip, [...fromIp, now]);
    this.day.push(now);
  }
}

/** A base58 Solana address, parsed, or null. Off-curve (PDA) owners are refused. */
export function parseRecipient(raw: string | null): PublicKey | null {
  if (!raw || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) return null;
  try {
    const key = new PublicKey(raw);
    return PublicKey.isOnCurve(key.toBytes()) ? key : null;
  } catch {
    return null;
  }
}

/** The instructions for one grant. */
export function grantInstructions(
  payer: PublicKey,
  mint: PublicKey,
  recipient: PublicKey,
  amount: bigint,
  lamports: number,
): TransactionInstruction[] {
  const ata = getAssociatedTokenAddressSync(mint, recipient, true);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(payer, ata, recipient, mint),
    createMintToInstruction(mint, ata, payer, amount),
  ];
  if (lamports > 0) {
    ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports }));
  }
  return ixs;
}

export interface FaucetResponse {
  status: number;
  body: Record<string, unknown>;
}

export type FaucetHandler = (address: string | null, ip: string) => Promise<FaucetResponse>;

/**
 * Build the faucet, or explain why it cannot run. Checks the mint authority
 * once, up front, so a misconfigured deployment says so in its startup log
 * rather than on every request.
 */
export async function createFaucet(
  config: ChainConfig,
  mint: PublicKey,
  limits: FaucetLimits = DEFAULT_LIMITS,
): Promise<FaucetHandler | string> {
  const info = await getMint(config.connection, mint);
  if (!info.mintAuthority?.equals(config.payer.publicKey)) {
    return "the keeper key is not the quote mint's authority";
  }
  const decimals = info.decimals;
  const policy = new FaucetPolicy(limits);

  return async (raw, ip) => {
    const recipient = parseRecipient(raw);
    if (!recipient) {
      return { status: 400, body: { error: "Pass a wallet address as ?address=." } };
    }
    const address = recipient.toBase58();
    const now = Date.now();
    const verdict = policy.check(address, ip, now);
    if (!verdict.ok) {
      const { status, error } = verdict as Extract<Verdict, { ok: false }>;
      return { status, body: { error } };
    }

    policy.begin(address);
    let granted = false;
    try {
      const [theirs, ours] = await Promise.all([
        config.connection.getBalance(recipient),
        config.connection.getBalance(config.payer.publicKey),
      ]);
      const lamports =
        theirs < limits.solIfBelow * LAMPORTS_PER_SOL &&
        ours > limits.solFloor * LAMPORTS_PER_SOL
          ? Math.round(limits.solGrant * LAMPORTS_PER_SOL)
          : 0;
      const outcome = await send(
        config,
        grantInstructions(config.payer.publicKey, mint, recipient, limits.amount, lamports),
        "faucet",
        1,
      );
      if (!outcome.ok) {
        return {
          status: 502,
          body: { error: "The grant did not confirm. Check your balance before trying again." },
        };
      }
      granted = true;
      config.log("info", "faucet grant", { address, sol: lamports / LAMPORTS_PER_SOL });
      return {
        status: 200,
        body: {
          signature: outcome.signature,
          amount: Number(limits.amount) / 10 ** decimals,
          sol: lamports / LAMPORTS_PER_SOL,
        },
      };
    } finally {
      policy.finish(address, ip, now, granted);
    }
  };
}
