/// <reference types="vite/client" />

/**
 * The environment this build reads.
 *
 * Declared rather than left to `vite/client`'s index signature so a typo in a
 * variable name is a compile error instead of `undefined` at runtime, which on
 * this particular set of variables would mean quietly falling back to a
 * different cluster.
 */
interface ImportMetaEnv {
  readonly VITE_DATA_SOURCE?: "mock" | "rpc";
  readonly VITE_CLUSTER?: "localnet" | "devnet" | "mainnet-beta";
  readonly VITE_RPC_URL?: string;
  readonly VITE_PROGRAM_ID?: string;
  readonly VITE_QUOTE_MINT?: string;
  readonly VITE_MARKETS?: string;
  readonly VITE_REFRESH_MS?: string;
  readonly VITE_CLAWPUMP_API_KEY?: string;
  readonly VITE_CLAWPUMP_BASE_URL?: string;
  readonly VITE_ASSISTANT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
