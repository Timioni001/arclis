/**
 * The event indexer: decoding events out of logs, and the polling contract.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BN, BorshCoder, EventParser } from "@coral-xyz/anchor";
import idl from "../../idl/arclis.json";
import { EventIndexer, eventsFromLogs, marketAddress, plain } from "./indexer";

const programId = new PublicKey((idl as { address: string }).address);
const coder = new BorshCoder(idl as never);
const events = (idl as { events: { name: string; discriminator: number[] }[] }).events;

function logsFor(name: string, data: Record<string, unknown>): string[] {
  const disc = Buffer.from(events.find((e) => e.name === name)!.discriminator);
  const body = coder.types.encode(name, data);
  const id = programId.toBase58();
  return [
    `Program ${id} invoke [1]`,
    `Program data: ${Buffer.concat([disc, body]).toString("base64")}`,
    `Program ${id} success`,
  ];
}

const { market } = marketAddress(programId, "AAPL");
const owner = Keypair.generate().publicKey;
const opened = {
  market,
  owner,
  size_delta: new BN(2_000_000),
  size_after: new BN(2_000_000),
  fill_price: new BN(168_160_000),
  entry_price_after: new BN(168_160_000),
  fee: new BN(300_000),
  funding_settled: new BN(0),
  dividends_settled: new BN(0),
};

describe("eventsFromLogs", () => {
  const parser = new EventParser(programId, coder);
  const symbolOf = (a: string) => (a === market.toBase58() ? "AAPL" : null);

  it("decodes an event, tags its market and makes it JSON-safe", () => {
    const [ev] = eventsFromLogs(parser, logsFor("PositionOpened", opened), "sig", 100, symbolOf);
    expect(ev).toMatchObject({ id: "sig:0", kind: "PositionOpened", symbol: "AAPL", ts: 100 });
    expect(ev.data.fill_price).toBe("168160000");
    expect(ev.data.owner).toBe(owner.toBase58());
    expect(() => JSON.stringify(ev)).not.toThrow();
  });

  it("drops funding cranks as noise", () => {
    const logs = logsFor("FundingAccrued", {
      market, cranker: owner, skew_bps: new BN(0), rate_bps: new BN(0),
      intervals: new BN(1), mark_price: new BN(1), index_after: new BN(0), utilization_bps: new BN(0),
    });
    expect(eventsFromLogs(parser, logs, "sig", 1, symbolOf)).toHaveLength(0);
  });
});

describe("plain", () => {
  it("names an enum variant", () => {
    expect(plain({ closed: {} })).toBe("closed");
  });
});

describe("EventIndexer", () => {
  it("backfills, then asks only for what is newer", async () => {
    const connection = {
      getSignaturesForAddress: vi.fn(async (_a: PublicKey, o: { until?: string }) =>
        o.until ? [] : [{ signature: "s1", err: null, blockTime: 50 }]),
      getTransactions: vi.fn(async () => [
        { blockTime: 50, meta: { logMessages: logsFor("PositionOpened", opened) } },
      ]),
    };
    const ix = new EventIndexer(connection as never, programId, ["AAPL"]);
    expect(await ix.poll()).toBe(1);
    expect(ix.list({ symbol: "AAPL" })[0].kind).toBe("PositionOpened");
    expect(await ix.poll()).toBe(0);
    expect(connection.getSignaturesForAddress.mock.calls[1][1]).toMatchObject({ until: "s1" });
  });
});
