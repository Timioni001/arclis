/**
 * The faucet request: what the keeper's answers turn into on screen.
 */
import { describe, expect, it, vi } from "vitest";
import { requestTestUsdc } from "./FaucetButton";

const answer = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("requestTestUsdc", () => {
  it("POSTs the wallet and reports what was sent", async () => {
    const fetchImpl = answer(200, { amount: 10000, sol: 0.05 });
    const msg = await requestTestUsdc("2j6XijYUDDxa8yUyAfi4ocawjTArZRJJexirdZBtF3DR", fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/\/faucet\?address=2j6X/);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(msg).toBe("Sent 10,000 test USDC and 0.05 SOL for fees.");
  });

  it("passes the keeper's refusal through", async () => {
    const fetchImpl = answer(429, { error: "This wallet was funded recently. Try again in 5 h." });
    await expect(requestTestUsdc("x", fetchImpl)).rejects.toThrow(/funded recently/);
  });

  it("says so when the keeper cannot be reached", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(requestTestUsdc("x", fetchImpl)).rejects.toThrow(/could not be reached/);
  });
});
