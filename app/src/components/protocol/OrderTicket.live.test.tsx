// @vitest-environment jsdom
/**
 * The ticket against a live (scripted) chain: the wallet's balances arrive
 * one after the other, and the refusal shown has to follow whichever came
 * last.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("../../lib/config", async (orig) => ({
  ...(await orig<typeof import("../../lib/config")>()),
  DATA_SOURCE: "rpc",
  PROGRAM_ID: "BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP",
  QUOTE_MINT: "8nMZjpyLpGGtnCkdCotT8jWUDUpSnJeVjeuazyYVvqGu",
}));

// The token balance lands first, the SOL balance a moment later.
let releaseLamports: (n: number) => void = () => {};
vi.mock("@solana/web3.js", async (orig) => {
  const real = await orig<typeof import("@solana/web3.js")>();
  class Connection {
    getTokenAccountBalance = async () => ({ value: { amount: "1000000000" } });
    getBalance = () => new Promise<number>((r) => (releaseLamports = r));
  }
  return { ...real, Connection };
});

// Address derivation does not run under jsdom; the address is not under test.
vi.mock("@solana/spl-token", async (orig) => ({
  ...(await orig<typeof import("@solana/spl-token")>()),
  getAssociatedTokenAddressSync: () => ({ toBase58: () => "ata" }),
}));

import { OrderTicket, type OrderPreview } from "./OrderTicket";
import { walletSession } from "../../lib/auth/session";

afterEach(cleanup);

const preview: OrderPreview = {
  size: 2_000_000n,
  collateral: 67_000_000n,
  fee: 300_000n,
  notional: 336_000_000n,
  liq: 141_000_000n,
  qty: 2,
};

describe("OrderTicket on a live chain", () => {
  it("refuses a wallet with no SOL once its SOL balance arrives", async () => {
    render(
      <OrderTicket symbol="AAPL" side="long" preview={preview}
        poolLiquidity={1_000_000_000n}
        session={walletSession("HyEiyg5z2RSvLuTJtmGWgsQeicMRp3Qyu93j4GTSWP5T", "Phantom")}
        onSignIn={() => {}} />,
    );
    // Let the token balance land: the wallet holds enough test USDC.
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();

    // Then the SOL balance: none at all.
    await act(async () => releaseLamports(0));
    expect(screen.getByRole("alert").textContent).toMatch(/no devnet SOL/);
    expect((screen.getByRole("button", { name: "Review trade" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
