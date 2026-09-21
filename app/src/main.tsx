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
  console.info(
    `[arclis] reading ${PROGRAM_ID} at ${RPC_URL}; markets ${MARKET_SYMBOLS.join(", ")}`,
  );
  void (async () => {
    try {
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
    } catch (e) {
      /*
       * Say so. The mock is already on screen, so a failure here leaves a
       * complete, plausible interface labelled DEMO DATA and no indication
       * that the thing you configured did not load. That is the worst way to
       * be wrong: it looks like the configuration was ignored rather than
       * like something broke, and the first half hour goes into the env file.
       */
      console.error(
        "[arclis] VITE_DATA_SOURCE=rpc, but the chain-backed source failed to " +
          "start. The interface is still showing mock data.",
        e,
      );
    }
  })();
} else {
  console.info(
    "[arclis] mock data. Set VITE_DATA_SOURCE=rpc in app/.env.local to read a chain.",
  );
}
