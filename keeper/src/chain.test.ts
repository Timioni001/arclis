/**
 * Sending, against a scripted RPC with no websocket support at all.
 *
 * Confirmation used to wait on `signatureSubscribe`, which some providers
 * (Alchemy's Solana endpoint among them) do not offer. Every transaction then
 * waited out its blockhash, the price loop stalled, the health check went to
 * 503 and the keeper stopped answering. Confirmation is now polled over plain
 * HTTP, which every RPC supports.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, SystemProgram, type Connection } from "@solana/web3.js";
import { programError, send, type ChainConfig } from "./chain";

const payer = Keypair.generate();
const ix = () => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 });

function rpc(over: Record<string, unknown> = {}) {
  const connection = {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 })),
    sendRawTransaction: vi.fn(async () => "sig"),
    getSignatureStatuses: vi.fn(async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] })),
    getBlockHeight: vi.fn(async () => 50),
    // Any websocket subscription is a failure of this test.
    onSignature: vi.fn(() => { throw new Error("websocket used"); }),
    ...over,
  };
  const log = vi.fn();
  const config = { connection: connection as unknown as Connection, payer, log, programId: payer.publicKey } as unknown as ChainConfig;
  return { connection, config, log };
}

describe("send", () => {
  it("confirms by polling, never by subscription", async () => {
    const { connection, config } = rpc();
    const out = await send(config, [ix()], "test");
    expect(out.ok).toBe(true);
    expect(connection.getSignatureStatuses).toHaveBeenCalled();
    expect(connection.onSignature).not.toHaveBeenCalled();
  });

  it("keeps polling through a rate-limited status check", async () => {
    const { config } = rpc({
      getSignatureStatuses: vi
        .fn()
        .mockRejectedValueOnce(new Error("429 Too Many Requests"))
        .mockResolvedValue({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
    });
    expect((await send(config, [ix()], "test")).ok).toBe(true);
  });

  it("names a program rejection seen at confirmation, and does not retry it", async () => {
    const { connection, config } = rpc({
      getSignatureStatuses: vi.fn(async () => ({
        value: [{ err: { InstructionError: [0, { Custom: 6010 }] }, confirmationStatus: "confirmed" }],
      })),
    });
    const out = await send(config, [ix()], "test");
    expect(out).toMatchObject({ ok: false, rejected: true, error: "CannotIncreaseRiskWhileClosed", benign: true });
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("gives up on an expired blockhash and tries again with a fresh one", async () => {
    let height = 50;
    const { connection, config } = rpc({
      getSignatureStatuses: vi.fn(async () => ({ value: [height > 100 ? null : null] })),
      getBlockHeight: vi.fn(async () => (height += 60)),
    });
    const out = await send(config, [ix()], "test", 2);
    expect(out.ok).toBe(false);
    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(2);
  }, 20_000);
});

describe("programError", () => {
  it("reads the structured form a status poll returns", () => {
    expect(programError(new Error('failed ({"InstructionError":[0,{"Custom":6010}]})'))).toBe("CannotIncreaseRiskWhileClosed");
  });
});
