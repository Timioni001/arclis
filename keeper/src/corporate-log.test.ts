/**
 * The durable corporate-action log: a restart must not re-apply a split.
 */
import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import idl from "../../idl/arclis.json";
import { chainAppliedLog, corporateLogAddress, memoFor } from "./corporate";

const programId = new PublicKey((idl as { address: string }).address);

describe("chainAppliedLog", () => {
  it("finds an action applied before the restart, from its memo", async () => {
    const connection = {
      getSignaturesForAddress: vi.fn(async () => [
        { err: null, memo: `[27] ${memoFor("split-NVDA-2024-06-10")}` },
      ]),
    };
    const log = chainAppliedLog(connection, programId);
    expect(await log.has("split-NVDA-2024-06-10")).toBe(true);
    expect(connection.getSignaturesForAddress.mock.calls[0][0].equals(corporateLogAddress(programId))).toBe(true);
  });

  it("ignores failed transactions and other actions", async () => {
    const connection = {
      getSignaturesForAddress: vi.fn(async () => [
        { err: { InstructionError: [0, "Custom"] }, memo: memoFor("a") },
        { err: null, memo: memoFor("b") },
      ]),
    };
    const log = chainAppliedLog(connection, programId);
    expect(await log.has("a")).toBe(false);
    expect(await log.has("c")).toBe(false);
  });

  it("remembers what it recorded without asking the chain", async () => {
    const connection = { getSignaturesForAddress: vi.fn(async () => []) };
    const log = chainAppliedLog(connection, programId);
    await log.record("x");
    expect(await log.has("x")).toBe(true);
    expect(connection.getSignaturesForAddress).not.toHaveBeenCalled();
  });
});
