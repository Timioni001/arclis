# The Arclis server

One handler, one reason to exist: **the Anthropic API key must not be in the
browser.** Anything prefixed `VITE_` is compiled into the JavaScript every
visitor downloads, so a key there is a published key.

```
server/
  assistant.ts   the assistant: Claude with tools over the registry's own scoring
  clawpump.ts    the launch feed adapter
```

## What the assistant does

It answers one question the registry can answer and a holder cannot: *what am I
actually holding, and should this number worry me?*

The model is given **tools**, not a prompt full of pasted figures. `lookup_token`
calls the same `assessBacking` / `assessDeviation` / `assessLiquidity` functions
the interface renders, so the assistant's answer and the page beside it cannot
disagree. The model does language; the scoring does arithmetic; the arithmetic
is the part with tests.

Three tools:

| Tool | What it returns |
|---|---|
| `lookup_token` | One instrument: structure, custody, redemption, claim score with its breakdown, session-aware NAV deviation, exit impact, mint authorities |
| `list_tokens` | Everything covered, for comparison |
| `list_launches` | Clawpump launches, each annotated with **its quote token's own backing tier** |

That last one is the Clawpump integration, and it is the part worth explaining.

## Why launch-watch is the right Clawpump integration

Clawpump is where a token launches; Meteora's DBC is what it launches on; and
Arclis already builds DBC configs whose **quote token is a tokenized stock**
(`src/dbc/`). Contributors pay in AAPLx rather than SOL.

Which means a stock-quoted launch **inherits the backing of the thing people
are paying in**. A project raising into a redeemable, custodied certificate is
in a materially different position from one raising into a synthetic tracker
holding nothing, and on a price chart those look identical. Contributors cannot
see the difference and the launchpad has no reason to show it.

Arclis can, because it already scores those instruments. So the integration is
not "render Clawpump's feed". It is: pull the launches, resolve each quote token
to its registry entry, and publish the backing strength of the asset being
raised into. Clawpump to Meteora to the registry, and the answer at the end is
one only a neutral party holding both datasets can give.

## Configuration

```bash
ANTHROPIC_API_KEY=sk-ant-...      # required for the assistant
CLAWPUMP_API_KEY=...              # optional; without it the launch feed is empty
CLAWPUMP_BASE_URL=https://api.clawpump.tech
```

With no `ANTHROPIC_API_KEY` the endpoint returns 503 and the interface hides the
assistant rather than showing a broken one. With no `CLAWPUMP_API_KEY` the
launch tool returns nothing and the assistant says it has no data, which is
true.

## Deploying

`handleAssistant` takes a Web `Request` and returns a Web `Response`, so it runs
unmodified anywhere that speaks that interface, with no framework dependency:

```ts
// Vercel / Netlify edge
export { handleAssistant as POST } from "./server/assistant";

// Cloudflare Workers
export default { fetch: handleAssistant };

// Deno
Deno.serve(handleAssistant);
```

For Node, adapt `node:http` to `Request`/`Response`, or put it behind Hono's
`@hono/node-server`.

Point the interface at it with `VITE_ASSISTANT_URL=https://your-host/api/assistant`.

## A note on the Clawpump shape

`clawpump.tech/developers` was not reachable from the environment this was
written in, so the response shape in `parseLaunches` is inferred. It is
deliberately isolated: it is the only function to change once the real shape is
known, and it coerces every field and drops any row it cannot read rather than
rendering `undefined`. Everything else is written against the `Launch` type.
