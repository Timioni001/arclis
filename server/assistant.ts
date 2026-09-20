/**
 * The Arclis assistant, server side.
 *
 * # Why this is a server and not a fetch from the browser
 *
 * An Anthropic API key in a Vite bundle is a published API key. `VITE_`
 * anything is baked into the JavaScript every visitor downloads. So the key
 * lives here, this handler is the only thing that holds it, and the browser
 * talks to this.
 *
 * # What the assistant is for
 *
 * Not a chatbot bolted to a finance app. It answers one question that Arclis
 * is uniquely able to answer and that a holder genuinely cannot answer for
 * themselves: **"what am I actually holding, and should the number I am
 * looking at worry me?"**
 *
 * The registry already computes structured verdicts - claim strength with a
 * component breakdown, NAV deviation judged against the reference venue's
 * session, exit liquidity by price impact, mint control findings. Those are
 * precise and they are also dense. A person who just wants to know whether
 * their tokenized AAPL is a real share claim has to read four cards and know
 * what "authorized participants" means.
 *
 * So the model gets **tools**, not a prompt full of pasted numbers. It looks
 * things up in the same scoring functions the interface renders, which means
 * its answers cannot drift from the page beside it. That is the whole design:
 * the model does language, the scoring does arithmetic, and the arithmetic is
 * the part that has tests.
 *
 * # Deployment
 *
 * The handler takes a Web `Request` and returns a Web `Response`, so it runs
 * unmodified on Vercel, Netlify, Cloudflare Workers, Deno, and Node 18+ via
 * `@hono/node-server` or `node:http` with a small adapter. There is no
 * framework dependency.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  TOKENIZED_STOCKS,
  ISSUERS,
  issuerById,
} from "../app/src/lib/registry/data";
import {
  assessBacking,
  assessControl,
  assessDeviation,
  assessLiquidity,
  circulatingValue,
  exitCoverageBps,
} from "../app/src/lib/registry/scoring";
import { listLaunches, type Launch } from "./clawpump";

const MODEL = "claude-opus-5";

const SYSTEM = `You are the Arclis assistant. Arclis is two things: a registry of
tokenized equities on Solana, and an oracle-priced perpetual futures engine for
them.

Your job is to explain what somebody actually owns, and whether a number in
front of them should worry them. You are talking to people who understand
stocks and mostly do not understand crypto market structure.

Rules you do not break:

- Look things up. Never state a number from memory; call a tool. The tools run
  the same scoring the interface renders, so your answer and the page agree.
- Say what the claim is in one plain sentence before any detail. "You hold a
  certificate you can redeem for a share through a named custodian" beats any
  amount of structure.
- A wide NAV gap while the reference market is shut is usually the clock, not a
  mispricing. Say which one it is. This is the single most common thing people
  misread.
- Never tell anyone to buy or sell, and never imply an opinion on price
  direction. You describe instruments and risks. If asked for a recommendation,
  say plainly that Arclis does not give investment advice, then give them the
  facts that would inform the decision.
- A weak claim score is not an accusation. A disclosed synthetic is honest
  about being synthetic; it is simply a weaker claim than a redeemable one. Say
  that distinction out loud when it comes up.
- If a tool returns nothing, say you do not have data on it. Do not fill the
  gap.
- Be brief. Three or four sentences unless asked for more.`;

/* eslint-disable @typescript-eslint/no-explicit-any */

const tools: Anthropic.Tool[] = [
  {
    name: "lookup_token",
    description:
      "Look up one tokenized equity by its token symbol (for example AAPLx) " +
      "or by the stock it references (for example AAPL). Returns the issuer, " +
      "legal structure, custody, redemption rights, claim-strength score with " +
      "its component breakdown, live NAV deviation with a session-aware " +
      "verdict, exit liquidity by price impact, and what the mint's " +
      "authorities allow.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Token symbol, underlying ticker, or company name.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "list_tokens",
    description:
      "List every tokenized equity in the registry with its issuer, backing " +
      "tier and claim score. Use this to compare, or when the user asks what " +
      "is covered.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "list_launches",
    description:
      "Recent token launches on Clawpump whose quote token is a tokenized " +
      "stock. Returns the launch, its quote token, and that quote token's own " +
      "backing tier, so a launch quoted in a weak or synthetic instrument can " +
      "be identified.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many to return. Default 10.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
];

function findToken(query: string) {
  const q = query.trim().toLowerCase();
  return (
    TOKENIZED_STOCKS.find((s) => s.symbol.toLowerCase() === q) ??
    TOKENIZED_STOCKS.find((s) => s.underlying.toLowerCase() === q) ??
    TOKENIZED_STOCKS.find(
      (s) =>
        s.symbol.toLowerCase().includes(q) ||
        s.underlying.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q),
    )
  );
}

/** Quote units at 1e6 into a readable dollar figure. */
const usd = (v: bigint) =>
  `$${(Number(v) / 1_000_000).toLocaleString("en-US")}`;

async function runTool(name: string, input: any, now: number): Promise<string> {
  switch (name) {
    case "lookup_token": {
      const stock = findToken(String(input.query ?? ""));
      if (!stock) {
        return JSON.stringify({
          found: false,
          note: `No token matching "${input.query}" is in the registry.`,
          covered: TOKENIZED_STOCKS.map((s) => s.symbol),
        });
      }
      const issuer = issuerById(stock.issuerId)!;
      const backing = assessBacking(
        stock,
        issuer.attestation,
        issuer.regulator,
      );
      const deviation = assessDeviation(stock, now);
      const liquidity = assessLiquidity(stock.pools);

      return JSON.stringify({
        found: true,
        symbol: stock.symbol,
        underlying: stock.underlying,
        name: stock.name,
        issuer: {
          name: issuer.name,
          jurisdiction: issuer.jurisdiction,
          structure: issuer.structure,
          regulator: issuer.regulator,
          attestation: issuer.attestation,
          disclosureUrl: issuer.disclosureUrl,
        },
        claim: {
          tier: stock.backing,
          score: backing.score,
          outOf: 100,
          components: backing.components,
          redemption: stock.redemption,
          custodian: stock.custodian,
        },
        pricing: {
          onChain: usd(stock.onChainPrice),
          reference: usd(stock.referencePrice),
          referenceSession: stock.referenceSession,
          deviationBps: deviation.bps,
          verdict: deviation.verdict,
          note: deviation.note,
          referenceIsStale: deviation.referenceStale,
        },
        exit: {
          verdict: liquidity.verdict,
          bestVenue: liquidity.bestVenue,
          sellImpactBps: liquidity.bestSellImpactBps,
          totalPooled: usd(liquidity.totalQuoteLiquidity),
          note: liquidity.note,
          circulatingValue: usd(circulatingValue(stock)),
          exitCoveragePct: exitCoverageBps(stock) / 100,
        },
        mintControl: assessControl(stock),
        dividends: stock.dividendTreatment,
        corporateActions: stock.corporateActionPolicy,
        issuerRisk: stock.issuerRisk,
        arclisMarket: stock.arclisSymbol,
      });
    }

    case "list_tokens": {
      return JSON.stringify({
        issuers: ISSUERS.map((i) => ({
          name: i.name,
          attestation: i.attestation,
        })),
        tokens: TOKENIZED_STOCKS.map((s) => {
          const issuer = issuerById(s.issuerId)!;
          return {
            symbol: s.symbol,
            underlying: s.underlying,
            issuer: issuer.name,
            tier: s.backing,
            score: assessBacking(s, issuer.attestation, issuer.regulator).score,
          };
        }),
      });
    }

    case "list_launches": {
      const launches: Launch[] = await listLaunches(Number(input.limit ?? 10));
      return JSON.stringify({
        available: launches.length > 0,
        launches: launches.map((l) => {
          const quote = findToken(l.quoteSymbol);
          const issuer = quote ? issuerById(quote.issuerId) : undefined;
          return {
            ...l,
            quoteBacking: quote?.backing ?? "Unknown",
            quoteIssuer: issuer?.name ?? "Unknown",
            quoteScore:
              quote && issuer
                ? assessBacking(quote, issuer.attestation, issuer.regulator)
                    .score
                : null,
          };
        }),
      });
    }

    default:
      return JSON.stringify({ error: `Unknown tool ${name}` });
  }
}

export interface AssistantRequest {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Handle one turn, streaming the answer back as Server-Sent Events.
 *
 * The tool loop runs server side and is invisible to the browser: the client
 * receives text deltas and a final `done`. That keeps the client dumb, which
 * is what you want on the boundary where the key lives.
 */
export async function handleAssistant(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "The assistant is not configured on this deployment." },
      { status: 503 },
    );
  }

  let body: AssistantRequest;
  try {
    body = (await request.json()) as AssistantRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const incoming = (body.messages ?? []).filter(
    (m) => typeof m?.content === "string" && m.content.trim().length > 0,
  );
  if (incoming.length === 0) {
    return Response.json({ error: "No message." }, { status: 400 });
  }
  // A hard cap on history. Without one, a long-lived tab becomes an
  // ever-growing bill paid by whoever deployed this.
  const history: Anthropic.MessageParam[] = incoming.slice(-12).map((m) => ({
    role: m.role,
    content: m.content.slice(0, 4000),
  }));

  const client = new Anthropic({ apiKey });
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const messages = [...history];

        // The tool loop. Bounded, because a model that keeps calling tools
        // forever is a model that keeps spending forever.
        for (let turn = 0; turn < 6; turn++) {
          const response = await client.messages
            .stream({
              model: MODEL,
              max_tokens: 4096,
              system: SYSTEM,
              thinking: { type: "adaptive" },
              output_config: { effort: "medium" },
              tools,
              messages,
            })
            .on("text", (delta) => send("delta", { text: delta }))
            .finalMessage();

          if (response.stop_reason === "refusal") {
            send("error", {
              message:
                "I cannot answer that one. Ask me about what a token is backed by, or what a price gap means.",
            });
            break;
          }

          messages.push({ role: "assistant", content: response.content });

          const toolUses = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );
          if (toolUses.length === 0) break;

          // Every tool result goes back in one user message. Splitting them
          // trains the model out of calling tools in parallel.
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const use of toolUses) {
            send("tool", { name: use.name });
            try {
              results.push({
                type: "tool_result",
                tool_use_id: use.id,
                content: await runTool(use.name, use.input, now),
              });
            } catch (e) {
              results.push({
                type: "tool_result",
                tool_use_id: use.id,
                is_error: true,
                content: e instanceof Error ? e.message : "Lookup failed.",
              });
            }
          }
          messages.push({ role: "user", content: results });
        }

        send("done", {});
      } catch (e) {
        const message =
          e instanceof Anthropic.RateLimitError
            ? "The assistant is busy. Try again in a moment."
            : e instanceof Anthropic.APIError
              ? "The assistant is unavailable right now."
              : "Something went wrong.";
        send("error", { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

export default handleAssistant;
