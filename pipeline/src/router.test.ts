/**
 * The Jupiter router: the current endpoint, the key, and manners.
 */

import { describe, expect, it, vi } from "vitest";
import { jupiterRouter } from "./depth";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const REQUEST = { inputMint: "IN", outputMint: "OUT", amount: 1_000n };

describe("jupiterRouter", () => {
  it("asks the swap v1 quote endpoint on the keyless host by default", async () => {
    const fetchImpl = vi.fn(async () => ok({ outAmount: "990", routePlan: [] }));
    const router = jupiterRouter({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await router.quote(REQUEST);
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url.startsWith("https://lite-api.jup.ag/swap/v1/quote?")).toBe(true);
    expect(url).toContain("inputMint=IN");
  });

  it("uses the keyed host and sends the key when there is one", async () => {
    const fetchImpl = vi.fn(async () => ok({ outAmount: "990", routePlan: [] }));
    const router = jupiterRouter({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await router.quote(REQUEST);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith("https://api.jup.ag/swap/v1/quote?")).toBe(true);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("reads routes and the amount out", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ outAmount: "990", routePlan: [{ swapInfo: { label: "Meteora DLMM" } }] }),
    );
    const router = jupiterRouter({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await router.quote(REQUEST)).toEqual({ outAmount: 990n, routes: ["Meteora DLMM"] });
  });

  it("treats a 400 as no route, which is data", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 400 }));
    const router = jupiterRouter({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await router.quote(REQUEST)).toBeNull();
  });

  it("waits and retries once on a rate limit", async () => {
    const replies = [new Response("", { status: 429 }), ok({ outAmount: "5", routePlan: [] })];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const sleep = vi.fn(async () => {});
    const router = jupiterRouter({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep });
    expect((await router.quote(REQUEST))?.outAmount).toBe(5n);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("spaces quotes so a ladder cannot burst the shared rate limit", async () => {
    const fetchImpl = vi.fn(async () => ok({ outAmount: "1", routePlan: [] }));
    const sleep = vi.fn(async () => {});
    const router = jupiterRouter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spacingMs: 3_000,
      sleep,
    });
    await router.quote(REQUEST);
    await router.quote(REQUEST);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect((sleep.mock.calls[0] as unknown as [number])[0]).toBeGreaterThan(2_000);
  });
});
