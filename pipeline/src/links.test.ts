import { describe, expect, it, vi } from "vitest";
import { checkLink } from "./links";

const answer = (status: number) =>
  vi.fn(async () => new Response("", { status })) as unknown as typeof fetch;

describe("checkLink", () => {
  it("passes a page that answers", async () => {
    expect((await checkLink("https://a.example", answer(200), () => 5)).ok).toBe(true);
  });

  it("reports a page that is gone", async () => {
    const r = await checkLink("https://a.example", answer(404), () => 5);
    expect(r).toEqual({ ok: false, status: 404, checkedAt: 5 });
  });

  it("does not call a page broken because it refused a bot", async () => {
    for (const status of [401, 403, 429]) {
      expect((await checkLink("https://a.example", answer(status))).ok).toBeNull();
    }
  });

  it("reports no answer at all as broken", async () => {
    const down = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await checkLink("https://a.example", down, () => 9)).toEqual({
      ok: false,
      status: 0,
      checkedAt: 9,
    });
  });
});
