// @vitest-environment jsdom
/**
 * The shared transaction button: what it refuses, and what it reports.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ANONYMOUS, walletSession } from "../../lib/auth/session";

vi.mock("../../lib/config", async (orig) => ({
  ...(await orig<typeof import("../../lib/config")>()),
  DATA_SOURCE: "rpc",
  PROGRAM_ID: "BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP",
  QUOTE_MINT: "8nMZjpyLpGGtnCkdCotT8jWUDUpSnJeVjeuazyYVvqGu",
  RPC_URL: "http://127.0.0.1:8899",
}));

const { TxButton } = await import("./TxButton");

afterEach(cleanup);

const wallet = walletSession("2j6XijYUDDxa8yUyAfi4ocawjTArZRJJexirdZBtF3DR", "Phantom");

describe("TxButton", () => {
  it("asks an anonymous visitor to sign in", () => {
    const onSignIn = vi.fn();
    render(
      <TxButton symbol="AAPL" session={ANONYMOUS} onSignIn={onSignIn}
        action={vi.fn()}>Close position</TxButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in to continue" }));
    expect(onSignIn).toHaveBeenCalled();
  });

  it("states the blocker and does not send", () => {
    const action = vi.fn();
    render(
      <TxButton symbol="AAPL" session={wallet} blocker="Market closed."
        action={action}>Close position</TxButton>,
    );
    const button = screen.getByRole("button", { name: "Close position" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("Market closed.");
  });

  it("links the transaction once it lands", async () => {
    const onDone = vi.fn();
    const action = vi.fn().mockResolvedValue({ signature: "sig", explorer: "https://explorer/tx/sig" });
    render(
      <TxButton symbol="AAPL" session={wallet} onDone={onDone}
        action={action}>Withdraw</TxButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    const link = await screen.findByRole("link", { name: "View transaction" });
    expect(link.getAttribute("href")).toBe("https://explorer/tx/sig");
    expect(action.mock.calls[0][0].symbol).toBe("AAPL");
    expect(onDone).toHaveBeenCalled();
  });

  it("shows the refusal when the transaction fails", async () => {
    const action = vi.fn().mockRejectedValue(new Error("Cooldown has not elapsed."));
    render(
      <TxButton symbol="AAPL" session={wallet} action={action}>Withdraw</TxButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Cooldown has not elapsed.");
  });
});
