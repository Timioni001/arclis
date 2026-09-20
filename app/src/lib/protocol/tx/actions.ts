/**
 * What a button does.
 *
 * One function per user-facing action, each returning a `SendResult` or
 * throwing a `TransactionError` with a sentence. Screens call these and know
 * nothing about instructions, PDAs or account ordering.
 *
 * Every action that moves quote tokens needs the caller's associated token
 * account, and it is derived rather than passed: a mismatched ATA is a class
 * of bug that simply cannot happen if nobody is allowed to supply one.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { TransactionInstruction } from "@solana/web3.js";
import type { Session } from "../../auth/session";
import { sendInstructions, TransactionError, type SendResult } from "./send";
import * as build from "./build";

export interface ActionContext {
  connection: Connection;
  session: Session;
  programId: PublicKey;
  quoteMint: PublicKey;
  symbol: string;
}

function owner(ctx: ActionContext): PublicKey {
  if (!ctx.session.address) {
    throw new TransactionError("Sign in to do that.");
  }
  return new PublicKey(ctx.session.address);
}

function tradeCtx(ctx: ActionContext): build.TradeContext {
  return { programId: ctx.programId, owner: owner(ctx), symbol: ctx.symbol };
}

function ata(ctx: ActionContext): PublicKey {
  return getAssociatedTokenAddressSync(ctx.quoteMint, owner(ctx), true);
}

/**
 * Prepend an ATA creation when the account does not exist yet.
 *
 * A first-time depositor has no token account, and letting the transfer fail
 * with a raw token-program error is a needless dead end on the single most
 * important step in the funnel. Creating it in the same transaction costs rent
 * the user pays anyway the first time they hold the token.
 */
async function withAtaIfMissing(
  ctx: ActionContext,
  instructions: TransactionInstruction[],
): Promise<TransactionInstruction[]> {
  const address = ata(ctx);
  const info = await ctx.connection.getAccountInfo(address);
  if (info) return instructions;
  return [
    createAssociatedTokenAccountInstruction(
      owner(ctx),
      address,
      owner(ctx),
      ctx.quoteMint,
    ),
    ...instructions,
  ];
}

const send = (ctx: ActionContext, ixs: TransactionInstruction[]) =>
  sendInstructions({ connection: ctx.connection, session: ctx.session }, ixs);

// ---------------------------------------------------------------------------
// Collateral
// ---------------------------------------------------------------------------

export async function depositCollateral(
  ctx: ActionContext,
  amount: bigint,
): Promise<SendResult> {
  if (amount <= 0n) throw new TransactionError("Enter an amount above zero.");
  return send(ctx, [build.depositCollateral(tradeCtx(ctx), ata(ctx), amount)]);
}

export async function withdrawCollateral(
  ctx: ActionContext,
  amount: bigint,
): Promise<SendResult> {
  if (amount <= 0n) throw new TransactionError("Enter an amount above zero.");
  return send(
    ctx,
    await withAtaIfMissing(ctx, [
      build.withdrawCollateral(tradeCtx(ctx), ata(ctx), amount),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

/** `sizeDelta` is signed base size at 1e6. Positive long, negative short. */
export async function openPosition(
  ctx: ActionContext,
  sizeDelta: bigint,
): Promise<SendResult> {
  if (sizeDelta === 0n) throw new TransactionError("Enter a size above zero.");
  return send(ctx, [build.openPosition(tradeCtx(ctx), sizeDelta)]);
}

export async function closePosition(
  ctx: ActionContext,
  reduceSize: bigint,
): Promise<SendResult> {
  if (reduceSize <= 0n) throw new TransactionError("Enter a size above zero.");
  return send(ctx, [build.closePosition(tradeCtx(ctx), reduceSize)]);
}

/**
 * Deposit and open in one transaction.
 *
 * The two-step version is a real failure mode rather than a UX wrinkle: a
 * trader who deposits and then has the open rejected is left with idle
 * collateral and no position, which looks exactly like the money vanished.
 * Atomically, either they have the position or they still have their money.
 */
export async function depositAndOpen(
  ctx: ActionContext,
  collateral: bigint,
  sizeDelta: bigint,
): Promise<SendResult> {
  if (sizeDelta === 0n) throw new TransactionError("Enter a size above zero.");
  const t = tradeCtx(ctx);
  const ixs: TransactionInstruction[] = [];
  if (collateral > 0n) {
    ixs.push(build.depositCollateral(t, ata(ctx), collateral));
  }
  ixs.push(build.openPosition(t, sizeDelta));
  return send(ctx, ixs);
}

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

export async function depositLiquidity(
  ctx: ActionContext,
  amount: bigint,
): Promise<SendResult> {
  if (amount <= 0n) throw new TransactionError("Enter an amount above zero.");
  return send(ctx, [build.depositLiquidity(tradeCtx(ctx), ata(ctx), amount)]);
}

export async function requestWithdrawLiquidity(
  ctx: ActionContext,
  shares: bigint,
): Promise<SendResult> {
  if (shares <= 0n)
    throw new TransactionError("Enter a share amount above zero.");
  return send(ctx, [
    build.requestWithdrawLiquidity(tradeCtx(ctx), ata(ctx), shares),
  ]);
}

export async function cancelWithdrawLiquidity(
  ctx: ActionContext,
): Promise<SendResult> {
  return send(ctx, [build.cancelWithdrawLiquidity(tradeCtx(ctx), ata(ctx))]);
}

export async function withdrawLiquidity(
  ctx: ActionContext,
): Promise<SendResult> {
  return send(
    ctx,
    await withAtaIfMissing(ctx, [
      build.withdrawLiquidity(tradeCtx(ctx), ata(ctx)),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Permissionless
// ---------------------------------------------------------------------------

export async function crankFunding(ctx: ActionContext): Promise<SendResult> {
  return send(ctx, [build.crankFunding(ctx.programId, owner(ctx), ctx.symbol)]);
}

export async function depositInsurance(
  ctx: ActionContext,
  amount: bigint,
): Promise<SendResult> {
  if (amount <= 0n) throw new TransactionError("Enter an amount above zero.");
  return send(ctx, [
    build.depositInsurance(
      ctx.programId,
      owner(ctx),
      ata(ctx),
      ctx.symbol,
      amount,
    ),
  ]);
}

export { TransactionError, type SendResult };
