/**
 * The first Arclis agent, launched on mainnet through ClawPump.
 *
 * Fixed facts about a launch that has happened, so they live here as data
 * rather than being fetched: the token, its pair and the launch transaction
 * do not change. Everything a visitor might check links to a public page.
 */
export const LIVE_AGENT = {
  name: "Arclis Agent",
  ticker: "ARCLIS",
  mint: "74f7U4HTbcE4JKcog5aEcL9WycCEs8KD5RrDaMDavjtS",
  launchTx:
    "3UgJRfPVUqoMTNNWgvPX3oLxrZwA1SUoXSRyXGdi9qi3nC87hdkXQa2XqQwaLDLQ15JMexh4m9gCrgdACRShB6Eo",
  pairedWith: "SPY",
  pairName: "S&P 500 xStock",
  creatorFeePct: 1,
  pumpUrl: "https://pump.fun/coin/74f7U4HTbcE4JKcog5aEcL9WycCEs8KD5RrDaMDavjtS",
  txUrl:
    "https://solscan.io/tx/3UgJRfPVUqoMTNNWgvPX3oLxrZwA1SUoXSRyXGdi9qi3nC87hdkXQa2XqQwaLDLQ15JMexh4m9gCrgdACRShB6Eo",
  tokenUrl:
    "https://solscan.io/token/74f7U4HTbcE4JKcog5aEcL9WycCEs8KD5RrDaMDavjtS",
} as const;
