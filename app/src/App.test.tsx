// @vitest-environment jsdom
/**
 * The screens must show what the source holds *now*.
 *
 * This exists because of one line:
 *
 *     const markets = useMemo(() => source.markets(), [source]);
 *
 * The source is a mutable snapshot holder whose identity never changes - that
 * is deliberate, so that six screens can read a single consistent view without
 * becoming loading-state machines. Memoising on its identity therefore froze
 * the result of the very first call, made before the first read of the chain
 * had landed, and every screen taking `markets` rendered its empty state
 * forever: Overview said "0 / 0", Liquidity said "No markets to provide
 * liquidity to", Treasuries and Portfolio the same. Trade alone worked,
 * because it happens to call `source.market(symbol)` directly.
 *
 * None of it could be seen in development. The mock source has markets from
 * the first render, so the memo cached the right answer and the bug only
 * existed against a chain - where the first snapshot is always empty.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/*
 * Stubbed above the imports, not in `beforeEach`.
 *
 * GSAP registers ScrollTrigger at module scope, and ScrollTrigger calls
 * `matchMedia` while doing it. By the time a `beforeEach` runs, that import
 * has already thrown. `vi.hoisted` is the only hook that runs first.
 */
vi.hoisted(() => {
  const g = globalThis as unknown as {
    matchMedia: unknown;
    ResizeObserver: unknown;
  };
  g.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.ResizeObserver = NoopResizeObserver;
});

import { App } from "./App";
import type { DataSource } from "./lib/protocol/mock";
import type { MarketView } from "./lib/protocol/types";

/** Enough of a MarketView for the Overview counters to render. */
function marketView(symbol: string, open: boolean): MarketView {
  return {
    oracle: {
      address: `oracle-${symbol}`,
      symbol,
      name: `${symbol} Inc.`,
      price: 100_000_000n,
      confidence: 1_000_000n,
      lastUpdateTs: 1_790_000_000,
      session: open ? "Open" : "Closed",
      splitFactor: 1_000_000n,
    },
    market: {
      address: `market-${symbol}`,
      oracle: `oracle-${symbol}`,
      vault: `vault-${symbol}`,
      vaultBalance: 0n,
      maxLeverage: 10,
      maintenanceMarginBps: 500,
      initialMarginBps: 600,
      takerFeeBps: 10,
      liquidationPenaltyBps: 500,
      fundingIntervalSecs: 3600,
      lastFundingTs: 1_790_000_000,
      cumulativeFundingIndex: 0n,
      fundingSensitivityBps: 100,
      openInterestLong: 0n,
      openInterestShort: 0n,
      maxOpenInterest: 1_000_000_000_000n,
      maxSkewBps: 10_000,
      maxUtilizationBps: 8_000,
      longEntryNotional: 0n,
      shortEntryNotional: 0n,
      liquidityPool: `pool-${symbol}`,
      totalCollateral: 0n,
      insuranceBalance: 0n,
      badDebt: 0n,
      paused: false,
    },
    pool: {
      address: `pool-${symbol}`,
      market: `market-${symbol}`,
      vault: `poolvault-${symbol}`,
      vaultBalance: 0n,
      totalShares: 0n,
      lockedNotional: 0n,
      cumulativeFees: 0n,
    },
    candles: [],
    volume24h: 0n,
    changePct24h: 0,
  } as unknown as MarketView;
}

/**
 * A source that starts empty and gains markets on its first refresh, which is
 * exactly how the chain-backed one behaves and exactly what the mock cannot
 * reproduce.
 */
function chainLikeSource() {
  let current: MarketView[] = [];
  // Null until the first read lands, exactly as `rpcSource` does. The
  // interface keys its loading states off this, so a fixture that leaves it
  // null forever is a fixture stuck mid-load.
  let loadedAt: number | null = null;
  const source = {
    kind: "rpc" as const,
    wallet: () => null,
    markets: () => current,
    market: (s: string) => current.find((mv) => mv.oracle.symbol === s),
    positions: () => [],
    positionFor: () => undefined,
    lpPosition: () => undefined,
    treasuries: () => [],
    treasuryPosition: () => undefined,
    corporateActions: () => [],
    activity: () => [],
    get loadedAt() {
      return loadedAt;
    },
    lastError: null,
    setOwner: () => {},
    refresh: async () => {
      current = [marketView("AAPL", true), marketView("NVDA", false)];
      loadedAt = 1_790_000_000;
    },
  };
  return source as unknown as DataSource;
}

// The ambient shader asks for a WebGL context; jsdom has no canvas backend,
// and returning null is the path the component already handles.
HTMLCanvasElement.prototype.getContext = (() =>
  null) as unknown as HTMLCanvasElement["getContext"];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a refresh that lands after the first render", () => {
  it("reaches the screens", async () => {
    const source = chainLikeSource();

    await act(async () => {
      render(<App source={source} />);
    });

    // `useLiveSource` fires one refresh immediately on mount. Let it settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Overview counts one open market out of two. Frozen, it would say 0 / 0.
    expect(await screen.findByText("1 / 2")).toBeTruthy();
  });

  it("shows a skeleton rather than zeroes before the first read lands", async () => {
    // The other half of the same problem. An empty snapshot rendered through
    // the real arithmetic says "0 / 0 markets open" and "$0 liquidity
    // backing", which is not a loading state, it is a claim that the protocol
    // is empty.
    const source = chainLikeSource();

    await act(async () => {
      render(<App source={{ ...source, refresh: async () => {} } as DataSource} />);
    });

    expect(screen.getByLabelText("Loading markets from the chain")).toBeTruthy();
    expect(screen.queryByText("0 / 0")).toBeNull();
  });

  it("does not leave the markets array frozen at its first value", async () => {
    // The property, stated directly: two reads of a source whose contents
    // changed must not return the same thing.
    const source = chainLikeSource();
    const before = source.markets();
    await (source as unknown as { refresh(): Promise<void> }).refresh();
    const after = source.markets();

    expect(before).toHaveLength(0);
    expect(after).toHaveLength(2);
    expect(after).not.toBe(before);
  });
});
