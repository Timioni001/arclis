/**
 * The book every visitor reads. The interface decodes these bytes with its own
 * decoders, so the snapshot must be the chain's bytes, keyed by the same
 * addresses the interface derives, and must never hand out an empty book
 * because one read failed.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import idl from "../../idl/arclis.json";
import { AccountSnapshot } from "./snapshot";
import { addressesFor } from "./cranks";
import { marketAddresses } from "../../app/src/lib/protocol/rpc/pdas";

const PROGRAM = new PublicKey((idl as { address: string }).address);
const SYMBOLS = Array.from({ length: 25 }, (_, i) => `S${i}`); // 125 accounts

/** A connection holding one byte per account: the account's index. */
function chain(opts: { missing?: Set<string>; fail?: boolean } = {}) {
  const calls: number[] = [];
  const connection = {
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => {
      if (opts.fail) throw new Error("429 Too Many Requests");
      calls.push(keys.length);
      return keys.map((k) =>
        opts.missing?.has(k.toBase58()) ? null : { data: Buffer.from(k.toBytes().subarray(0, 4)) },
      );
    }),
    getProgramAccounts: vi.fn(async () => [
      { pubkey: Keypair.generate().publicKey, account: { data: Buffer.from([1, 2, 3]) } },
    ]),
  };
  return { connection: connection as unknown as Connection, calls, raw: connection };
}

describe("AccountSnapshot", () => {
  it("reads every market's five accounts in chunks the RPC accepts", async () => {
    const { connection, calls } = chain();
    const book = new AccountSnapshot(connection, PROGRAM, SYMBOLS);
    await book.refresh();
    expect(calls).toEqual([100, 25]);
    const json = book.json();
    expect(Object.keys(json.accounts)).toHaveLength(125);
    expect(json.fetchedAt).toBeGreaterThan(0);
  });

  it("serves each account's bytes, base64, under its address", async () => {
    const { connection } = chain();
    const book = new AccountSnapshot(connection, PROGRAM, ["AAPL"]);
    await book.refresh();
    const oracle = addressesFor(PROGRAM, "AAPL").oracle;
    expect(Buffer.from(book.json().accounts[oracle.toBase58()]!, "base64")).toEqual(
      Buffer.from(oracle.toBytes().subarray(0, 4)),
    );
  });

  it("marks an account that does not exist as null, not as missing", async () => {
    const pool = addressesFor(PROGRAM, "AAPL").pool.toBase58();
    const { connection } = chain({ missing: new Set([pool]) });
    const book = new AccountSnapshot(connection, PROGRAM, ["AAPL"]);
    await book.refresh();
    expect(book.json().accounts).toHaveProperty(pool, null);
  });

  it("keeps the last good copy, and its age, when a read fails", async () => {
    const good = chain();
    const book = new AccountSnapshot(good.connection, PROGRAM, ["AAPL"]);
    await book.refresh();
    const before = book.json();
    (book as unknown as { connection: Connection }).connection = chain({ fail: true }).connection;
    await expect(book.refresh()).rejects.toThrow(/429/);
    expect(book.json()).toEqual(before);
  });

  it("scans treasuries by the IDL's discriminator", async () => {
    const { connection, raw } = chain();
    const book = new AccountSnapshot(connection, PROGRAM, []);
    await book.refreshTreasuries();
    const filter = (raw.getProgramAccounts.mock.calls[0] as unknown[])[1] as {
      filters: { memcmp: { offset: number } }[];
    };
    expect(filter.filters[0].memcmp.offset).toBe(0);
    expect(book.json().treasuries).toHaveLength(1);
    expect(book.json().treasuries[0].data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });
});

describe("the keeper and the interface derive the same addresses", () => {
  it("for every market the keeper serves", () => {
    for (const symbol of ["AAPL", "NVDAx", "DFDVx", "GOOGLx"]) {
      const k = addressesFor(PROGRAM, symbol);
      const a = marketAddresses(PROGRAM as never, symbol);
      expect(a.oracle.toBase58()).toBe(k.oracle.toBase58());
      expect(a.market.toBase58()).toBe(k.market.toBase58());
      expect(a.pool.toBase58()).toBe(k.pool.toBase58());
      expect(a.poolVault.toBase58()).toBe(k.poolVault.toBase58());
      expect(a.marketVault.toBase58()).toBe(k.marketVault.toBase58());
    }
  });
});
