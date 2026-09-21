// @vitest-environment jsdom
/**
 * The screen has to survive having no markets.
 *
 * This is not hypothetical. The chain-backed source starts with an empty
 * snapshot and stays empty until its first read lands, and a poll against a
 * shared endpoint can come back with nothing for reasons that have nothing to
 * do with the chain. The screen dereferenced `markets[0]` regardless, so the
 * first render against a real deployment threw "Cannot read properties of
 * undefined (reading 'pool')" and React unmounted the page.
 *
 * The mock source always has markets, which is precisely why no existing test
 * caught it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Liquidity } from "./Liquidity";

afterEach(cleanup);

describe("Liquidity", () => {
  it("renders an empty state rather than throwing when there are no markets", () => {
    expect(() =>
      render(
        <Liquidity markets={[]} lpPositions={() => undefined} now={0} />,
      ),
    ).not.toThrow();

    expect(
      screen.getByText("No markets to provide liquidity to"),
    ).toBeTruthy();
  });
});
