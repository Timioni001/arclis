/**
 * The treasury scan.
 *
 * `treasuries()` returned a hardcoded empty array for the whole of this
 * project's life, behind a comment asserting that treasuries could only be
 * found by indexing an event stream. The assertion was wrong: `AgentTreasury`
 * is an account, and accounts of one type are enumerable by their Anchor
 * discriminator. Nothing caught it because nothing tested a reader that was
 * doing exactly what it said it did.
 *
 * So these tests are against a fake connection rather than a chain. What they
 * pin is the part that was wrong, which is not the decoding - that has its own
 * tests - but the wiring: that a scan happens at all, that its result reaches
 * the reader, that the treasury's own hedge position is fetched under the
 * treasury rather than under the signed-in wallet, and that the two ways this
 * screen can silently empty itself again both fail closed.
 */

import { BN, BorshCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ARCLIS_IDL from "../../../idl/arclis.json";
import { rpcSource, TREASURY_RESCAN_EVERY } from "./source";
import { metadataPda } from "./decode";
import { marketAddresses, positionPda } from "./pdas";

/* eslint-disable @typescript-eslint/no-explicit-any */
const coder = new BorshCoder(ARCLIS_IDL as any);

const PROGRAM = new PublicKey("BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP");
const AGENT_MINT = new PublicKey("8nMZjpyLpGGtnCkdCotT8jWUDUpSnJeVjeuazyYVvqGu");
const TREASURY = new PublicKey("11111111111111111111111111111112");
const MARKET = marketAddresses(PROGRAM, "AAPL").market;

const bn = (v: bigint) => new BN(v.toString());

async function treasuryBytes(over: Record<string, unknown> = {}) {
  return coder.accounts.encode("AgentTreasury", {
    authority: PROGRAM,
    agent_mint: AGENT_MINT,
    stock_mint: PROGRAM,
    market: MARKET,
    stock_vault: PROGRAM,
    stock_qty: bn(12_500_000_000n),
    tokens_outstanding: bn(1_000_000_000_000n),
    hedge_ratio_bps: 9_000,
    rebalance_tolerance_bps: 250,
    hedging_enabled: true,
    last_nav_per_token: bn(1_234n),
    last_nav_ts: bn(1_800_000_000n),
    bump: 255,
    stock_vault_bump: 254,
    _reserved: Array(64).fill(0),
    ...over,
  } as any);
}

async function positionBytes() {
  return coder.accounts.encode("Position", {
    owner: TREASURY,
    market: MARKET,
    size: bn(-5_000_000_000n),
    entry_price: bn(200_000_000n),
    collateral: bn(50_000_000n),
    entry_funding_index: bn(0n),
    last_funding_ts: bn(1_800_000_000n),
    bump: 255,
    _reserved: Array(32).fill(0),
  } as any);
}

/** A Metaplex metadata account carrying one name. */
function metadataBytes(name: string) {
  const pad = Buffer.alloc(32);
  Buffer.from(name, "utf8").copy(pad);
  const out = Buffer.alloc(69 + 32);
  out.writeUInt8(4, 0);
  out.writeUInt32LE(32, 65);
  pad.copy(out, 69);
  return out;
}

interface FakeOptions {
  treasuries?: { pubkey: PublicKey; data: Buffer }[];
  accounts?: Map<string, Buffer>;
  scanFails?: boolean;
}

/**
 * A connection that answers only the calls this source makes.
 *
 * `getSignaturesForAddress` returns nothing so the price backfill is a no-op:
 * it is tested in `history.test.ts` and failing it here would test the catch
 * rather than the scan.
 */
function fakeConnection(opts: FakeOptions = {}) {
  const accounts = opts.accounts ?? new Map<string, Buffer>();
  const scans = { count: 0 };
  const connection = {
    getProgramAccounts: vi.fn(async () => {
      scans.count += 1;
      if (opts.scanFails) throw new Error("429 Too Many Requests");
      return (opts.treasuries ?? []).map(({ pubkey, data }) => ({
        pubkey,
        account: { data },
      }));
    }),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) =>
      keys.map((k) => {
        const data = accounts.get(k.toBase58());
        return data ? { data } : null;
      }),
    ),
    getSignaturesForAddress: vi.fn(async () => []),
    getParsedTransactions: vi.fn(async () => []),
  };
  return { connection: connection as unknown as Connection, scans };
}

function source(connection: Connection) {
  return rpcSource({
    endpoint: "http://fake",
    programId: PROGRAM,
    symbols: ["AAPL"],
    connection,
  });
}

describe("treasury scan", () => {
  let treasury: Buffer;
  let position: Buffer;

  beforeEach(async () => {
    treasury = await treasuryBytes();
    position = await positionBytes();
  });

  it("finds treasuries the program owns", async () => {
    const { connection } = fakeConnection({
      treasuries: [{ pubkey: TREASURY, data: treasury }],
    });
    const s = source(connection);
    await s.refresh();

    // The assertion that matters: not zero. This reader returned an empty
    // array unconditionally before, and did so without failing.
    expect(s.treasuries()).toHaveLength(1);
    expect(s.treasuries()[0].address).toBe(TREASURY.toBase58());
    expect(s.treasuries()[0].stockQty).toBe(12_500_000_000n);
  });

  it("reads the hedge position owned by the treasury, not by the wallet", async () => {
    const hedge = positionPda(PROGRAM, TREASURY, MARKET);
    const accounts = new Map([[hedge.toBase58(), position]]);
    const { connection } = fakeConnection({
      treasuries: [{ pubkey: TREASURY, data: treasury }],
      accounts,
    });
    const s = source(connection);
    await s.refresh();

    // A short. The whole screen is about the hedge being on, so a position
    // fetched under the wrong owner reads as an agent that never hedged.
    expect(s.treasuryPosition(TREASURY.toBase58())?.size).toBe(-5_000_000_000n);
  });

  it("names an agent from its token metadata when there is any", async () => {
    const accounts = new Map([
      [metadataPda(AGENT_MINT).toBase58(), metadataBytes("Quant Alpha")],
    ]);
    const { connection } = fakeConnection({
      treasuries: [{ pubkey: TREASURY, data: treasury }],
      accounts,
    });
    const s = source(connection);
    await s.refresh();

    expect(s.treasuries()[0].agentName).toBe("Quant Alpha");
  });

  it("falls back to the mint when the agent token has no metadata", async () => {
    const { connection } = fakeConnection({
      treasuries: [{ pubkey: TREASURY, data: treasury }],
    });
    const s = source(connection);
    await s.refresh();

    expect(s.treasuries()[0].agentName).toContain(
      AGENT_MINT.toBase58().slice(0, 4),
    );
  });

  it("scans once and then only every TREASURY_RESCAN_EVERY refreshes", async () => {
    const { connection, scans } = fakeConnection({
      treasuries: [{ pubkey: TREASURY, data: treasury }],
    });
    const s = source(connection);

    // getProgramAccounts is the heaviest call a public endpoint serves and
    // the first one it rate limits, so a scan on every thirty-second poll is
    // how this interface loses its own RPC quota during a demo.
    for (let i = 0; i < TREASURY_RESCAN_EVERY; i++) await s.refresh();
    expect(scans.count).toBe(1);

    await s.refresh();
    expect(scans.count).toBe(2);
  });

  it("keeps the treasuries it already found when a scan fails", async () => {
    const opts: FakeOptions = {
      treasuries: [{ pubkey: TREASURY, data: treasury }],
    };
    const { connection } = fakeConnection(opts);
    const s = source(connection);
    await s.refresh();
    expect(s.treasuries()).toHaveLength(1);

    // A rate limit on the next scan must not empty a screen that was
    // populated a moment ago: a blank list reads as "no agents exist".
    opts.scanFails = true;
    for (let i = 0; i < TREASURY_RESCAN_EVERY; i++) await s.refresh();
    expect(s.treasuries()).toHaveLength(1);
  });

  it("keeps treasuries across a sign-in, because they are not the signer's", async () => {
    const { connection } = fakeConnection({
      treasuries: [{ pubkey: TREASURY, data: treasury }],
    });
    const s = source(connection);
    await s.refresh();

    s.setOwner(AGENT_MINT.toBase58());
    expect(s.treasuries()).toHaveLength(1);
    s.setOwner(null);
    expect(s.treasuries()).toHaveLength(1);
  });

  it("drops one unreadable treasury rather than the whole scan", async () => {
    const { connection } = fakeConnection({
      treasuries: [
        { pubkey: TREASURY, data: Buffer.alloc(16) },
        { pubkey: AGENT_MINT, data: treasury },
      ],
    });
    const s = source(connection);
    await s.refresh();

    expect(s.treasuries()).toHaveLength(1);
    expect(s.treasuries()[0].address).toBe(AGENT_MINT.toBase58());
  });
});
