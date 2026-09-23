// @vitest-environment jsdom
/**
 * The order ticket's refusals.
 *
 * "Review trade" used to be a button with no handler. The ticket that
 * replaced it is the one place the interface asks a wallet to sign, so what
 * it refuses to offer matters as much as what it sends.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OrderTicket, type OrderPreview } from "./OrderTicket";
import { ANONYMOUS, walletSession } from "../../lib/auth/session";

afterEach(cleanup);

const preview: OrderPreview = {
  size: 2_000_000n,
  collateral: 67_000_000n,
  fee: 300_000n,
  notional: 336_000_000n,
  liq: 141_000_000n,
  qty: 2,
};

describe("OrderTicket", () => {
  it("asks an anonymous visitor to sign in rather than to review", () => {
    const onSignIn = vi.fn();
    render(
      <OrderTicket symbol="AAPL" side="long" preview={preview}
        poolLiquidity={1_000_000_000n} session={ANONYMOUS} onSignIn={onSignIn} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in to trade" }));
    expect(onSignIn).toHaveBeenCalled();
  });

  it("will not offer a signature on the modelled data source", () => {
    // Tests run with the default `mock` source: there is no chain to send to.
    render(
      <OrderTicket symbol="AAPL" side="long" preview={preview}
        poolLiquidity={1_000_000_000n}
        session={walletSession("BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP", "Phantom")}
        onSignIn={() => {}} />,
    );
    const button = screen.getByRole("button", { name: "Review trade" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/devnet/);
  });
});
