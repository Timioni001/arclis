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

import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
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

// ---------------------------------------------------------------------------
// Agent treasuries
// ---------------------------------------------------------------------------

/** Every token the treasury flow creates uses the protocol's 1e6 scale. */
const DECIMALS = 6;

/**
 * Create the agent's token and the stock it raised, in one transaction.
 *
 * On mainnet the agent token comes from its ClawPump launch and the stock is a
 * real tokenized share. Devnet has neither, so this creates both: an agent mint
 * named through token metadata, and a stand-in stock mint of which `stockQty`
 * is minted to the caller. It is the same compromise `scripts/seed-treasury.ts`
 * makes, and the interface says so wherever this is offered.
 */
export async function createTreasuryMints(
  ctx: ActionContext,
  args: {
    agentMint: Keypair;
    stockMint: Keypair;
    agentName: string;
    agentTicker: string;
    stockQty: bigint;
  },
): Promise<SendResult> {
  const me = owner(ctx);
  if (args.stockQty <= 0n) {
    throw new TransactionError("Enter a stock amount above zero.");
  }
  const rent = await getMinimumBalanceForRentExemptMint(ctx.connection);
  const newMint = (mint: PublicKey) => [
    SystemProgram.createAccount({
      fromPubkey: me,
      newAccountPubkey: mint,
      lamports: rent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint, DECIMALS, me, null),
  ];
  const stockAta = getAssociatedTokenAddressSync(
    args.stockMint.publicKey,
    me,
    true,
  );
  return sendInstructions(
    {
      connection: ctx.connection,
      session: ctx.session,
      extraSigners: [args.agentMint, args.stockMint],
    },
    [
      ...newMint(args.agentMint.publicKey),
      build.createTokenMetadata(
        args.agentMint.publicKey,
        me,
        args.agentName,
        args.agentTicker,
      ),
      ...newMint(args.stockMint.publicKey),
      createAssociatedTokenAccountIdempotentInstruction(
        me,
        stockAta,
        me,
        args.stockMint.publicKey,
      ),
      createMintToInstruction(
        args.stockMint.publicKey,
        stockAta,
        me,
        args.stockQty,
      ),
    ],
  );
}

/**
 * Open the treasury, set its policy and move the stock in.
 *
 * Three instructions, one approval: a treasury that exists but holds nothing
 * is a half-finished state with no reason to be visible to anyone.
 */
export async function openTreasury(
  ctx: ActionContext,
  args: {
    agentMint: PublicKey;
    stockMint: PublicKey;
    stockQty: bigint;
    tokensOutstanding: bigint;
    hedgeRatioBps: number;
    toleranceBps: number;
  },
): Promise<SendResult> {
  const me = owner(ctx);
  const a = build.treasuryAddresses(ctx.programId, ctx.symbol, args.agentMint);
  const stockAta = getAssociatedTokenAddressSync(args.stockMint, me, true);
  return send(ctx, [
    build.initializeTreasury(
      ctx.programId,
      me,
      a,
      args.agentMint,
      args.stockMint,
      args.hedgeRatioBps,
      args.toleranceBps,
    ),
    build.setTreasuryPolicy(
      ctx.programId,
      me,
      a.treasury,
      args.hedgeRatioBps,
      args.toleranceBps,
      true,
      args.tokensOutstanding,
    ),
    build.depositStock(ctx.programId, me, a, stockAta, args.stockQty),
  ]);
}

/**
 * Post margin behind the hedge and open it, in one transaction.
 *
 * Margin alone leaves an unhedged treasury with idle collateral, which reads as
 * the feature not working. Rebalancing in the same transaction means the user
 * either ends with a live short or keeps their margin.
 */
export async function fundAndHedge(
  ctx: ActionContext,
  agentMint: PublicKey,
  margin: bigint,
): Promise<SendResult> {
  if (margin <= 0n) throw new TransactionError("Enter a margin above zero.");
  const me = owner(ctx);
  const a = build.treasuryAddresses(ctx.programId, ctx.symbol, agentMint);
  return send(ctx, [
    build.fundTreasuryHedge(ctx.programId, me, a, ata(ctx), margin),
    build.rebalanceHedge(ctx.programId, me, a),
  ]);
}

export async function addHedgeMargin(
  ctx: ActionContext,
  agentMint: PublicKey,
  amount: bigint,
): Promise<SendResult> {
  if (amount <= 0n) throw new TransactionError("Enter an amount above zero.");
  const a = build.treasuryAddresses(ctx.programId, ctx.symbol, agentMint);
  return send(ctx, [
    build.fundTreasuryHedge(ctx.programId, owner(ctx), a, ata(ctx), amount),
  ]);
}

export async function withdrawHedgeMargin(
  ctx: ActionContext,
  agentMint: PublicKey,
  amount: bigint,
): Promise<SendResult> {
  if (amount <= 0n) throw new TransactionError("Enter an amount above zero.");
  const a = build.treasuryAddresses(ctx.programId, ctx.symbol, agentMint);
  return send(
    ctx,
    await withAtaIfMissing(ctx, [
      build.defundTreasuryHedge(ctx.programId, owner(ctx), a, ata(ctx), amount),
    ]),
  );
}

/** Permissionless: anyone can bring any treasury back to its target. */
export async function rebalanceTreasury(
  ctx: ActionContext,
  agentMint: PublicKey,
): Promise<SendResult> {
  const a = build.treasuryAddresses(ctx.programId, ctx.symbol, agentMint);
  return send(ctx, [build.rebalanceHedge(ctx.programId, owner(ctx), a)]);
}

/**
 * Deposit more stock, minting it first when the caller controls the mint.
 *
 * A treasury opened here holds a devnet stand-in stock whose mint authority is
 * its creator, so "add stock" mints and deposits. For any other stock the
 * shares must already be in the caller's wallet.
 */
export async function addTreasuryStock(
  ctx: ActionContext,
  agentMint: PublicKey,
  stockMint: PublicKey,
  amount: bigint,
): Promise<SendResult> {
  if (amount <= 0n) throw new TransactionError("Enter an amount above zero.");
  const me = owner(ctx);
  const a = build.treasuryAddresses(ctx.programId, ctx.symbol, agentMint);
  const stockAta = getAssociatedTokenAddressSync(stockMint, me, true);
  const ixs: TransactionInstruction[] = [];
  const info = await ctx.connection.getAccountInfo(stockMint);
  // Mint layout: COption tag (u32) then the authority at bytes 4..36.
  const mintAuthority =
    info && info.data.length >= 36 && info.data.readUInt32LE(0) === 1
      ? new PublicKey(info.data.subarray(4, 36))
      : null;
  if (mintAuthority?.equals(me)) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        me,
        stockAta,
        me,
        stockMint,
      ),
      createMintToInstruction(stockMint, stockAta, me, amount),
    );
  }
  ixs.push(build.depositStock(ctx.programId, me, a, stockAta, amount));
  return send(ctx, ixs);
}

export { TransactionError, type SendResult };
