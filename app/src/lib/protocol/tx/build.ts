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
  METADATA_PROGRAM_ID,
  metadataPda,
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

// ---------------------------------------------------------------------------
// Agent treasuries
// ---------------------------------------------------------------------------

export interface TreasuryAddresses extends MarketAddresses {
  config: PublicKey;
  treasury: PublicKey;
  stockVault: PublicKey;
  /** The treasury's own perp position, owned by the treasury PDA. */
  position: PublicKey;
}

export function treasuryAddresses(
  programId: PublicKey,
  symbol: string,
  agentMint: PublicKey,
): TreasuryAddresses {
  const m = marketAddresses(programId, symbol);
  const treasury = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), agentMint.toBuffer()],
    programId,
  )[0];
  const stockVault = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury_stock"), treasury.toBuffer()],
    programId,
  )[0];
  return {
    ...m,
    config: globalConfigPda(programId),
    treasury,
    stockVault,
    position: positionPda(programId, treasury, m.market),
  };
}

export function initializeTreasury(
  programId: PublicKey,
  authority: PublicKey,
  a: TreasuryAddresses,
  agentMint: PublicKey,
  stockMint: PublicKey,
  hedgeRatioBps: number,
  toleranceBps: number,
): TransactionInstruction {
  return ix(
    programId,
    "initialize_treasury",
    { hedge_ratio_bps: hedgeRatioBps, rebalance_tolerance_bps: toleranceBps },
    [
      signer(authority, true),
      ro(a.config),
      ro(agentMint),
      ro(stockMint),
      ro(a.market),
      rw(a.treasury),
      rw(a.stockVault),
      ro(TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId),
      ro(SYSVAR_RENT_PUBKEY),
    ],
  );
}

export function setTreasuryPolicy(
  programId: PublicKey,
  authority: PublicKey,
  treasury: PublicKey,
  hedgeRatioBps: number,
  toleranceBps: number,
  hedgingEnabled: boolean,
  tokensOutstanding: bigint,
): TransactionInstruction {
  return ix(
    programId,
    "set_treasury_policy",
    {
      hedge_ratio_bps: hedgeRatioBps,
      rebalance_tolerance_bps: toleranceBps,
      hedging_enabled: hedgingEnabled,
      tokens_outstanding: new BN(tokensOutstanding.toString()),
    },
    [signer(authority), rw(treasury)],
  );
}

export function depositStock(
  programId: PublicKey,
  authority: PublicKey,
  a: TreasuryAddresses,
  authorityStockAccount: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return ix(programId, "deposit_stock", { amount: new BN(amount.toString()) }, [
    signer(authority),
    ro(a.config),
    rw(a.treasury),
    rw(a.stockVault),
    rw(authorityStockAccount),
    ro(TOKEN_PROGRAM_ID),
  ]);
}

function hedgeMarginKeys(
  authority: PublicKey,
  a: TreasuryAddresses,
  authorityQuoteAccount: PublicKey,
): AccountMeta[] {
  return [
    signer(authority, true),
    ro(a.config),
    ro(a.treasury),
    rw(a.market),
    ro(a.oracle),
    rw(a.position),
    rw(authorityQuoteAccount),
    rw(a.marketVault),
    rw(a.pool),
    rw(a.poolVault),
    ro(TOKEN_PROGRAM_ID),
    ro(SystemProgram.programId),
  ];
}

export function fundTreasuryHedge(
  programId: PublicKey,
  authority: PublicKey,
  a: TreasuryAddresses,
  authorityQuoteAccount: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return ix(
    programId,
    "fund_treasury_hedge",
    { amount: new BN(amount.toString()) },
    hedgeMarginKeys(authority, a, authorityQuoteAccount),
  );
}

export function defundTreasuryHedge(
  programId: PublicKey,
  authority: PublicKey,
  a: TreasuryAddresses,
  authorityQuoteAccount: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return ix(
    programId,
    "defund_treasury_hedge",
    { amount: new BN(amount.toString()) },
    hedgeMarginKeys(authority, a, authorityQuoteAccount),
  );
}

export function rebalanceHedge(
  programId: PublicKey,
  cranker: PublicKey,
  a: TreasuryAddresses,
): TransactionInstruction {
  return ix(programId, "rebalance_hedge", {}, [
    signer(cranker),
    ro(a.config),
    rw(a.treasury),
    rw(a.market),
    ro(a.oracle),
    rw(a.position),
    rw(a.pool),
    rw(a.poolVault),
    rw(a.marketVault),
    ro(TOKEN_PROGRAM_ID),
  ]);
}

/**
 * Metaplex `CreateMetadataAccountV3`, so a new agent shows by its name.
 *
 * The interface reads an agent's name from its token metadata, the same place
 * a ClawPump-launched agent's name lives. Hand-built for the same reason as in
 * `scripts/seed-treasury.ts`: one discriminator byte and three Borsh strings do
 * not justify the Metaplex SDK in the browser bundle.
 */
export function createTokenMetadata(
  mint: PublicKey,
  authority: PublicKey,
  name: string,
  symbol: string,
): TransactionInstruction {
  const str = (s: string) => {
    const bytes = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([len, bytes]);
  };
  const data = Buffer.concat([
    Buffer.from([33]), // CreateMetadataAccountV3
    str(name),
    str(symbol),
    str(""), // uri
    Buffer.from([0, 0]), // seller_fee_basis_points
    Buffer.from([0]), // creators: None
    Buffer.from([0]), // collection: None
    Buffer.from([0]), // uses: None
    Buffer.from([1]), // is_mutable
    Buffer.from([0]), // collection_details: None
  ]);
  return new TransactionInstruction({
    programId: METADATA_PROGRAM_ID,
    keys: [
      rw(metadataPda(mint)),
      ro(mint),
      signer(authority), // mint authority
      signer(authority, true), // payer
      ro(authority), // update authority
      ro(SystemProgram.programId),
      ro(SYSVAR_RENT_PUBKEY),
    ],
    data,
  });
}
