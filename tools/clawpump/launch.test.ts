/**
 * The launch guards, without a network or a key.
 *
 * A launch spends real SOL on mainnet and fixes its payout wallet for good, so
 * the checks that stand in front of it are the part worth pinning down.
 */
import { describe, expect, it, vi } from "vitest";
import { BASE_URL, client, isTokenizedStock, planLaunch, type PumpPairs } from "./launch";

const AAPLX = { mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", symbol: "AAPLx", name: "Apple xStock", decimals: 8 };
const MEME = { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", name: "Bonk", decimals: 5 };
const PAIRS: PumpPairs = { assets: [AAPLX, MEME], creatorFeeBps: { min: 100, max: 300, default: 100 } };
const WALLET = "BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP";

const good = {
  agentId: "agent-1", stock: "AAPLx", symbol: "HELIO",
  description: "An agent whose treasury is denominated in Apple.",
  image: "https://example.com/helio.png", payout: WALLET,
};

describe("planLaunch", () => {
  it("builds a stock-quoted, self-funded launch with no dev buy", () => {
    const r = planLaunch(good, PAIRS);
    if ("errors" in r) throw new Error(r.errors.join("; "));
    expect(r.plan.pumpQuoteMint).toBe(AAPLX.mint);
    expect(r.plan.pumpCreatorFeeBps).toBe(100);
    expect(r.plan.initialBuySol).toBe(0);
    expect(r.plan.payoutWallet).toBe(WALLET);
  });

  it("refuses a mint ClawPump does not list", () => {
    const r = planLaunch({ ...good, stock: "TSLAx" }, PAIRS);
    expect("errors" in r && r.errors.join()).toMatch(/not in ClawPump/);
  });

  it("refuses a pair that is not a stock unless told otherwise", () => {
    const r = planLaunch({ ...good, stock: "BONK" }, PAIRS);
    expect("errors" in r && r.errors.join()).toMatch(/tokenized stock/);
    expect("plan" in planLaunch({ ...good, stock: "BONK", anyPair: true }, PAIRS)).toBe(true);
  });

  it("holds the creator fee to the live range", () => {
    expect("errors" in planLaunch({ ...good, feeBps: 350 }, PAIRS)).toBe(true);
    expect("errors" in planLaunch({ ...good, feeBps: 99 }, PAIRS)).toBe(true);
    expect("plan" in planLaunch({ ...good, feeBps: 250 }, PAIRS)).toBe(true);
  });

  it("refuses a payout wallet that is not a Solana address", () => {
    // It is permanent once the token exists, so a typo here is forever.
    const r = planLaunch({ ...good, payout: "0xabc" }, PAIRS);
    expect("errors" in r && r.errors.join()).toMatch(/payout/);
  });

  it("lists every problem at once", () => {
    const r = planLaunch({}, PAIRS);
    expect("errors" in r && r.errors.length).toBeGreaterThanOrEqual(5);
  });

  it("recognises xStocks by symbol or by name", () => {
    expect(isTokenizedStock({ symbol: "SPYx", name: "" })).toBe(true);
    expect(isTokenizedStock({ symbol: "SPCX", name: "SpaceX tokenized equity" })).toBe(true);
    expect(isTokenizedStock(MEME)).toBe(false);
  });
});

describe("client", () => {
  it("talks to the apex domain and refuses redirects", async () => {
    // agents.clawpump.tech redirects cross-host, which strips the bearer.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(PAIRS), { status: 200 }));
    await client("cpk_test", fetchImpl as any).pairs();
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe(`${BASE_URL}/pump-pairs`);
    expect(url.startsWith("https://clawpump.tech/")).toBe(true);
    expect(init.redirect).toBe("error");
    expect(init.headers.Authorization).toBe("Bearer cpk_test");
  });

  it("rejects a key that is not a cpk_ key before sending it anywhere", () => {
    expect(() => client("sk-something")).toThrow(/cpk_/);
  });
});
