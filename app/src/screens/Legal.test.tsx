// @vitest-environment jsdom
/**
 * The legal pages exist, say something, and are reachable.
 *
 * A terms page is easy to add and easy to quietly gut into a heading with
 * nothing under it, or to wire into a footer link that goes nowhere. These
 * check the two things that would make it decoration: that both documents
 * carry their substantive claims, and that the footer actually routes to them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Legal } from "./Legal";
import { Footer } from "../components/ui/Footer";

afterEach(cleanup);

describe("Legal", () => {
  it("states the things a wallet-connecting site has to state", () => {
    render(<Legal doc="Terms" />);

    // The three that matter most, and the three a template would omit.
    expect(screen.getByText(/never hold your assets or your keys/i)).toBeTruthy();
    expect(screen.getByText(/lose everything you deposit/i)).toBeTruthy();
    expect(screen.getByText(/has not been audited/i)).toBeTruthy();
  });

  it("says devnet out loud rather than burying it", () => {
    render(<Legal doc="Terms" />);
    expect(screen.getByText(/Solana devnet/i)).toBeTruthy();
  });

  it("describes what the privacy policy can actually promise", () => {
    render(<Legal doc="Privacy" />);

    expect(screen.getByText(/no user accounts/i)).toBeTruthy();
    // The honest half: a chain is public, and saying otherwise would be a lie
    // a privacy policy is exactly the wrong place for.
    expect(screen.getByText(/public information on Solana/i)).toBeTruthy();
  });

  it("switches between the two documents", () => {
    const onNavigate = vi.fn();
    render(<Legal doc="Terms" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("tab", { name: /privacy policy/i }));
    expect(onNavigate).toHaveBeenCalledWith("Privacy");
  });
});

describe("Footer", () => {
  it("routes to both documents", () => {
    const onNavigate = vi.fn();
    render(<Footer onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: /terms of service/i }));
    expect(onNavigate).toHaveBeenCalledWith("Terms");

    fireEvent.click(screen.getByRole("button", { name: /privacy policy/i }));
    expect(onNavigate).toHaveBeenCalledWith("Privacy");
  });
});
