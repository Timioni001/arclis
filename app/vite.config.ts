import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Node's `global` for libraries that assume it. Paired with the `Buffer`
  // polyfill in `main.tsx`; both exist for the same reason, which is that the
  // Solana client libraries predate anyone running them in a browser.
  define: { global: "globalThis" },
  server: { port: 5173, open: false },
  test: {
    // Node by default, so the pure read-model and registry suites stay as fast
    // as they are. A file that needs a DOM opts in with
    // `// @vitest-environment jsdom` at the top, which keeps the cost of jsdom
    // on the handful of tests that actually render something.
    environment: "node",
  },
});
