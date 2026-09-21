/**
 * Decode real account bytes, not imagined ones.
 *
 * Nothing exercised these decoders, and two things were wrong in a way no
 * amount of reading would have shown. The account names were camelCase
 * (`"market"`), which the IDL does not contain, so every decode threw
 * `Unknown account` - caught by `refresh()`, recorded as an error, and
 * rendered as an interface with no markets. The field reads were camelCase
 * too, against a coder that returns the IDL's snake_case, so every value
 * would have come back `undefined` even once the names were fixed.
 *
 * Both are invisible to types: the coder returns `any`. They are only visible
 * to bytes, so these tests encode with the same coder the program's IDL
 * describes and read the result back.
 */

import { BN, BorshCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import ARCLIS_IDL from "../../../idl/arclis.json";
import {
  decodeLpPosition,
  decodeMarket,
  decodeOracle,
  decodePool,
  decodePosition,
} from "./decode";

/* eslint-disable @typescript-eslint/no-explicit-any */
const coder = new BorshCoder(ARCLIS_IDL as any);
const KEY = new PublicKey("BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP");
const OTHER = new PublicKey("8nMZjpyLpGGtnCkdCotT8jWUDUpSnJeVjeuazyYVvqGu");

const symbolBytes = (s: string) => {
  const b = Buffer.alloc(16);
  Buffer.from(s, "utf8").copy(b);
  return Array.from(b);
};

/**
 * The coder encodes from `BN`, not from native bigints, while it decodes to
 * whatever the decoder converts. So fixtures are written as bigints for
 * readability and converted on the way in; the assertions compare bigints,
 * which is what the interface actually receives.
 */
const bn = (v: bigint) => new BN(v.toString());

function toBn<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = typeof v === "bigint" ? bn(v) : v;
  }
  return out as T;
}

const enc = (name: string, value: Record<string, unknown>) =>
  coder.accounts.encode(name, toBn(value) as any);

describe("account decoding", () => {
  it("reads an oracle, including the fields the interface prices from", async () => {
    const data = await enc("PriceOracle", {
      authority: KEY,
      symbol: symbolBytes("AAPL"),
      price: 228_500_000n,
      confidence: 1_000n,
      last_update_ts: 1_800_000_000n,
      update_slot: 42n,
      session: { Open: {} },
      session_updated_ts: 1_800_000_001n,
      split_factor: 1_000_000_000n,
      corporate_action_seq: 3,
      bump: 254,
      _reserved: Array(32).fill(0),
    });

    const o = decodeOracle(KEY, data, { name: "Apple Inc." });
    expect(o.symbol).toBe("AAPL");
    expect(o.name).toBe("Apple Inc.");
    expect(o.price).toBe(228_500_000n);
    expect(o.lastUpdateTs).toBe(1_800_000_000);
    expect(o.sessionUpdatedTs).toBe(1_800_000_001);
    expect(o.splitFactor).toBe(1_000_000_000n);
    expect(o.corporateActionSeq).toBe(3);
  });

  it("reads a market, including every risk and solvency field", async () => {
    const data = await enc("Market", {
      oracle: KEY,
      vault: OTHER,
      creator: KEY,
      vault_bump: 253,
      bump: 254,
      paused: false,
      max_leverage: 10,
      maintenance_margin_bps: 500,
      initial_margin_bps: 600,
      taker_fee_bps: 10,
      liquidation_penalty_bps: 500,
      funding_sensitivity_bps: 100,
      funding_interval_secs: 3_600n,
      last_funding_ts: 1_800_000_000n,
      cumulative_funding_index: 12n,
      cumulative_dividend_index: 7n,
      open_interest_long: 50_000_000n,
      open_interest_short: 20_000_000n,
      long_entry_notional: 11_425_000_000n,
      short_entry_notional: 8_255_000_000n,
      max_open_interest: 1_000_000_000_000n,
      max_skew_bps: 10_000,
      max_utilization_bps: 8_000,
      liquidity_pool: OTHER,
      total_collateral: 25_000_000_000n,
      insurance_balance: 5_000_000n,
      bad_debt: 0n,
      _reserved: Array(64).fill(0),
    });

    const m = decodeMarket(KEY, data);
    expect(m.liquidityPool).toBe(OTHER.toBase58());
    expect(m.maxLeverage).toBe(10);
    expect(m.maintenanceMarginBps).toBe(500);
    expect(m.initialMarginBps).toBe(600);
    expect(m.takerFeeBps).toBe(10);
    expect(m.liquidationPenaltyBps).toBe(500);
    expect(m.fundingSensitivityBps).toBe(100);
    expect(m.fundingIntervalSecs).toBe(3_600);
    expect(m.lastFundingTs).toBe(1_800_000_000);
    expect(m.cumulativeFundingIndex).toBe(12n);
    expect(m.openInterestLong).toBe(50_000_000n);
    expect(m.openInterestShort).toBe(20_000_000n);
    expect(m.longEntryNotional).toBe(11_425_000_000n);
    expect(m.shortEntryNotional).toBe(8_255_000_000n);
    expect(m.maxOpenInterest).toBe(1_000_000_000_000n);
    expect(m.maxSkewBps).toBe(10_000);
    expect(m.maxUtilizationBps).toBe(8_000);
    expect(m.totalCollateral).toBe(25_000_000_000n);
    expect(m.insuranceBalance).toBe(5_000_000n);
    expect(m.badDebt).toBe(0n);
  });

  it("reads a position", async () => {
    const data = await enc("Position", {
      owner: KEY,
      market: OTHER,
      size: 50_000_000n,
      entry_price: 228_500_000n,
      collateral: 10_000_000_000n,
      entry_funding_index: 5n,
      last_update_ts: 1_800_000_000n,
      entry_split_factor: 1_000_000_000n,
      entry_dividend_index: 2n,
      bump: 254,
      _reserved: Array(8).fill(0),
    });

    const p = decodePosition(KEY, data);
    expect(p.size).toBe(50_000_000n);
    expect(p.entryPrice).toBe(228_500_000n);
    expect(p.collateral).toBe(10_000_000_000n);
    expect(p.entryFundingIndex).toBe(5n);
    expect(p.entrySplitFactor).toBe(1_000_000_000n);
    expect(p.lastUpdateTs).toBe(1_800_000_000);
  });

  it("reads a pool, and takes the vault balance from the vault", async () => {
    const data = await enc("LiquidityPool", {
      market: KEY,
      vault: OTHER,
      quote_mint: OTHER,
      authority: KEY,
      total_shares: 500_000_000_000n,
      principal: 500_000_000_000n,
      realized_pnl: -1_250_000n,
      absorbed_bad_debt: 0n,
      cooldown_secs: 3_600n,
      pending_shares: 0n,
      deposits_paused: false,
      bump: 254,
      vault_bump: 253,
      _reserved: Array(64).fill(0),
    });

    const pool = decodePool(KEY, data, 499_998_750_000n);
    expect(pool.totalShares).toBe(500_000_000_000n);
    expect(pool.realizedPnl).toBe(-1_250_000n);
    expect(pool.absorbedBadDebt).toBe(0n);
    expect(pool.cooldownSecs).toBe(3_600);
    expect(pool.depositsPaused).toBe(false);
    // Not from the account: NAV is defined against what the vault holds.
    expect(pool.vaultBalance).toBe(499_998_750_000n);
  });

  it("reads an LP position", async () => {
    const data = await enc("LpPosition", {
      owner: KEY,
      pool: OTHER,
      shares: 500_000_000_000n,
      pending_shares: 1_000n,
      cooldown_ends_ts: 1_800_003_600n,
      last_deposit_ts: 1_800_000_000n,
      bump: 254,
      _reserved: Array(32).fill(0),
    });

    const lp = decodeLpPosition(KEY, data);
    expect(lp.shares).toBe(500_000_000_000n);
    expect(lp.pendingShares).toBe(1_000n);
    expect(lp.cooldownEndsTs).toBe(1_800_003_600);
    expect(lp.lastDepositTs).toBe(1_800_000_000);
  });
});
