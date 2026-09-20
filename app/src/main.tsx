import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { mockSource, type DataSource } from "./lib/protocol/mock";
import { DATA_SOURCE, MARKET_SYMBOLS, PROGRAM_ID, RPC_URL } from "./lib/config";
import "./styles/base.css";

/**
 * Which world the interface reads.
 *
 * Both implement `DataSource`, so no screen or component knows the difference.
 * `mock` is the default and needs no chain; set `VITE_DATA_SOURCE=rpc` (see
 * `.env.example`) to read a deployment.
 *
 * Company names live here rather than on-chain: the program stores a ticker,
 * and putting a display string in an account would be paying rent forever for
 * something a lookup table answers.
 */
const NAMES: Record<string, string> = {
  AAPL: "Apple Inc.",
  NVDA: "NVIDIA Corporation",
  MSFT: "Microsoft Corporation",
  TSLA: "Tesla, Inc.",
  GOOGL: "Alphabet Inc. Class A",
  AMZN: "Amazon.com, Inc.",
  META: "Meta Platforms, Inc.",
};

const root = createRoot(document.getElementById("root")!);

function render(source: DataSource) {
  root.render(
    <StrictMode>
      <App source={source} />
    </StrictMode>,
  );
}

// The mock renders immediately. The chain-backed source is imported only when
// it is configured, which keeps `@solana/web3.js` and Anchor out of the entry
// chunk: a visitor reading the registry never signs anything and should not
// download a signing library to find that out.
render(mockSource);

if (DATA_SOURCE === "rpc") {
  void (async () => {
    const [{ rpcSource }, { PublicKey }] = await Promise.all([
      import("./lib/protocol/rpc/source"),
      import("@solana/web3.js"),
    ]);
    render(
      rpcSource({
        endpoint: RPC_URL,
        programId: new PublicKey(PROGRAM_ID),
        symbols: MARKET_SYMBOLS,
        names: NAMES,
      }),
    );
  })();
}
