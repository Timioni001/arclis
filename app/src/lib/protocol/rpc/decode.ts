/**
 * Turning raw program accounts into the read model the screens already use.
 *
 * Anchor's `BorshCoder` handles the wire format from the IDL, so nothing here
 * parses bytes. What this file does is the part the coder cannot: convert
 * Anchor's `BN` into the `bigint` the read model is built on, and map snake
 * case onto the camel case the rest of the app speaks.
 *
 * The `BN` to `bigint` conversion is not cosmetic. `BN` is arbitrary precision
 * but its `toNumber()` throws above 2^53, and a notional in raw 1e6 units
 * crosses that at about nine billion dollars. Every quantity that can grow goes
 * through `big()` and stays exact.
 */

import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";
import idl from "../../../idl/arclis.json";
import type {
  LiquidityPool,
  LpPosition,
  Market,
  MarketSession,
  Oracle,
  Position,
} from "../types";

export const ARCLIS_IDL = idl as Idl;
export const coder = new BorshCoder(ARCLIS_IDL);

/** Anchor hands back `BN`; the read model is `bigint`. */
function big(v: { toString(): string } | null | undefined): bigint {
  return v === null || v === undefined ? 0n : BigInt(v.toString());
}

function num(v: { toString(): string } | null | undefined): number {
  return v === null || v === undefined ? 0 : Number(v.toString());
}

/**
 * Anchor encodes a fieldless enum as `{ open: {} }`. Reading the one key is the
 * documented shape, and an unrecognised variant is treated as `Halted` rather
 * than guessed: an unknown session is exactly the case where the interface must
 * refuse to let anyone take on risk.
 */
function session(raw: Record<string, unknown>): MarketSession {
  const key = Object.keys(raw ?? {})[0]?.toLowerCase();
  switch (key) {
    case "open":
      return "Open";
    case "closed":
      return "Closed";
    case "preopen":
      return "PreOpen";
    case "halted":
      return "Halted";
    default:
      return "Halted";
  }
}

/** Trim the zero padding off the fixed 16-byte symbol. */
function symbolOf(bytes: number[] | Uint8Array): string {
  const arr = Array.from(bytes);
  const end = arr.indexOf(0);
  return new TextDecoder().decode(
    Uint8Array.from(end === -1 ? arr : arr.slice(0, end)),
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export function decodeOracle(
  address: PublicKey,
  data: Buffer,
  meta: { name?: string; nextOpenTs?: number; nextCloseTs?: number } = {},
): Oracle {
  const a: any = coder.accounts.decode("priceOracle", data);
  const symbol = symbolOf(a.symbol);
  return {
    address: address.toBase58(),
    symbol,
    // The company name is not on-chain and is not worth putting there. It is
    // resolved off-chain, and falls back to the ticker rather than to an empty
    // string so a missing lookup degrades to something readable.
    name: meta.name ?? symbol,
    price: big(a.price),
    confidence: big(a.confidence),
    lastUpdateTs: num(a.lastUpdateTs),
    session: session(a.session),
    sessionUpdatedTs: num(a.sessionUpdatedTs ?? a.lastUpdateTs),
    splitFactor: big(a.splitFactor),
    corporateActionSeq: num(a.corporateActionSeq),
    nextOpenTs: meta.nextOpenTs ?? 0,
    nextCloseTs: meta.nextCloseTs ?? 0,
  };
}

export function decodeMarket(address: PublicKey, data: Buffer): Market {
  const a: any = coder.accounts.decode("market", data);
  return {
    address: address.toBase58(),
    oracle: a.oracle.toBase58(),
    vault: a.vault.toBase58(),
    liquidityPool: a.liquidityPool.toBase58(),
    paused: Boolean(a.paused),

    maxLeverage: num(a.maxLeverage),
    maintenanceMarginBps: num(a.maintenanceMarginBps),
    initialMarginBps: num(a.initialMarginBps),
    takerFeeBps: num(a.takerFeeBps),
    liquidationPenaltyBps: num(a.liquidationPenaltyBps),
    fundingSensitivityBps: num(a.fundingSensitivityBps),

    fundingIntervalSecs: num(a.fundingIntervalSecs),
    lastFundingTs: num(a.lastFundingTs),
    cumulativeFundingIndex: big(a.cumulativeFundingIndex),

    openInterestLong: big(a.openInterestLong),
    openInterestShort: big(a.openInterestShort),
    longEntryNotional: big(a.longEntryNotional),
    shortEntryNotional: big(a.shortEntryNotional),
    maxOpenInterest: big(a.maxOpenInterest),
    maxSkewBps: num(a.maxSkewBps),
    maxUtilizationBps: num(a.maxUtilizationBps),

    totalCollateral: big(a.totalCollateral),
    insuranceBalance: big(a.insuranceBalance),
    badDebt: big(a.badDebt),
  };
}

export function decodePosition(address: PublicKey, data: Buffer): Position {
  const a: any = coder.accounts.decode("position", data);
  return {
    address: address.toBase58(),
    owner: a.owner.toBase58(),
    market: a.market.toBase58(),
    size: big(a.size),
    entryPrice: big(a.entryPrice),
    collateral: big(a.collateral),
    entryFundingIndex: big(a.entryFundingIndex),
    entrySplitFactor: big(a.entrySplitFactor),
    lastUpdateTs: num(a.lastUpdateTs),
  };
}

/**
 * The pool's vault balance is passed in rather than read from the account,
 * because NAV is defined against what the vault actually holds. Deriving it
 * from `principal` would hide exactly the accounting drift NAV exists to
 * expose.
 */
export function decodePool(
  address: PublicKey,
  data: Buffer,
  vaultBalance: bigint,
): LiquidityPool {
  const a: any = coder.accounts.decode("liquidityPool", data);
  return {
    address: address.toBase58(),
    market: a.market.toBase58(),
    vault: a.vault.toBase58(),
    vaultBalance,
    totalShares: big(a.totalShares),
    principal: big(a.principal),
    realizedPnl: big(a.realizedPnl),
    absorbedBadDebt: big(a.absorbedBadDebt),
    cooldownSecs: num(a.cooldownSecs),
    pendingShares: big(a.pendingShares),
    depositsPaused: Boolean(a.depositsPaused),
  };
}

export function decodeLpPosition(address: PublicKey, data: Buffer): LpPosition {
  const a: any = coder.accounts.decode("lpPosition", data);
  return {
    address: address.toBase58(),
    owner: a.owner.toBase58(),
    pool: a.pool.toBase58(),
    shares: big(a.shares),
    pendingShares: big(a.pendingShares),
    cooldownEndsTs: num(a.cooldownEndsTs),
    lastDepositTs: num(a.lastDepositTs),
  };
}

/**
 * Map an on-chain error back to its name.
 *
 * A raw `custom program error: 0x1773` is the least useful thing an interface
 * can show. The IDL carries every code and message, so the number is resolved
 * to the name the codebase and the docs both use.
 */
export function errorName(code: number): string | null {
  const errors = (ARCLIS_IDL as any).errors as
    Array<{ code: number; name: string; msg?: string }> | undefined;
  return errors?.find((e) => e.code === code)?.name ?? null;
}

export function errorMessage(code: number): string | null {
  const errors = (ARCLIS_IDL as any).errors as
    Array<{ code: number; name: string; msg?: string }> | undefined;
  const hit = errors?.find((e) => e.code === code);
  return hit ? (hit.msg ?? hit.name) : null;
}
