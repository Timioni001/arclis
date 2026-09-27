/**
 * The funding crank's choice of markets. The program settles funding only on
 * a market that is due and open; every other send is one it refuses, and
 * overnight that was thirty refused transactions every five minutes against
 * the endpoint the price publisher needs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BN, BorshCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import idl from "../../idl/arclis.json";

const sent: string[] = [];
vi.mock("./chain", async (orig) => ({
  ...(await orig<typeof import("./chain")>()),
  send: vi.fn(async (_config: unknown, _ixs: unknown, label: string) => {
    sent.push(label);
    return { ok: true, signature: "sig" };
  }),
}));

import { addressesFor, crankFunding } from "./cranks";

const coder = new BorshCoder(idl as never);
const PROGRAM = new PublicKey((idl as { address: string }).address);
const KEY = Keypair.generate().publicKey;
const NOW = Math.floor(Date.now() / 1000);

async function oracle(session: "Open" | "Closed") {
  return coder.accounts.encode("PriceOracle", {
    authority: KEY,
    symbol: Array(16).fill(0),
    price: new BN(100_000_000),
    confidence: new BN(0),
    last_update_ts: new BN(NOW),
    update_slot: new BN(1),
    session: { [session]: {} },
    session_updated_ts: new BN(NOW),
    split_factor: new BN(1_000_000_000),
    corporate_action_seq: 0,
    bump: 255,
    _reserved: Array(32).fill(0),
  } as never);
}

async function market(lastFundingTs: number) {
  return coder.accounts.encode("Market", {
    oracle: KEY, vault: KEY, creator: KEY, vault_bump: 1, bump: 1, paused: false,
    max_leverage: 10, maintenance_margin_bps: 500, initial_margin_bps: 600, taker_fee_bps: 10,
    liquidation_penalty_bps: 500, funding_sensitivity_bps: 100,
    funding_interval_secs: new BN(3600), last_funding_ts: new BN(lastFundingTs),
    cumulative_funding_index: new BN(0), cumulative_dividend_index: new BN(0),
    open_interest_long: new BN(0), open_interest_short: new BN(0),
    long_entry_notional: new BN(0), short_entry_notional: new BN(0),
    max_open_interest: new BN(1), max_skew_bps: 10_000, max_utilization_bps: 8_000,
    liquidity_pool: KEY, total_collateral: new BN(0), insurance_balance: new BN(0), bad_debt: new BN(0),
    _reserved: Array(64).fill(0),
  } as never);
}

async function config(book: Record<string, { session: "Open" | "Closed"; lastFundingTs: number }>) {
  const accounts = new Map<string, Buffer>();
  for (const [symbol, m] of Object.entries(book)) {
    const a = addressesFor(PROGRAM, symbol);
    accounts.set(a.oracle.toBase58(), await oracle(m.session));
    accounts.set(a.market.toBase58(), await market(m.lastFundingTs));
  }
  const connection = {
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) =>
      keys.map((k) => (accounts.has(k.toBase58()) ? { data: accounts.get(k.toBase58())! } : null)),
    ),
  };
  return {
    connection: connection as unknown as Connection,
    programId: PROGRAM,
    payer: Keypair.generate(),
    log: () => {},
  } as never;
}

beforeEach(() => {
  sent.length = 0;
});

describe("crankFunding", () => {
  it("sends only for a market that is both due and open", async () => {
    const result = await crankFunding(
      await config({
        DUE: { session: "Open", lastFundingTs: NOW - 7200 },
        SHUT: { session: "Closed", lastFundingTs: NOW - 7200 },
        EARLY: { session: "Open", lastFundingTs: NOW - 60 },
      }),
      ["DUE", "SHUT", "EARLY"],
    );
    expect(sent).toEqual(["crank_funding DUE"]);
    expect(result.cranked).toEqual(["DUE"]);
    expect(result.notDue.sort()).toEqual(["EARLY", "SHUT"]);
  });

  it("still tries a market whose accounts it could not read; the program is the judge", async () => {
    await crankFunding(await config({}), ["UNKNOWN"]);
    expect(sent).toEqual(["crank_funding UNKNOWN"]);
  });
});
