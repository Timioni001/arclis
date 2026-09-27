/**
 * The send path, end to end against a scripted connection: what counts as a
 * busy network, what a busy network turns into, and a passkey-signed
 * transaction from simulation through confirmation.
 */
import { describe, expect, it, vi } from "vitest";
import { PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import { decodeProgramError, isBusy, sendInstructions, TransactionError } from "./send";
import { encodeBase58 } from "../../auth/base58";
import type { Session } from "../../auth/session";

async function passkey(): Promise<{ session: Session; address: PublicKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const address = new PublicKey(raw);
  return {
    address,
    session: {
      method: "passkey",
      address: address.toBase58(),
      label: "test",
      capability: "trading",
      sign: async (m) =>
        new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, m as BufferSource)),
    },
  };
}

const transfer = (from: PublicKey) =>
  SystemProgram.transfer({ fromPubkey: from, toPubkey: from, lamports: 1 });

const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 };

describe("isBusy", () => {
  it("recognises rate limits and dropped connections", () => {
    for (const m of [
      "failed to get recent blockhash: Error: 429 Too Many Requests",
      "Connection rate limits exceeded",
      "TypeError: Failed to fetch",
      "fetch failed",
      "Network Error",
      "read ECONNRESET",
      "request timed out",
    ]) {
      expect(isBusy(new Error(m))).toBe(true);
    }
  });

  it("leaves real failures alone", () => {
    expect(isBusy(new Error("custom program error: 0x177a"))).toBe(false);
    expect(isBusy(new Error("User rejected the request."))).toBe(false);
  });
});

describe("decodeProgramError", () => {
  it("reads an Anchor error by name when there is no code to match", () => {
    const d = decodeProgramError(null, [
      "Program log: AnchorError occurred. Error Code: CannotIncreaseRiskWhileClosed. Error Number: 6010. Error Message: Cannot increase risk while the underlying venue is closed; you can still reduce or close.",
    ]);
    expect(d?.name).toBe("CannotIncreaseRiskWhileClosed");
    expect(d?.message).toMatch(/you can still reduce or close/);
  });

  it("explains an expired blockhash in plain words", () => {
    expect(decodeProgramError("BlockhashNotFound", [])?.message).toMatch(/Try again/);
  });
});

describe("sendInstructions", () => {
  it("asks for a sign-in before anything else", async () => {
    const conn = { getLatestBlockhash: vi.fn() } as unknown as Connection;
    await expect(
      sendInstructions(
        { connection: conn, session: { method: "none", address: null, label: null, capability: "anonymous", sign: null } },
        [],
      ),
    ).rejects.toThrow(/Sign in/);
    expect(conn.getLatestBlockhash).not.toHaveBeenCalled();
  });

  it("retries a rate-limited blockhash, then says nothing was sent", async () => {
    const { session, address } = await passkey();
    const getLatestBlockhash = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
    const sendRawTransaction = vi.fn();
    const conn = { getLatestBlockhash, sendRawTransaction } as unknown as Connection;
    const err = await sendInstructions({ connection: conn, session }, [transfer(address)]).catch((e) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect(err.name).toBe("NetworkBusy");
    expect(err.message).toMatch(/nothing was sent/);
    expect(getLatestBlockhash).toHaveBeenCalledTimes(3);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  }, 10_000);

  it("recovers when the network answers on a retry", async () => {
    const { session, address } = await passkey();
    const conn = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getLatestBlockhash: vi
        .fn()
        .mockRejectedValueOnce(new Error("429 Too Many Requests"))
        .mockResolvedValue(BLOCKHASH),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
      sendRawTransaction: vi.fn().mockResolvedValue("sig"),
      getSignatureStatuses: vi
        .fn()
        .mockResolvedValue({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
      getBlockHeight: vi.fn().mockResolvedValue(1),
    } as unknown as Connection;
    const result = await sendInstructions({ connection: conn, session }, [transfer(address)]);
    expect(result.explorer).toContain("?cluster=devnet");
  }, 10_000);

  it("signs with a passkey, broadcasts, and reports the signature it signed", async () => {
    const { session, address } = await passkey();
    let raw: Uint8Array | null = null;
    const conn = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getLatestBlockhash: vi.fn().mockResolvedValue(BLOCKHASH),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
      sendRawTransaction: vi.fn(async (bytes: Uint8Array) => {
        raw = bytes;
        return "ignored";
      }),
      getSignatureStatuses: vi
        .fn()
        .mockResolvedValue({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
      getBlockHeight: vi.fn().mockResolvedValue(1),
    } as unknown as Connection;
    const result = await sendInstructions({ connection: conn, session }, [transfer(address)]);
    // The first signature in the wire format is the fee payer's.
    expect(result.signature).toBe(encodeBase58(raw!.subarray(1, 65)));
  }, 10_000);

  it("stops at simulation when the program would refuse, and sends nothing", async () => {
    const { session, address } = await passkey();
    const sendRawTransaction = vi.fn();
    const conn = {
      getLatestBlockhash: vi.fn().mockResolvedValue(BLOCKHASH),
      simulateTransaction: vi.fn().mockResolvedValue({
        value: { err: { InstructionError: [0, { Custom: 6010 }] }, logs: [] },
      }),
      sendRawTransaction,
    } as unknown as Connection;
    const err = await sendInstructions({ connection: conn, session }, [transfer(address)]).catch((e) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect(err.code).toBe(6010);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });
});
