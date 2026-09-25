/**
 * Simulation failures must say what went wrong. "This transaction would fail"
 * with no reason left a user on an open market with nothing to act on.
 */
import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { simulate } from "./send";

/** A real, compilable transaction; the connection below never sends it. */
function tx(): Transaction {
  const payer = new PublicKey("11111111111111111111111111111112");
  const t = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }),
  );
  t.feePayer = payer;
  t.recentBlockhash = "11111111111111111111111111111111";
  return t;
}

const conn = (err: unknown, logs: string[] = []) =>
  ({ simulateTransaction: async () => ({ value: { err, logs } }) }) as never;

describe("simulate", () => {
  it("checks against the cluster's latest blockhash, so a lagging node cannot fail it", async () => {
    let opts: Record<string, unknown> | undefined;
    const connection = {
      simulateTransaction: async (_t: unknown, o: Record<string, unknown>) => {
        opts = o;
        return { value: { err: null, logs: [] } };
      },
    } as never;
    await simulate(connection, tx());
    expect(opts).toMatchObject({
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
  });

  it("explains a wallet with no SOL", async () => {
    await expect(simulate(conn("AccountNotFound"), tx())).rejects.toThrow(
      /no devnet SOL/,
    );
  });

  it("decodes a structured custom program error", async () => {
    await expect(
      simulate(conn({ InstructionError: [1, { Custom: 6000 }] }), tx()),
    ).rejects.toThrow();
  });

  it("falls back to the RPC's own words, never a bare failure", async () => {
    await expect(
      simulate(
        conn({ InstructionError: [0, "InvalidAccountData"] }, [
          "Program log: something odd",
        ]),
        tx(),
      ),
    ).rejects.toThrow(/would fail: .*something odd/);
  });
});

import { vi } from "vitest";
import { broadcastUntilConfirmed } from "./send";

describe("broadcastUntilConfirmed", () => {
  it("re-sends until the cluster confirms", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const connection = {
      sendRawTransaction: vi.fn(async () => "sig"),
      getSignatureStatuses: vi.fn(async () => ({
        value: [
          ++polls < 3 ? null : { err: null, confirmationStatus: "confirmed" },
        ],
      })),
      getBlockHeight: vi.fn(async () => 10),
    };
    const done = broadcastUntilConfirmed(
      connection as never,
      new Uint8Array(1),
      "sig",
      100,
    );
    await vi.runAllTimersAsync();
    await expect(done).resolves.toEqual({ value: { err: null } });
    expect(connection.sendRawTransaction.mock.calls.length).toBeGreaterThan(1);
    vi.useRealTimers();
  });

  it("says plainly that nothing happened when the blockhash expires", async () => {
    vi.useFakeTimers();
    const connection = {
      sendRawTransaction: vi.fn(async () => "sig"),
      getSignatureStatuses: vi.fn(async () => ({ value: [null] })),
      getBlockHeight: vi.fn(async () => 200),
    };
    const done = broadcastUntilConfirmed(
      connection as never,
      new Uint8Array(1),
      "sig",
      100,
    );
    const check = expect(done).rejects.toThrow(/nothing was charged/);
    await vi.runAllTimersAsync();
    await check;
    vi.useRealTimers();
  });
});
