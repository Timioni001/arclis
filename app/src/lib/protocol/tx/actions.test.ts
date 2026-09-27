/**
 * The actions' own reads, before anything is signed, must fail the same way
 * the send path does: a busy network says so, and nothing is sent.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { withdrawCollateral, withdrawLiquidity } from "./actions";
import { passkeySession } from "../../auth/session";

const owner = Keypair.generate().publicKey.toBase58();
const session = passkeySession(
  { address: owner, credentialId: "x", wrappedKey: "x", iv: "x", createdAt: 0 },
  async () => new Uint8Array(64),
);

function ctx(getAccountInfo: () => Promise<unknown>) {
  const sendRawTransaction = vi.fn();
  const getLatestBlockhash = vi.fn();
  return {
    sent: sendRawTransaction,
    blockhash: getLatestBlockhash,
    action: {
      connection: { getAccountInfo, sendRawTransaction, getLatestBlockhash } as unknown as Connection,
      session,
      programId: new PublicKey("BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP"),
      quoteMint: new PublicKey("8nMZjpyLpGGtnCkdCotT8jWUDUpSnJeVjeuazyYVvqGu"),
      symbol: "AAPL",
    },
  };
}

describe("withdrawals on a busy network", () => {
  for (const [name, run] of [
    ["collateral", (a: ReturnType<typeof ctx>["action"]) => withdrawCollateral(a, 1_000_000n)],
    ["liquidity", (a: ReturnType<typeof ctx>["action"]) => withdrawLiquidity(a)],
  ] as const) {
    it(`${name}: says the network is busy, not "429", and sends nothing`, async () => {
      const c = ctx(vi.fn().mockRejectedValue(new Error("429 Too Many Requests")));
      const err = await run(c.action).catch((e) => e);
      expect(err.name).toBe("NetworkBusy");
      expect(err.message).toMatch(/nothing was sent/);
      expect(c.blockhash).not.toHaveBeenCalled();
      expect(c.sent).not.toHaveBeenCalled();
    }, 10_000);
  }
});
