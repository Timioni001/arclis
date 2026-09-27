/**
 * The interface's copy of the program's session rules. The program's own
 * table is in `programs/arclis/src/math/session.rs`; these pin the copy to it,
 * because a mismatch shows a button the program will refuse.
 */
import { describe, expect, it } from "vitest";
import { fundingAccrues, sessionAllows, withdrawBlocker } from "./session";

describe("sessionAllows", () => {
  it("allows both directions while open", () => {
    expect(sessionAllows("Open", "IncreaseRisk").allowed).toBe(true);
    expect(sessionAllows("Open", "ReduceRisk").allowed).toBe(true);
  });

  it("lets traders out but not in while closed", () => {
    expect(sessionAllows("Closed", "ReduceRisk").allowed).toBe(true);
    const inBound = sessionAllows("Closed", "IncreaseRisk");
    expect(inBound.allowed).toBe(false);
    expect(inBound.errorCode).toBe("CannotIncreaseRiskWhileClosed");
    expect(inBound.reason).toMatch(/still reduce or close/);
  });

  it("refuses both directions in the auction and in a halt", () => {
    for (const use of ["IncreaseRisk", "ReduceRisk"] as const) {
      expect(sessionAllows("PreOpen", use)).toMatchObject({
        allowed: false,
        errorCode: "SessionNotOpen",
      });
      expect(sessionAllows("Halted", use)).toMatchObject({
        allowed: false,
        errorCode: "MarketHalted",
      });
    }
  });

  it("accrues funding only while open", () => {
    expect(fundingAccrues("Open")).toBe(true);
    expect(fundingAccrues("Closed")).toBe(false);
    expect(fundingAccrues("PreOpen")).toBe(false);
    expect(fundingAccrues("Halted")).toBe(false);
  });
});

describe("withdrawBlocker", () => {
  it("allows a withdrawal only while the market is open, as the program does", () => {
    expect(withdrawBlocker("Open", "AAPL")).toBeNull();
    expect(withdrawBlocker("Closed", "AAPL")).toMatch(/reopen when AAPL opens/);
    expect(withdrawBlocker("PreOpen", "AAPL")).toMatch(/reopen when AAPL opens/);
    expect(withdrawBlocker("Halted", "AAPL")).toMatch(/halted/);
  });
});
