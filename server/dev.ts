/**
 * A local server for the assistant endpoint.
 *
 * `handleAssistant` was written as a platform-neutral `Request -> Response`
 * handler so it can be dropped into a serverless function without change.
 * That is the right shape for deployment and a useless shape for development:
 * nothing in this repository served it, so the assistant panel could not be
 * switched on, and a feature that cannot be run is a feature nobody has
 * checked.
 *
 * This is the missing 40 lines. It is a development server and says so: it
 * binds to localhost, allows exactly one origin, and serves one route.
 *
 *     ANTHROPIC_API_KEY=sk-ant-... npm run assistant
 *
 * The key is read from the process environment here and nowhere else. It must
 * never be given a `VITE_` prefix: anything so named is inlined into the
 * JavaScript bundle and shipped to every visitor.
 */

import http from "node:http";

import { handleAssistant } from "./assistant";

const PORT = Number(process.env.ASSISTANT_PORT ?? 8787);
const ORIGIN = process.env.ASSISTANT_ORIGIN ?? "http://localhost:5173";
const ROUTE = "/api/assistant";

// Fail at startup rather than on the first question. The handler answers an
// unconfigured deployment with a 503, which is correct in production and
// unhelpful here, where the cause is almost always a shell that did not
// export the key.
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set. The assistant cannot start without it.\n" +
      "Export it in this shell, or put it in a .env you do not commit:\n\n" +
      "    export ANTHROPIC_API_KEY=sk-ant-...\n\n" +
      "Do not prefix it with VITE_. That would compile it into the bundle.",
  );
  process.exit(1);
}

const cors = {
  "access-control-allow-origin": ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== ROUTE) {
    res.writeHead(404, { ...cors, "content-type": "text/plain" });
    res.end(`No route here. The assistant is at ${ROUTE}.`);
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  // Node's header bag allows repeated headers as arrays; the web Request
  // constructor does not.
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }

  try {
    const response = await handleAssistant(
      new Request(url.toString(), {
        method: req.method,
        headers,
        body: body.length > 0 ? body : undefined,
      }),
    );

    const out: Record<string, string> = { ...cors };
    response.headers.forEach((value, key) => {
      out[key] = value;
    });
    res.writeHead(response.status, out);

    // Send the headers before the first token so the browser opens the event
    // stream immediately. Without this the panel sits blank until the model
    // has finished, which looks like a hang and defeats the point of
    // streaming.
    res.flushHeaders();

    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
      }
    }
    res.end();
  } catch (e: any) {
    // Say what happened on the terminal, not to the browser: the failure may
    // quote a request that contains the key.
    console.error("assistant request failed:", e?.message ?? e);
    if (!res.headersSent) {
      res.writeHead(500, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ error: "The assistant failed. See the server log." }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`assistant listening on http://127.0.0.1:${PORT}${ROUTE}`);
  console.log(`allowing requests from ${ORIGIN}`);
  console.log(`\npoint the interface at it:\n    VITE_ASSISTANT_URL=http://127.0.0.1:${PORT}${ROUTE}\n`);
});
