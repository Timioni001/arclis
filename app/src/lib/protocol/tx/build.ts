/**
 * Building the instructions a trader actually signs.
 *
 * Everything here is pure: it takes addresses and amounts and returns a
 * `TransactionInstruction`. Nothing fetches, nothing signs, nothing sends.
 * That split is what makes this layer testable without a validator, and it is
 * why the account lists below can be checked against the IDL by a unit test
 * rather than by a devnet failure.
 *
 * The account **order** matters and is not alphabetical: Anchor matches
 * positionally against the `#[derive(Accounts)]` struct. Each builder below
 * lists them in the struct's own order, and `tx/accounts.test.ts` asserts that
 * order against the IDL so a reordered struct fails the build rather than the
 * transaction.
 */

import { BN, BorshCoder } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ARCLIS_IDL } from "../rpc/decode";
import {
  globalConfigPda,
  lpPositionPda,
  marketAddresses,
  positionPda,
  type MarketAddresses,
} from "../rpc/pdas";

const coder = new BorshCoder(ARCLIS_IDL);

const ro = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: false,
});
const rw = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: true,
});
const signer = (pubkey: PublicKey, writable = false): AccountMeta => ({
  pubkey,
  isSigner: true,
  isWritable: writable,
});

function ix(
  programId: PublicKey,
  name: string,
  args: Record<string, unknown>,
  keys: AccountMeta[],
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys,
    data: coder.instruction.encode(name, args),
  });
}

export interface TradeContext {
  programId: PublicKey;
  owner: PublicKey;
  symbol: string;
}

/** The addresses every trading instruction needs, derived once. */
export function resolve(ctx: TradeContext): MarketAddresses & {
  config: PublicKey;
  position: PublicKey;
  lpPosition: PublicKey;
} {
  const addresses = marketAddresses(ctx.programId, ctx.symbol);
  return {
    ...addresses,
    config: globalConfigPda(ctx.programId),
    position: positionPda(ctx.programId, ctx.owner, addresses.market),
    lpPosition: lpPositionPda(ctx.programId, ctx.owner, addresses.pool),
  };
}

// ---------------------------------------------------------------------------
// Collateral
// ---------------------------------------------------------------------------

export function depositCollateral(
  ctx: TradeContext,
  ownerTokenAccount: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const a = resolve(ctx);
  return ix(
    ctx.programId,
    "deposit_collateral",
    { amount: new BN(amount.toString()) },
    [
      signer(ctx.owner, true),
      ro(a.config),
      rw(a.market),
      ro(a.oracle),
      rw(a.position),
      rw(ownerTokenAccount),
      rw(a.marketVault),
      ro(TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId),
    ],
  );
}

export function withdrawCollateral(
  ctx: TradeContext,
  ownerTokenAccount: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const a = resolve(ctx);
  return ix(
    ctx.programId,
    "withdraw_collateral",
    { amount: new BN(amount.toString()) },
    [
      signer(ctx.owner),
      ro(a.config),
      rw(a.market),
      ro(a.oracle),
      rw(a.position),
      rw(ownerTokenAccount),
      rw(a.marketVault),
      rw(a.pool),
      rw(a.poolVault),
      ro(TOKEN_PROGRAM_ID),
    ],
  );
}

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

/**
 * `sizeDelta` is signed base size at 1e6: positive opens or adds to a long,
 * negative to a short. Flipping direction in one call is rejected on-chain
 * rather than netted, so the interface closes first and opens second.
 */
export function openPosition(
  ctx: TradeContext,
  sizeDelta: bigint,
): TransactionInstruction {
  const a = resolve(ctx);
  return ix(
    ctx.programId,
    "open_position",
    { size_delta: new BN(sizeDelta.toString()) },
    [
      signer(ctx.owner),
      ro(a.config),
      rw(a.market),
      ro(a.oracle),
      rw(a.position),
      rw(a.pool),
      rw(a.poolVault),
      rw(a.marketVault),
      ro(TOKEN_PROGRAM_ID),
    ],
  );
}

/** `reduceSize` is unsigned; pass the full absolute size to close out. */
export function closePosition(
  ctx: TradeContext,
  reduceSize: bigint,
): TransactionInstruction {
  const a = resolve(ctx);
  return ix(
    ctx.programId,
    "close_position",
    { reduce_size: new BN(reduceSize.toString()) },
    [
      signer(ctx.owner),
      ro(a.config),
      rw(a.market),
      ro(a.oracle),
      rw(a.position),
      rw(a.pool),
      rw(a.poolVault),
      rw(a.marketVault),
      ro(TOKEN_PROGRAM_ID),
    ],
  );
}

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

function lpKeys(
  ctx: TradeContext,
  ownerTokenAccount: PublicKey,
  a: ReturnType<typeof resolve>,
): AccountMeta[] {
  return [
    signer(ctx.owner, true),
    ro(a.config),
    ro(a.market),
    ro(a.oracle),
    rw(a.pool),
    rw(a.lpPosition),
    rw(a.poolVault),
    rw(ownerTokenAccount),
    ro(TOKEN_PROGRAM_ID),
    ro(SystemProgram.programId),
  ];
}

export function depositLiquidity(
  ctx: TradeContext,
  ownerTokenAccount: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const a = resolve(ctx);
  return ix(
    ctx.programId,
    "deposit_liquidity",
    { amount: new BN(amount.toString()) },
    lpKeys(ctx, ownerTokenAccount, a),
  );
}

export function requestWithdrawLiquidity(
  ctx: TradeContext,
  ownerTokenAccount: PublicKey,
  shares: bigint,
): TransactionInstruction {
  const a = resolve(ctx);
  return ix(
    ctx.programId,
    "request_withdraw_liquidity",
    { shares: new BN(shares.toString()) },
    lpKeys(ctx, ownerTokenAccount, a),
  );
}

export function cancelWithdrawLiquidity(
  ctx: TradeContext,
  ownerTokenAccount: PublicKey,
): TransactionInstruction {
  const a = resolve(ctx);
  return ix(
    ctx.programId,
    "cancel_withdraw_liquidity",
    {},
    lpKeys(ctx, ownerTokenAccount, a),
  );
}

export function withdrawLiquidity(
  ctx: TradeContext,
  ownerTokenAccount: PublicKey,
): TransactionInstruction {
  const a = resolve(ctx);
  return ix(
    ctx.programId,
    "withdraw_liquidity",
    {},
    lpKeys(ctx, ownerTokenAccount, a),
  );
}

// ---------------------------------------------------------------------------
// Permissionless
// ---------------------------------------------------------------------------

/** Anyone may crank once the interval has elapsed. Nothing here is biasable. */
export function crankFunding(
  programId: PublicKey,
  cranker: PublicKey,
  symbol: string,
): TransactionInstruction {
  const a = marketAddresses(programId, symbol);
  return ix(programId, "crank_funding", {}, [
    signer(cranker),
    ro(globalConfigPda(programId)),
    rw(a.market),
    ro(a.oracle),
    ro(a.pool),
    ro(a.poolVault),
  ]);
}

export function liquidate(
  programId: PublicKey,
  liquidator: PublicKey,
  liquidatorTokenAccount: PublicKey,
  symbol: string,
  positionOwner: PublicKey,
): TransactionInstruction {
  const a = marketAddresses(programId, symbol);
  return ix(programId, "liquidate", {}, [
    signer(liquidator),
    rw(liquidatorTokenAccount),
    ro(globalConfigPda(programId)),
    rw(a.market),
    ro(a.oracle),
    rw(positionPda(programId, positionOwner, a.market)),
    rw(a.marketVault),
    rw(a.pool),
    rw(a.poolVault),
    ro(TOKEN_PROGRAM_ID),
  ]);
}

/**
 * Capitalise a market's insurance fund. Permissionless in, no way out, and it
 * retires socialised bad debt before it credits the fund.
 */
export function depositInsurance(
  programId: PublicKey,
  depositor: PublicKey,
  depositorTokenAccount: PublicKey,
  symbol: string,
  amount: bigint,
): TransactionInstruction {
  const a = marketAddresses(programId, symbol);
  return ix(
    programId,
    "deposit_insurance",
    { amount: new BN(amount.toString()) },
    [
      signer(depositor, true),
      ro(globalConfigPda(programId)),
      rw(a.market),
      rw(depositorTokenAccount),
      rw(a.marketVault),
      ro(TOKEN_PROGRAM_ID),
    ],
  );
}

// ---------------------------------------------------------------------------
// Market creation
// ---------------------------------------------------------------------------

export interface MarketParams {
  maxLeverage: number;
  maintenanceMarginBps: number;
  takerFeeBps: number;
  liquidationPenaltyBps: number;
  fundingIntervalSecs: bigint;
  fundingSensitivityBps: number;
  maxOpenInterest: bigint;
  maxSkewBps: number;
  maxUtilizationBps: number;
}

export function createMarket(
  programId: PublicKey,
  creator: PublicKey,
  symbol: string,
  quoteMint: PublicKey,
  params: MarketParams,
): TransactionInstruction {
  const a = marketAddresses(programId, symbol);
  return ix(
    programId,
    "create_market",
    {
      params: {
        max_leverage: params.maxLeverage,
        maintenance_margin_bps: params.maintenanceMarginBps,
        taker_fee_bps: params.takerFeeBps,
        liquidation_penalty_bps: params.liquidationPenaltyBps,
        funding_interval_secs: new BN(params.fundingIntervalSecs.toString()),
        funding_sensitivity_bps: params.fundingSensitivityBps,
        max_open_interest: new BN(params.maxOpenInterest.toString()),
        max_skew_bps: params.maxSkewBps,
        max_utilization_bps: params.maxUtilizationBps,
      },
    },
    [
      signer(creator, true),
      ro(globalConfigPda(programId)),
      ro(a.oracle),
      rw(a.market),
      ro(quoteMint),
      rw(a.marketVault),
      ro(TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId),
      ro(SYSVAR_RENT_PUBKEY),
    ],
  );
}
