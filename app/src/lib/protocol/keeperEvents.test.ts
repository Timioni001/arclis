import { describe, expect, it } from "vitest";
import { toActivity, toCorporateAction, type KeeperEvent } from "./keeperEvents";

const ev = (kind: string, data: KeeperEvent["data"]): KeeperEvent => ({
  id: "sig:0", kind, ts: 100, symbol: "AAPL", signature: "sig", data,
});

describe("indexed events", () => {
  it("describe an opened short in plain words", () => {
    const a = toActivity(ev("PositionOpened", { size_delta: "-2000000", fill_price: "168160000", owner: "HyEiyg5z2RSvLuTJtmGWgsQeicMRp3Qyu93j4GTSWP5T" }));
    expect(a?.summary).toBe("Short 2 AAPL at $168.16");
    expect(a?.detail).toBe("by HyEi…WP5T");
    expect(a?.signature).toBe("sig");
  });

  it("carry realised P&L on a close", () => {
    const a = toActivity(ev("PositionClosed", { reduce_size: "1000000", fill_price: "170000000", realized_pnl: "1840000" }));
    expect(a?.detail).toMatch(/1\.84/);
  });

  it("become corporate actions when they are splits", () => {
    const c = toCorporateAction(ev("CorporateActionApplied", { numerator: "4", denominator: "1", price_before: "400000000", price_after: "100000000", sequence: "1" }));
    expect(c).toMatchObject({ symbol: "AAPL", numerator: 4, denominator: 1, priceAfter: 100000000n });
    expect(toCorporateAction(ev("PositionOpened", {}))).toBeNull();
  });

  it("skip kinds the feed does not show", () => {
    expect(toActivity(ev("MarketCreated", {}))).toBeNull();
  });
});
