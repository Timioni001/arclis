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
  Treasury,
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

/*
 * Names here are the IDL's own, not Anchor's.
 *
 * `Program` converts an IDL to camelCase internally before using it. A raw
 * `BorshCoder` does not, and this file builds one deliberately, to keep
 * Anchor's client out of the entry chunk. So accounts are `"Market"`, not
 * `"market"`, and fields are `max_leverage`, not `maxLeverage`.
 *
 * Getting that wrong is not a small mistake here. The wrong account name
 * throws `Unknown account`, which `refresh()` catches and turns into a
 * recorded error and an empty snapshot - an interface with no markets and a
 * status pill, rather than a stack trace. The wrong field name is quieter
 * still: `undefined` in, zero out, and a page of plausible zeroes. Both
 * shipped, and neither was caught, because nothing decoded a real account.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function decodeOracle(
  address: PublicKey,
  data: Buffer,
  meta: { name?: string; nextOpenTs?: number; nextCloseTs?: number } = {},
): Oracle {
  const a: any = coder.accounts.decode("PriceOracle", data);
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
    lastUpdateTs: num(a.last_update_ts),
    session: session(a.session),
    sessionUpdatedTs: num(a.session_updated_ts ?? a.last_update_ts),
    splitFactor: big(a.split_factor),
    corporateActionSeq: num(a.corporate_action_seq),
    nextOpenTs: meta.nextOpenTs ?? 0,
    nextCloseTs: meta.nextCloseTs ?? 0,
  };
}

export function decodeMarket(address: PublicKey, data: Buffer): Market {
  const a: any = coder.accounts.decode("Market", data);
  return {
    address: address.toBase58(),
    oracle: a.oracle.toBase58(),
    vault: a.vault.toBase58(),
    liquidityPool: a.liquidity_pool.toBase58(),
    paused: Boolean(a.paused),

    maxLeverage: num(a.max_leverage),
    maintenanceMarginBps: num(a.maintenance_margin_bps),
    initialMarginBps: num(a.initial_margin_bps),
    takerFeeBps: num(a.taker_fee_bps),
    liquidationPenaltyBps: num(a.liquidation_penalty_bps),
    fundingSensitivityBps: num(a.funding_sensitivity_bps),

    fundingIntervalSecs: num(a.funding_interval_secs),
    lastFundingTs: num(a.last_funding_ts),
    cumulativeFundingIndex: big(a.cumulative_funding_index),

    openInterestLong: big(a.open_interest_long),
    openInterestShort: big(a.open_interest_short),
    longEntryNotional: big(a.long_entry_notional),
    shortEntryNotional: big(a.short_entry_notional),
    maxOpenInterest: big(a.max_open_interest),
    maxSkewBps: num(a.max_skew_bps),
    maxUtilizationBps: num(a.max_utilization_bps),

    totalCollateral: big(a.total_collateral),
    insuranceBalance: big(a.insurance_balance),
    badDebt: big(a.bad_debt),
  };
}

export function decodePosition(address: PublicKey, data: Buffer): Position {
  const a: any = coder.accounts.decode("Position", data);
  return {
    address: address.toBase58(),
    owner: a.owner.toBase58(),
    market: a.market.toBase58(),
    size: big(a.size),
    entryPrice: big(a.entry_price),
    collateral: big(a.collateral),
    entryFundingIndex: big(a.entry_funding_index),
    entrySplitFactor: big(a.entry_split_factor),
    lastUpdateTs: num(a.last_update_ts),
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
  const a: any = coder.accounts.decode("LiquidityPool", data);
  return {
    address: address.toBase58(),
    market: a.market.toBase58(),
    vault: a.vault.toBase58(),
    vaultBalance,
    totalShares: big(a.total_shares),
    principal: big(a.principal),
    realizedPnl: big(a.realized_pnl),
    absorbedBadDebt: big(a.absorbed_bad_debt),
    cooldownSecs: num(a.cooldown_secs),
    pendingShares: big(a.pending_shares),
    depositsPaused: Boolean(a.deposits_paused),
  };
}

export function decodeLpPosition(address: PublicKey, data: Buffer): LpPosition {
  const a: any = coder.accounts.decode("LpPosition", data);
  return {
    address: address.toBase58(),
    owner: a.owner.toBase58(),
    pool: a.pool.toBase58(),
    shares: big(a.shares),
    pendingShares: big(a.pending_shares),
    cooldownEndsTs: num(a.cooldown_ends_ts),
    lastDepositTs: num(a.last_deposit_ts),
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

/**
 * The discriminator Anchor writes into the first eight bytes of an account.
 *
 * Exposed because enumerating accounts of one type is a `getProgramAccounts`
 * call with a `memcmp` on those bytes, and computing them by hand in the
 * caller would be a second place for the IDL's spelling to drift.
 *
 * The name is the IDL's, for the same reason `decode` takes the IDL's: pass
 * `"agentTreasury"` and Anchor throws. That failure is the good case. The bad
 * one is a discriminator for a name that happens to exist but is not the one
 * wanted, which produces a filter that matches nothing and a scan that returns
 * an empty list in silence.
 */
export function accountDiscriminator(name: string): Buffer {
  return (
    coder.accounts as unknown as { accountDiscriminator(n: string): Buffer }
  ).accountDiscriminator(name);
}

/**
 * An agent treasury.
 *
 * `agentName` is not on the account. There is no name field, deliberately:
 * thirty-two bytes of mutable string on every treasury, to hold something the
 * token's own metadata already holds. So the caller resolves it and this
 * falls back to the mint, which is at least unambiguous.
 */
export function decodeTreasury(
  address: PublicKey,
  data: Buffer,
  meta: { agentName?: string } = {},
): Treasury {
  const a: any = coder.accounts.decode("AgentTreasury", data);
  const agentMint = a.agent_mint.toBase58();
  return {
    address: address.toBase58(),
    authority: a.authority.toBase58(),
    agentMint,
    agentName: meta.agentName ?? shortMint(agentMint),
    stockMint: a.stock_mint.toBase58(),
    market: a.market.toBase58(),
    stockQty: big(a.stock_qty),
    tokensOutstanding: big(a.tokens_outstanding),
    hedgeRatioBps: num(a.hedge_ratio_bps),
    rebalanceToleranceBps: num(a.rebalance_tolerance_bps),
    hedgingEnabled: Boolean(a.hedging_enabled),
    lastNavPerToken: big(a.last_nav_per_token),
    lastNavTs: num(a.last_nav_ts),
  };
}

function shortMint(mint: string): string {
  return `Agent ${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/**
 * Read the `name` out of a Metaplex Token Metadata account.
 *
 * Doing it directly rather than through `@metaplex-foundation/*` is a
 * deliberate trade. The layout of the first three fields has been fixed since
 * v1 and is two lines to parse; the SDK is a dependency tree larger than the
 * rest of this interface's chain code put together, pulled in to read one
 * string.
 *
 * Layout: key (1) + update_authority (32) + mint (32) = 65, then the name as
 * a Borsh string. Metaplex pads it to `MAX_NAME_LENGTH`, so the trailing NULs
 * are expected and trimmed rather than treated as corruption.
 *
 * The account's address is derived in `pdas.ts`, with the rest of the seeds.
 */
const NAME_OFFSET = 1 + 32 + 32;

/** The `name` out of a Token Metadata account, or null if it is not one. */
export function decodeMetadataName(data: Buffer | Uint8Array): string | null {
  if (data.length < NAME_OFFSET + 4) return null;
  const len =
    data[NAME_OFFSET] |
    (data[NAME_OFFSET + 1] << 8) |
    (data[NAME_OFFSET + 2] << 16) |
    (data[NAME_OFFSET + 3] << 24);
  // A plausible length is the whole check. A wrong account type reaching here
  // reads some other field as a length, and anything outside this range says
  // so more reliably than any guess at the bytes that follow.
  if (len <= 0 || len > 64 || data.length < NAME_OFFSET + 4 + len) return null;
  const raw = new TextDecoder().decode(
    Uint8Array.from(data.slice(NAME_OFFSET + 4, NAME_OFFSET + 4 + len)),
  );
  const name = raw.replace(/\0+$/, "").trim();
  return name.length > 0 ? name : null;
}
