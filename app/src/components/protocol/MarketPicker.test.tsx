// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MarketPicker } from "./MarketPicker";
import { mockSource } from "../../lib/protocol/mock";

afterEach(cleanup);

describe("MarketPicker", () => {
  const markets = mockSource.markets();

  it("searches by ticker or company and opens the choice with Enter", () => {
    const onSelect = vi.fn();
    render(
      <MarketPicker markets={markets} current="AAPL" onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /AAPL/ }));
    const search = screen.getByLabelText("Search markets");
    fireEvent.change(search, { target: { value: "coca" } });
    // Coca-Cola is listed twice: KO on market hours, KOx around the clock.
    const found = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^KO(?!x)/);
    expect(found[1]).toMatch(/^KOx/);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("KO");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("puts ticker matches before name matches", () => {
    render(
      <MarketPicker markets={markets} current="AAPL" onSelect={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /AAPL/ }));
    fireEvent.change(screen.getByLabelText("Search markets"), {
      target: { value: "nvda" },
    });
    const options = screen
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(options[0]).toMatch(/^NVDA/);
    expect(options.some((o) => o.startsWith("NVDAx"))).toBe(true);
  });
});
