/**
 * The account lists in `build.ts` are written by hand, positionally, against
 * `#[derive(Accounts)]` structs in another language. That is exactly the kind
 * of duplication that rots silently: reorder two fields in the Rust and every
 * transaction still *builds*, it just addresses the wrong accounts.
 *
 * So these tests check each builder against the IDL, which the build generates
 * from the Rust. Count, order, writability and signer flags all have to match.
 * A reordered struct now fails `npm test` instead of failing on devnet.
 */

import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import idl from "../../../idl/arclis.json";
import {
  cancelWithdrawLiquidity,
  closePosition,
  defundTreasuryHedge,
  depositStock,
  fundTreasuryHedge,
  initializeTreasury,
  rebalanceHedge,
  setTreasuryPolicy,
  treasuryAddresses,
  crankFunding,
  createMarket,
  depositCollateral,
  depositInsurance,
  depositLiquidity,
  liquidate,
  openPosition,
  requestWithdrawLiquidity,
  resolve,
  withdrawCollateral,
  withdrawLiquidity,
  type TradeContext,
} from "./build";
import { marketAddresses } from "../rpc/pdas";

/* eslint-disable @typescript-eslint/no-explicit-any */
const PROGRAM_ID = new PublicKey((idl as any).address);
const OWNER = new PublicKey("11111111111111111111111111111112");
const TOKEN_ACCOUNT = new PublicKey("11111111111111111111111111111113");
const MINT = new PublicKey("11111111111111111111111111111114");
const SYMBOL = "AAPL";

const ctx: TradeContext = {
  programId: PROGRAM_ID,
  owner: OWNER,
  symbol: SYMBOL,
};

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
}

function idlAccounts(instructionName: string): IdlAccount[] {
  const found = (idl as any).instructions.find(
    (i: any) => i.name === instructionName,
  );
  if (!found) throw new Error(`No instruction "${instructionName}" in the IDL`);
  return found.accounts;
}

/** Assert a built instruction matches the IDL's account list exactly. */
function expectMatchesIdl(
  instructionName: string,
  built: { keys: Array<{ isSigner: boolean; isWritable: boolean }> },
) {
  const expected = idlAccounts(instructionName);
  expect(
    built.keys.length,
    `${instructionName}: account count (IDL wants ${expected
      .map((a) => a.name)
      .join(", ")})`,
  ).toBe(expected.length);

  expected.forEach((want, i) => {
    const got = built.keys[i];
    expect(
      got.isWritable,
      `${instructionName}[${i}] ${want.name}: writable`,
    ).toBe(Boolean(want.writable));
    expect(got.isSigner, `${instructionName}[${i}] ${want.name}: signer`).toBe(
      Boolean(want.signer),
    );
  });
}

describe("instruction account lists match the IDL", () => {
  it("deposit_collateral", () => {
    expectMatchesIdl(
      "deposit_collateral",
      depositCollateral(ctx, TOKEN_ACCOUNT, 1_000_000n),
    );
  });

  it("withdraw_collateral", () => {
    expectMatchesIdl(
      "withdraw_collateral",
      withdrawCollateral(ctx, TOKEN_ACCOUNT, 1_000_000n),
    );
  });

  it("open_position", () => {
    expectMatchesIdl("open_position", openPosition(ctx, 5_000_000n));
  });

  it("close_position", () => {
    expectMatchesIdl("close_position", closePosition(ctx, 5_000_000n));
  });

  it("deposit_liquidity", () => {
    expectMatchesIdl(
      "deposit_liquidity",
      depositLiquidity(ctx, TOKEN_ACCOUNT, 1_000_000n),
    );
  });

  it("request_withdraw_liquidity", () => {
    expectMatchesIdl(
      "request_withdraw_liquidity",
      requestWithdrawLiquidity(ctx, TOKEN_ACCOUNT, 1_000_000n),
    );
  });

  it("cancel_withdraw_liquidity", () => {
    expectMatchesIdl(
      "cancel_withdraw_liquidity",
      cancelWithdrawLiquidity(ctx, TOKEN_ACCOUNT),
    );
  });

  it("withdraw_liquidity", () => {
    expectMatchesIdl(
      "withdraw_liquidity",
      withdrawLiquidity(ctx, TOKEN_ACCOUNT),
    );
  });

  it("crank_funding", () => {
    expectMatchesIdl("crank_funding", crankFunding(PROGRAM_ID, OWNER, SYMBOL));
  });

  it("liquidate", () => {
    expectMatchesIdl(
      "liquidate",
      liquidate(PROGRAM_ID, OWNER, TOKEN_ACCOUNT, SYMBOL, OWNER),
    );
  });

  it("deposit_insurance", () => {
    expectMatchesIdl(
      "deposit_insurance",
      depositInsurance(PROGRAM_ID, OWNER, TOKEN_ACCOUNT, SYMBOL, 1_000_000n),
    );
  });

  it("create_market", () => {
    expectMatchesIdl(
      "create_market",
      createMarket(PROGRAM_ID, OWNER, SYMBOL, MINT, {
        maxLeverage: 10,
        maintenanceMarginBps: 500,
        takerFeeBps: 10,
        liquidationPenaltyBps: 500,
        fundingIntervalSecs: 3600n,
        fundingSensitivityBps: 100,
        maxOpenInterest: 1_000_000_000_000n,
        maxSkewBps: 10_000,
        maxUtilizationBps: 8_000,
      }),
    );
  });
});

describe("the addresses each instruction actually points at", () => {
  it("sends every trading instruction to the same market and pool", () => {
    const a = resolve(ctx);
    const derived = marketAddresses(PROGRAM_ID, SYMBOL);
    expect(a.market.toBase58()).toBe(derived.market.toBase58());
    expect(a.pool.toBase58()).toBe(derived.pool.toBase58());

    // The pool in open_position must be the pool the market owns, or the
    // trader's PnL settles against someone else's capital.
    const open = openPosition(ctx, 1n);
    expect(open.keys[5].pubkey.toBase58()).toBe(derived.pool.toBase58());
    expect(open.keys[6].pubkey.toBase58()).toBe(derived.poolVault.toBase58());
    expect(open.keys[7].pubkey.toBase58()).toBe(derived.marketVault.toBase58());
  });

  it("names the owner as the only signer on a trade", () => {
    const open = openPosition(ctx, 1n);
    const signers = open.keys.filter((k) => k.isSigner);
    expect(signers).toHaveLength(1);
    expect(signers[0].pubkey.toBase58()).toBe(OWNER.toBase58());
  });

  it("never marks the oracle writable from a trading instruction", () => {
    // Only the keeper writes the oracle. A trading instruction that could
    // would be a trading instruction that can move the mark.
    const derived = marketAddresses(PROGRAM_ID, SYMBOL);
    for (const built of [
      openPosition(ctx, 1n),
      closePosition(ctx, 1n),
      depositCollateral(ctx, TOKEN_ACCOUNT, 1n),
      withdrawCollateral(ctx, TOKEN_ACCOUNT, 1n),
    ]) {
      const oracleKey = built.keys.find(
        (k) => k.pubkey.toBase58() === derived.oracle.toBase58(),
      );
      expect(oracleKey?.isWritable).toBe(false);
    }
  });

  it("derives a different position per market and per owner", () => {
    const other = resolve({ ...ctx, symbol: "NVDA" });
    const otherOwner = resolve({ ...ctx, owner: TOKEN_ACCOUNT });
    const mine = resolve(ctx);
    expect(mine.position.toBase58()).not.toBe(other.position.toBase58());
    expect(mine.position.toBase58()).not.toBe(otherOwner.position.toBase58());
  });

  it("passes the system and token programs where the IDL expects them", () => {
    const deposit = depositCollateral(ctx, TOKEN_ACCOUNT, 1n);
    expect(deposit.keys[7].pubkey.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(deposit.keys[8].pubkey.toBase58()).toBe(
      SystemProgram.programId.toBase58(),
    );
  });
});

describe("instruction data", () => {
  it("encodes a discriminator plus the argument", () => {
    const open = openPosition(ctx, 5_000_000n);
    // 8-byte Anchor discriminator + an i64.
    expect(open.data.length).toBe(16);
  });

  it("round-trips a size that overflows a JS number", () => {
    // Raw 1e6 units: this is about 9.2 billion whole units, past 2^53. The
    // builder must carry it exactly rather than through a float.
    const huge = 9_007_199_254_740_993n;
    const built = openPosition(ctx, huge);
    const encoded = built.data.subarray(8);
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(encoded[i]);
    expect(value).toBe(huge);
  });

  it("encodes a negative size as two's complement, for a short", () => {
    const built = openPosition(ctx, -5_000_000n);
    const encoded = built.data.subarray(8);
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(encoded[i]);
    // Reinterpret the unsigned bits as a signed 64-bit integer.
    const signed = value >= 1n << 63n ? value - (1n << 64n) : value;
    expect(signed).toBe(-5_000_000n);
  });
});

describe("agent treasury builders", () => {
  const AGENT = new PublicKey("11111111111111111111111111111115");
  const a = treasuryAddresses(PROGRAM_ID, SYMBOL, AGENT);

  it("match the IDL", () => {
    expectMatchesIdl(
      "initialize_treasury",
      initializeTreasury(PROGRAM_ID, OWNER, a, AGENT, MINT, 9000, 250),
    );
    expectMatchesIdl(
      "set_treasury_policy",
      setTreasuryPolicy(PROGRAM_ID, OWNER, a.treasury, 9000, 250, true, 1n),
    );
    expectMatchesIdl(
      "deposit_stock",
      depositStock(PROGRAM_ID, OWNER, a, TOKEN_ACCOUNT, 1n),
    );
    expectMatchesIdl(
      "fund_treasury_hedge",
      fundTreasuryHedge(PROGRAM_ID, OWNER, a, TOKEN_ACCOUNT, 1n),
    );
    expectMatchesIdl(
      "defund_treasury_hedge",
      defundTreasuryHedge(PROGRAM_ID, OWNER, a, TOKEN_ACCOUNT, 1n),
    );
    expectMatchesIdl("rebalance_hedge", rebalanceHedge(PROGRAM_ID, OWNER, a));
  });

  it("derives the treasury's position from the treasury, not the signer", () => {
    const built = fundTreasuryHedge(PROGRAM_ID, OWNER, a, TOKEN_ACCOUNT, 1n);
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), a.treasury.toBuffer(), a.market.toBuffer()],
      PROGRAM_ID,
    );
    expect(built.keys[5].pubkey.equals(position)).toBe(true);
  });
});
