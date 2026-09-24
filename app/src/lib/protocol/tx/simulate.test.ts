/**
 * Simulation failures must say what went wrong. "This transaction would fail"
 * with no reason left a user on an open market with nothing to act on.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "./send";

const conn = (err: unknown, logs: string[] = []) =>
  ({ simulateTransaction: async () => ({ value: { err, logs } }) }) as never;

describe("simulate", () => {
  it("explains a wallet with no SOL", async () => {
    await expect(simulate(conn("AccountNotFound"), {} as never)).rejects.toThrow(/no devnet SOL/);
  });

  it("decodes a structured custom program error", async () => {
    await expect(
      simulate(conn({ InstructionError: [1, { Custom: 6000 }] }), {} as never),
    ).rejects.toThrow();
  });

  it("falls back to the RPC's own words, never a bare failure", async () => {
    await expect(
      simulate(conn({ InstructionError: [0, "InvalidAccountData"] }, ["Program log: something odd"]), {} as never),
    ).rejects.toThrow(/would fail: .*something odd/);
  });
});
