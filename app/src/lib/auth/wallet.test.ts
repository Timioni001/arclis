// @vitest-environment jsdom
/**
 * Wallet discovery, against the real Wallet Standard handshake.
 *
 * The hand-written discovery this replaced had the protocol backwards on both
 * sides and detected no wallet on any device. These tests speak the protocol
 * the way a real extension does, so the same mistake cannot pass again.
 */
import { describe, expect, it, vi } from "vitest";
import { registerWallet } from "@wallet-standard/wallet";
import { openInWalletLinks, startWalletDiscovery } from "./wallet";

function fakeWallet(name: string, chains: string[]) {
  return {
    version: "1.0.0" as const,
    name,
    icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" as const,
    chains,
    accounts: [],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [] }) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
    },
  };
}

describe("startWalletDiscovery", () => {
  it("finds a Solana wallet that registers the way Phantom does", () => {
    const seen = vi.fn();
    const stop = startWalletDiscovery(seen);
    registerWallet(fakeWallet("Phantom", ["solana:mainnet", "solana:devnet"]) as never);

    const last = seen.mock.calls.at(-1)![0];
    expect(last.map((w: { name: string }) => w.name)).toContain("Phantom");
    stop();
  });

  it("leaves out a wallet that does not speak Solana", () => {
    const seen = vi.fn();
    const stop = startWalletDiscovery(seen);
    registerWallet(fakeWallet("EthOnly", ["eip155:1"]) as never);

    const last = seen.mock.calls.at(-1)![0];
    expect(last.map((w: { name: string }) => w.name)).not.toContain("EthOnly");
    stop();
  });
});

describe("openInWalletLinks", () => {
  it("reopens this exact page inside each wallet's browser", () => {
    const links = openInWalletLinks();
    const here = encodeURIComponent(window.location.href);
    expect(links.map((l) => l.name)).toEqual(["Phantom", "Solflare"]);
    for (const l of links) expect(l.href).toContain(here);
  });
});
