import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { mockSource } from "./lib/protocol/mock";
import "./styles/base.css";

/**
 * The one line to change when the frontend goes live.
 *
 * `mockSource` implements `DataSource`. An RPC implementation reads the same
 * shapes from chain using `idl/arclis.json` via `@coral-xyz/anchor`; no screen
 * or component knows the difference.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App source={mockSource} />
  </StrictMode>,
);
