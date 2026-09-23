/**
 * Runtime configuration, read once.
 *
 * Everything here comes from Vite env vars so the same build can point at a
 * local validator, devnet or mainnet without a code change. Defaults are the
 * safe end of every choice: no program, no cluster, mock data. An interface
 * that silently defaults to mainnet is one misconfiguration away from a real
 * loss.
 */

import { PROGRAM_ADDRESS } from "../idl/program-id";
import { MARKETS } from "./markets";

export type Cluster = "localnet" | "devnet" | "mainnet-beta";

const env = import.meta.env as Record<string, string | undefined>;

const CLUSTER_ENDPOINTS: Record<Cluster, string> = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

function readCluster(): Cluster {
  const raw = env.VITE_CLUSTER?.trim();
  if (raw === "localnet" || raw === "devnet" || raw === "mainnet-beta")
    return raw;
  return "devnet";
}

export const CLUSTER = readCluster();

/**
 * The public endpoints are rate limited hard enough that they are a demo
 * convenience, not a deployment. `VITE_RPC_URL` is where a real one goes.
 */
export const RPC_URL = env.VITE_RPC_URL?.trim() || CLUSTER_ENDPOINTS[CLUSTER];

/**
 * The program ID comes from the IDL, which the build generates from the Rust,
 * so it cannot disagree with `declare_id!`. An override exists for pointing a
 * build at a second deployment without regenerating.
 */
/**
 * Base58, not a `PublicKey`.
 *
 * Constructing one here would import `@solana/web3.js` into the entry chunk,
 * and the entry chunk is what a visitor who only reads the registry
 * downloads. They never sign anything, so they should never pay for the
 * signing library. Callers that need a `PublicKey` build one.
 */
export const PROGRAM_ID: string =
  env.VITE_PROGRAM_ID?.trim() || PROGRAM_ADDRESS;

/** The quote mint every market settles in. Devnet USDC by default. */
export const QUOTE_MINT: string =
  env.VITE_QUOTE_MINT?.trim() || "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

/**
 * Markets the interface lists. Symbols; every address derives from them.
 *
 * Defaults to `markets.json`, the one list the seed script also reads, so a
 * market that exists on chain and a market the interface shows cannot drift
 * apart unless an environment variable says so on purpose.
 */
export const MARKET_SYMBOLS = (
  env.VITE_MARKETS?.trim() || MARKETS.map((m) => m.symbol).join(",")
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Which data source the app starts on.
 *
 * Defaults to `mock`, deliberately. Pointing at a chain is an explicit act:
 * with no program deployed, an RPC default would render an interface full of
 * empty states and look broken rather than look unconfigured.
 */
export const DATA_SOURCE: "mock" | "rpc" =
  env.VITE_DATA_SOURCE?.trim() === "rpc" ? "rpc" : "mock";

/** How often the RPC source re-reads the chain, in milliseconds. */
export const REFRESH_INTERVAL_MS = Number(env.VITE_REFRESH_MS ?? 10_000);

export const EXPLORER_BASE = "https://explorer.solana.com";

/**
 * Mainnet takes no parameter, devnet takes its name, and a local validator is
 * `custom` plus the URL. Sending the explorer `?cluster=localnet` produces a
 * page that silently shows nothing, which is the worst of the three outcomes
 * because it looks like the transaction failed.
 */
function explorerSuffix(): string {
  if (CLUSTER === "mainnet-beta") return "";
  if (CLUSTER === "localnet") {
    return `?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`;
  }
  return `?cluster=${CLUSTER}`;
}

export function explorerTx(signature: string): string {
  return `${EXPLORER_BASE}/tx/${signature}${explorerSuffix()}`;
}

export function explorerAddress(address: string): string {
  return `${EXPLORER_BASE}/address/${address}${explorerSuffix()}`;
}
