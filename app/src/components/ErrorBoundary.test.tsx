// @vitest-environment jsdom
/**
 * The boundary is only worth having if it actually catches, and the failure
 * mode it prevents - a white page - is indistinguishable from the component
 * simply not being wired in. So this renders a component that throws.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ErrorBoundary } from "./ErrorBoundary";

function Explodes(): never {
  throw new Error("entry price was undefined");
}

afterEach(cleanup);

describe("ErrorBoundary", () => {
  it("shows what threw instead of an empty page", () => {
    // React logs the caught error itself; that is expected here, not a fault.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Explodes />
      </ErrorBoundary>,
    );

    expect(screen.getByText("The interface stopped")).toBeTruthy();
    expect(screen.getByText("entry price was undefined")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();

    quiet.mockRestore();
  });

  it("stays out of the way when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>markets</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("markets")).toBeTruthy();
    expect(screen.queryByText("The interface stopped")).toBeNull();
  });
});
