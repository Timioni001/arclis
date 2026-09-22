/**
 * A deterministic in-memory data source.
 *
 * Shaped exactly like the live one will be: `DataSource` is the seam. Swapping
 * in RPC means implementing this interface against `@coral-xyz/anchor` using
 * `idl/arclis.json`, and changing one line in `main.tsx`. No screen or component
 * knows which it is talking to.
 *
 * The numbers are generated, but the *relationships* are real - every derived
 * figure the UI shows is computed by `math.ts`, which is cross-checked against
 * the Rust. So a position here has a genuine margin ratio and liquidation price,
 * not a plausible-looking constant.
 */

import * as m from "./math";
import type {
  ActivityEvent,
  Candle,
  CorporateAction,
  LiquidityPool,
  LpPosition,
  Market,
  MarketView,
  Oracle,
  Position,
  Treasury,
} from "./types";

const NOW = Math.floor(Date.now() / 1000);

/** Deterministic pseudo-random so the demo looks the same every reload. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const price = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
const quote = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
const size = (sh: number) => BigInt(Math.round(sh * 1_000_000));

interface Seed {
  symbol: string;
  name: string;
  px: number;
  vol: number;
  session: Oracle["session"];
  oiLong: number;
  oiShort: number;
  splitFactor?: bigint;
}

const SEEDS: Seed[] = [
  {
    symbol: "AAPL",
    name: "Apple Inc.",
    px: 168.16,
    vol: 0.28,
    session: "Open",
    oiLong: 48_000,
    oiShort: 31_000,
  },
  {
    symbol: "NVDA",
    name: "NVIDIA Corp.",
    px: 121.4,
    vol: 0.52,
    session: "Open",
    oiLong: 92_000,
    oiShort: 40_000,
  },
  {
    symbol: "TSLA",
    name: "Tesla, Inc.",
    px: 244.8,
    vol: 0.61,
    session: "Open",
    oiLong: 26_000,
    oiShort: 38_000,
  },
  {
    symbol: "MSFT",
    name: "Microsoft Corp.",
    px: 412.2,
    vol: 0.24,
    session: "Closed",
    oiLong: 18_000,
    oiShort: 17_400,
  },
  {
    symbol: "AMZN",
    name: "Amazon.com, Inc.",
    px: 186.9,
    vol: 0.33,
    session: "PreOpen",
    oiLong: 9_800,
    oiShort: 11_200,
  },
  {
    symbol: "GME",
    name: "GameStop Corp.",
    px: 23.45,
    vol: 1.1,
    session: "Halted",
    oiLong: 14_000,
    oiShort: 21_500,
  },
];

function buildCandles(px: number, vol: number, seed: number): Candle[] {
  const rand = rng(seed);
  const out: Candle[] = [];
  // Walk backwards so the last candle closes exactly at the oracle price.
  let level = px;
  const step = (vol / Math.sqrt(252)) * px * 0.35;
  const raw: number[] = [];
  for (let i = 0; i < 90; i++) {
    raw.push(level);
    level -= (rand() - 0.5) * 2 * step;
    level = Math.max(level, px * 0.45);
  }
  raw.reverse();
  for (let i = 0; i < raw.length; i++) {
    const o = i === 0 ? raw[0] : raw[i - 1];
    const c = raw[i];
    const spread = Math.abs(c - o) + step * rand() * 0.6;
    out.push({
      t: NOW - (raw.length - 1 - i) * 3600,
      o: price(o),
      h: price(Math.max(o, c) + spread * 0.4),
      l: price(Math.min(o, c) - spread * 0.4),
      c: price(c),
      v: quote(40_000 + rand() * 180_000),
    });
  }
  return out;
}

function buildMarket(seed: Seed, index: number): MarketView {
  const rand = rng(index * 977 + 13);
  const oiLong = size(seed.oiLong);
  const oiShort = size(seed.oiShort);
  // Entry notionals imply traders are up a little on the heavier side, which is
  // what makes the pool's liability non-zero and the UI worth looking at.
  const longEntry = oiLong * price(seed.px * 0.97);
  const shortEntry = oiShort * price(seed.px * 1.02);

  const oracle: Oracle = {
    address: `oracle-${seed.symbol}`,
    symbol: seed.symbol,
    name: seed.name,
    price: price(seed.px),
    confidence: price(seed.px * (0.0004 + rand() * 0.0008)),
    lastUpdateTs: NOW - Math.floor(rand() * 40),
    session: seed.session,
    sessionUpdatedTs: NOW - 3600,
    splitFactor: seed.splitFactor ?? m.SPLIT_FACTOR_SCALE,
    corporateActionSeq: seed.splitFactor ? 1 : 0,
    nextOpenTs: NOW + 18 * 3600,
    nextCloseTs: NOW + 6 * 3600,
  };

  const market: Market = {
    address: `market-${seed.symbol}`,
    oracle: oracle.address,
    vault: `vault-${seed.symbol}`,
    liquidityPool: `pool-${seed.symbol}`,
    paused: false,
    maxLeverage: 10,
    maintenanceMarginBps: 500,
    initialMarginBps: 600,
    takerFeeBps: 10,
    liquidationPenaltyBps: 500,
    fundingSensitivityBps: 100,
    fundingIntervalSecs: 3600,
    lastFundingTs: NOW - 1200,
    cumulativeFundingIndex: BigInt(Math.round(rand() * 4_000_000)),
    openInterestLong: oiLong,
    openInterestShort: oiShort,
    longEntryNotional: longEntry,
    shortEntryNotional: shortEntry,
    maxOpenInterest: size(400_000),
    maxSkewBps: 6_000,
    maxUtilizationBps: 8_000,
    totalCollateral: quote(seed.px * (seed.oiLong + seed.oiShort) * 0.14),
    insuranceBalance: quote(12_000 + rand() * 40_000),
    badDebt: 0n,
  };

  const markPrice = oracle.price;
  const traderPnl = m.netTraderPnl(
    market.openInterestLong,
    market.longEntryNotional,
    market.openInterestShort,
    market.shortEntryNotional,
    markPrice,
  );
  // Size the vault so utilisation lands in a believable band rather than an
  // arbitrary one. This is what the Liquidity screen is really showing.
  const exposure = m.netExposureNotional(oiLong, oiShort, markPrice);
  const targetUtil = 0.35 + rand() * 0.4;
  const vaultBalance =
    m.abs(exposure) === 0n
      ? quote(500_000)
      : BigInt(Math.round(Number(m.abs(exposure)) / targetUtil)) +
        (traderPnl > 0n ? traderPnl : 0n);

  const pool: LiquidityPool = {
    address: market.liquidityPool,
    market: market.address,
    vault: `lp-vault-${seed.symbol}`,
    vaultBalance,
    totalShares: (vaultBalance * 100n) / 108n,
    principal: (vaultBalance * 100n) / 108n,
    realizedPnl: quote(rand() * 24_000),
    absorbedBadDebt: 0n,
    cooldownSecs: 24 * 3600,
    pendingShares: 0n,
    depositsPaused: false,
  };

  const candles = buildCandles(seed.px, seed.vol, index * 131 + 7);
  const first = candles[Math.max(0, candles.length - 24)].c;
  const changePct24h = (Number(markPrice - first) / Number(first)) * 100;

  return {
    market,
    oracle,
    pool,
    candles,
    // One print per bar is all a modelled series has; it is enough for the
    // chart to re-bucket a timeframe, and it keeps mock and chain on the same
    // code path rather than giving the mock a chart the chain does not get.
    points: candles.map((c) => ({ t: c.t, price: c.c })),
    volume24h: candles.slice(-24).reduce((a, c) => a + c.v, 0n),
    changePct24h,
  };
}

const MARKETS: MarketView[] = SEEDS.map(buildMarket);

const WALLET = "7x4FqK3mVhT2bYcN8dLpQrWjZs5eA1uG9tXvB6nM92A";

const POSITIONS: Position[] = [
  {
    address: "pos-AAPL",
    owner: WALLET,
    market: "market-AAPL",
    size: size(2.5),
    entryPrice: price(162.4),
    collateral: quote(135.4),
    entryFundingIndex: 0n,
    entrySplitFactor: m.SPLIT_FACTOR_SCALE,
    lastUpdateTs: NOW - 5400,
  },
  {
    address: "pos-TSLA",
    owner: WALLET,
    market: "market-TSLA",
    size: size(-4),
    entryPrice: price(251.1),
    collateral: quote(232.0),
    entryFundingIndex: 0n,
    entrySplitFactor: m.SPLIT_FACTOR_SCALE,
    lastUpdateTs: NOW - 26_000,
  },
  {
    address: "pos-NVDA",
    owner: WALLET,
    market: "market-NVDA",
    size: size(9),
    entryPrice: price(112.2),
    collateral: quote(148.0),
    entryFundingIndex: 0n,
    entrySplitFactor: m.SPLIT_FACTOR_SCALE,
    lastUpdateTs: NOW - 88_000,
  },
];

const LP_POSITION: LpPosition = {
  address: "lp-AAPL",
  owner: WALLET,
  pool: "pool-AAPL",
  shares: quote(22_900),
  pendingShares: 0n,
  cooldownEndsTs: 0,
  lastDepositTs: NOW - 9 * 86_400,
};

const TREASURIES: Treasury[] = [
  {
    address: "treasury-QUANT",
    authority: WALLET,
    agentMint: "mint-QUANT",
    agentName: "Quant Agent",
    stockMint: "XsAAPL",
    market: "market-AAPL",
    stockQty: size(12_500),
    tokensOutstanding: quote(2_000_000),
    hedgeRatioBps: 10_000,
    rebalanceToleranceBps: 300,
    hedgingEnabled: true,
    lastNavPerToken: quote(1.042),
    lastNavTs: NOW - 900,
  },
  {
    address: "treasury-MOMO",
    authority: WALLET,
    agentMint: "mint-MOMO",
    agentName: "Momentum Agent",
    stockMint: "XsNVDA",
    market: "market-NVDA",
    stockQty: size(4_200),
    tokensOutstanding: quote(800_000),
    hedgeRatioBps: 5_000,
    rebalanceToleranceBps: 500,
    hedgingEnabled: true,
    lastNavPerToken: quote(0.712),
    lastNavTs: NOW - 5400,
  },
];

/** The treasuries' own hedge positions, owned by the treasury PDA. */
const TREASURY_POSITIONS: Record<string, Position> = {
  "treasury-QUANT": {
    address: "pos-treasury-QUANT",
    owner: "treasury-QUANT",
    market: "market-AAPL",
    size: size(-12_100),
    entryPrice: price(167.2),
    collateral: quote(240_000),
    entryFundingIndex: 0n,
    entrySplitFactor: m.SPLIT_FACTOR_SCALE,
    lastUpdateTs: NOW - 900,
  },
  "treasury-MOMO": {
    address: "pos-treasury-MOMO",
    owner: "treasury-MOMO",
    market: "market-NVDA",
    size: size(-1_900),
    entryPrice: price(119.8),
    collateral: quote(48_000),
    entryFundingIndex: 0n,
    entrySplitFactor: m.SPLIT_FACTOR_SCALE,
    lastUpdateTs: NOW - 14_400,
  },
};

const CORPORATE_ACTIONS: CorporateAction[] = [
  {
    ts: NOW - 40 * 3600,
    symbol: "AAPL",
    numerator: 4,
    denominator: 1,
    priceBefore: price(672.64),
    priceAfter: price(168.16),
    sequence: 1,
  },
];

const ACTIVITY: ActivityEvent[] = [
  {
    id: "a1",
    kind: "PositionOpened",
    ts: NOW - 12,
    symbol: "AAPL",
    summary: "Opened AAPL position",
    detail: "2.50 shares long",
    signature: "5f2a...9c1",
  },
  {
    id: "a2",
    kind: "FundingAccrued",
    ts: NOW - 140,
    symbol: "AAPL",
    summary: "Funding settled",
    detail: "+0.014% · utilisation 58%",
    signature: "9ab3...2d7",
  },
  {
    id: "a3",
    kind: "PositionClosed",
    ts: NOW - 420,
    symbol: "TSLA",
    summary: "Reduced TSLA position",
    detail: "4.00 shares · realised -$18.40",
    signature: "c17e...4f0",
  },
  {
    id: "a4",
    kind: "LiquidityDeposited",
    ts: NOW - 720,
    symbol: "AAPL",
    summary: "Provided liquidity",
    detail: "$5,000 · 4,612.3 shares",
    signature: "2e88...b35",
  },
  {
    id: "a5",
    kind: "CorporateActionApplied",
    ts: NOW - 40 * 3600,
    symbol: "AAPL",
    summary: "4:1 stock split applied",
    detail: "Positions rescaled · no P&L impact",
    signature: "7d41...aa9",
  },
  {
    id: "a6",
    kind: "SessionChanged",
    ts: NOW - 42 * 3600,
    symbol: "MSFT",
    summary: "Market closed",
    detail: "Reduce-only until the next session",
    signature: "1c09...e62",
  },
  {
    id: "a7",
    kind: "TreasuryHedgeRebalanced",
    ts: NOW - 900,
    symbol: "AAPL",
    summary: "Treasury hedge rebalanced",
    detail: "Quant Agent · delta +400 shares",
    signature: "8b72...31d",
  },
];

/**
 * The seam between the UI and the chain.
 *
 * A live implementation reads the same shapes from RPC via
 * `idl/arclis.json`; nothing above this interface changes.
 */
export interface DataSource {
  readonly kind: "mock" | "rpc";
  wallet(): string | null;
  markets(): MarketView[];
  market(symbol: string): MarketView | undefined;
  positions(): Position[];
  positionFor(marketAddress: string): Position | undefined;
  lpPosition(poolAddress: string): LpPosition | undefined;
  treasuries(): Treasury[];
  treasuryPosition(treasuryAddress: string): Position | undefined;
  corporateActions(symbol?: string): CorporateAction[];
  activity(limit?: number): ActivityEvent[];
}

export const mockSource: DataSource = {
  kind: "mock",
  wallet: () => WALLET,
  markets: () => MARKETS,
  market: (symbol) => MARKETS.find((mv) => mv.oracle.symbol === symbol),
  positions: () => POSITIONS,
  positionFor: (marketAddress) =>
    POSITIONS.find((p) => p.market === marketAddress),
  lpPosition: (poolAddress) =>
    poolAddress === LP_POSITION.pool ? LP_POSITION : undefined,
  treasuries: () => TREASURIES,
  treasuryPosition: (treasuryAddress) => TREASURY_POSITIONS[treasuryAddress],
  corporateActions: (symbol) =>
    symbol
      ? CORPORATE_ACTIONS.filter((c) => c.symbol === symbol)
      : CORPORATE_ACTIONS,
  activity: (limit = 20) => ACTIVITY.slice(0, limit),
};
