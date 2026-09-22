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
  accountDiscriminator,
  decodeLpPosition,
  decodeMarket,
  decodeMetadataName,
  decodeOracle,
  decodePool,
  decodePosition,
  decodeTreasury,
  metadataPda,
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

  /*
   * Treasuries were the screen that showed nothing. The source returned a
   * hardcoded empty array behind a comment claiming they needed an indexer,
   * so no decoder existed to be wrong. These pin the one down before the
   * screen depends on it.
   */
  it("reads an agent treasury", async () => {
    const data = await enc("AgentTreasury", {
      authority: KEY,
      agent_mint: OTHER,
      stock_mint: KEY,
      market: OTHER,
      stock_vault: KEY,
      stock_qty: 12_500_000_000n,
      tokens_outstanding: 1_000_000_000_000n,
      hedge_ratio_bps: 9_000,
      rebalance_tolerance_bps: 250,
      hedging_enabled: true,
      last_nav_per_token: 1_234n,
      last_nav_ts: 1_800_000_000n,
      bump: 255,
      stock_vault_bump: 254,
      _reserved: Array(64).fill(0),
    });

    const t = decodeTreasury(KEY, data);
    expect(t.address).toBe(KEY.toBase58());
    expect(t.agentMint).toBe(OTHER.toBase58());
    expect(t.market).toBe(OTHER.toBase58());
    // Quantities the screen divides by, so `undefined` reaching them would be
    // NaN on the page rather than a thrown error.
    expect(t.stockQty).toBe(12_500_000_000n);
    expect(t.tokensOutstanding).toBe(1_000_000_000_000n);
    expect(t.hedgeRatioBps).toBe(9_000);
    expect(t.rebalanceToleranceBps).toBe(250);
    expect(t.hedgingEnabled).toBe(true);
    expect(t.lastNavTs).toBe(1_800_000_000);
  });

  it("names a treasury after its mint when metadata says nothing", async () => {
    const data = await enc("AgentTreasury", {
      authority: KEY,
      agent_mint: OTHER,
      stock_mint: KEY,
      market: OTHER,
      stock_vault: KEY,
      stock_qty: 0n,
      tokens_outstanding: 0n,
      hedge_ratio_bps: 0,
      rebalance_tolerance_bps: 0,
      hedging_enabled: false,
      last_nav_per_token: 0n,
      last_nav_ts: 0n,
      bump: 255,
      stock_vault_bump: 254,
      _reserved: Array(64).fill(0),
    });

    // Never blank: an unnamed agent still needs a heading on its card.
    expect(decodeTreasury(KEY, data).agentName).toContain(OTHER.toBase58().slice(0, 4));
    expect(decodeTreasury(KEY, data, { agentName: "Quant Alpha" }).agentName).toBe(
      "Quant Alpha",
    );
  });

  /*
   * The discriminator is the whole treasury scan. A wrong one is a `memcmp`
   * that matches nothing, so the screen goes back to being empty and says so
   * confidently, which is worse than the bug it replaced.
   */
  it("derives the treasury discriminator from the IDL's own name", () => {
    expect(accountDiscriminator("AgentTreasury")).toHaveLength(8);
    // The raw coder does not camelCase, and this is the spelling that has
    // cost this codebase four outages.
    expect(() => accountDiscriminator("agentTreasury")).toThrow();
  });
});

describe("token metadata", () => {
  /** A Metaplex metadata account, as far as the name field. */
  const withName = (name: string, pad = 32) => {
    const padded = Buffer.alloc(pad);
    Buffer.from(name, "utf8").copy(padded);
    const out = Buffer.alloc(1 + 32 + 32 + 4 + pad);
    out.writeUInt8(4, 0);
    KEY.toBuffer().copy(out, 1);
    OTHER.toBuffer().copy(out, 33);
    out.writeUInt32LE(pad, 65);
    padded.copy(out, 69);
    return out;
  };

  it("reads the name and trims Metaplex's NUL padding", () => {
    expect(decodeMetadataName(withName("Quant Alpha"))).toBe("Quant Alpha");
  });

  it("returns null rather than garbage for an account of another type", () => {
    // Zeroes read as a zero-length name; random bytes read as an absurd one.
    expect(decodeMetadataName(Buffer.alloc(200))).toBeNull();
    const bogus = Buffer.alloc(200, 0xff);
    expect(decodeMetadataName(bogus)).toBeNull();
  });

  it("returns null for an account too short to hold a name", () => {
    expect(decodeMetadataName(Buffer.alloc(10))).toBeNull();
  });

  it("derives the metadata PDA under the Metaplex program", () => {
    const pda = metadataPda(OTHER);
    expect(pda.toBase58()).toHaveLength(44);
    // Different mints, different accounts. A constant here would name every
    // agent after whichever one was launched first.
    expect(metadataPda(KEY).toBase58()).not.toBe(pda.toBase58());
  });
});
