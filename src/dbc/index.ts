/**
 * Tooling for launching and monitoring Meteora DBC pools whose quote token is a
 * tokenized stock.
 *
 * Start at {@link planStockLaunch}: it takes dollar targets plus a live stock
 * quote and returns a reviewable plan. {@link buildStockQuotedConfig} turns
 * that plan into Meteora `ConfigParameters`, and {@link assessPool} watches the
 * result.
 */
export * from "./types";
export * from "./plan";
export * from "./curve";
export * from "./monitor";
