/**
 * Launch an Arclis agent token through ClawPump, paired against a tokenized
 * stock rather than SOL.
 *
 * # What this is for
 *
 * An agent that raises in AAPLx instead of SOL holds a runway that tracks a
 * real equity. Its token trades on a Pump.fun curve quoted in that stock, the
 * curve's creator fees accrue in the stock, and ClawPump forwards 75% of them
 * to a payout wallet. Point that wallet at the agent's Arclis treasury
 * authority and the fees become the treasury's ongoing income, which the
 * on-chain hedge then keeps from swinging with the company's earnings.
 *
 * # Why it is a script and not a button on the site
 *
 * A ClawPump `cpk_` key is a bearer secret bound to one account, and that
 * account's agents hold wallets that can spend. Anything prefixed `VITE_` is
 * compiled into the JavaScript every visitor downloads, so the key can never
 * go near the interface. It is read from `CLAWPUMP_API_KEY` here, on the
 * operator's own machine, and nowhere else.
 *
 * # Safety bar, in the order it is applied
 *
 *  1. Dry run by default. Nothing is sent to `/launch` without `--execute`.
 *  2. The quote mint must be one ClawPump lists in `/pump-pairs` right now, and
 *     must be a tokenized stock we recognise. A typo'd mint is refused rather
 *     than launched against whatever it happens to be.
 *  3. The creator fee must sit inside the range `/pump-pairs` reports.
 *  4. The payout wallet must be a valid Solana address, and the response's
 *     registered payout wallet is checked against it after launch, because
 *     it is fixed for the token's lifetime once set.
 *  5. Writes are never retried. ClawPump's `/launch` is not idempotent, and a
 *     blind retry after a timeout can launch twice.
 *
 * # What it deliberately does not do
 *
 * It does not set the curve's starting price from an oracle. Pump.fun curves
 * have a fixed shape and ClawPump exposes no parameter for it, so "anchor the
 * launch to the stock's fair value" is not something any client of this API
 * can do. The stock's live price is printed alongside the plan so the operator
 * sees what the quote asset is worth, and that is as far as it honestly goes.
 * Custom curve shapes are what `src/dbc` builds for Meteora's DBC directly.
 *
 * Pump.fun is mainnet. A token launched here is real and costs real SOL.
 *
 *     export CLAWPUMP_API_KEY=cpk_...
 *     npx tsx tools/clawpump/launch.ts pairs
 *     npx tsx tools/clawpump/launch.ts agents
 *     npx tsx tools/clawpump/launch.ts create-agent --name "Helios Quant"
 *     npx tsx tools/clawpump/launch.ts launch --agent <id> --stock AAPLx \
 *         --symbol HELIO --description "..." --image https://... \
 *         --payout <treasury authority> [--fee-bps 250] [--execute]
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import stockPairs from "../../app/src/lib/clawpump/stock-pairs.json";

// The apex domain. agents.clawpump.tech 308-redirects here, and HTTP clients
// drop the Authorization header across a cross-host redirect, so every call
// sent there arrives unauthenticated.
export const BASE_URL = "https://clawpump.tech/api/v1";

/** Chat and launch turns can take tens of seconds; ClawPump asks for 120. */
const TIMEOUT_MS = 120_000;

/**
 * The tokenized stocks and ETFs in ClawPump's catalogue, by mint.
 *
 * Checked by mint against a reviewed list rather than guessed from names. A
 * first version matched `AAPLx`-style symbols and the words "stock" or
 * "equity" in the name, and tagged exactly two of the catalogue's eighty-odd
 * equities, because ClawPump lists xStocks under their plain tickers and
 * most names are just the company's. The list is the same file the interface
 * shows, so the CLI and the site agree on what counts.
 */
export const STOCK_PAIRS: { symbol: string; mint: string; name: string; kind: string }[] =
  stockPairs.pairs;

const STOCK_MINTS = new Set(STOCK_PAIRS.map((p) => p.mint));

/**
 * Backed's xStocks all have vanity mints beginning `Xs`, which lets a refresh
 * pick up newly listed ones without a human reviewing each entry.
 */
const XSTOCK_MINT = /^Xs[1-9A-HJ-NP-Za-km-z]{30,42}$/;

export function isTokenizedStock(pair: { mint: string }) {
  return STOCK_MINTS.has(pair.mint) || XSTOCK_MINT.test(pair.mint);
}

export interface PumpPair {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface PumpPairs {
  assets: PumpPair[];
  creatorFeeBps: { min: number; max: number; default: number };
}

export interface LaunchPlan {
  agentId: string;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  payoutWallet: string;
  pumpQuoteMint: string;
  pumpCreatorFeeBps: number;
  selfFunded: true;
  initialBuySol: 0;
}

// ---------------------------------------------------------------------------
// validation: pure, so it is tested without a network
// ---------------------------------------------------------------------------

export function isSolanaAddress(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn the operator's arguments into a launch body, or say exactly why not.
 *
 * Returns every problem at once rather than the first, because each round
 * trip with a human costs more than listing the lot.
 */
export function planLaunch(
  args: {
    agentId?: string;
    stock?: string;
    symbol?: string;
    name?: string;
    description?: string;
    image?: string;
    payout?: string;
    feeBps?: number;
    anyPair?: boolean;
  },
  pairs: PumpPairs,
): { plan: LaunchPlan; pair: PumpPair } | { errors: string[] } {
  const errors: string[] = [];

  if (!args.agentId) errors.push("--agent is required (see `agents`)");
  if (!args.symbol || !/^[A-Za-z0-9]{1,10}$/.test(args.symbol)) {
    errors.push("--symbol must be 1 to 10 letters or digits");
  }
  if (!args.description || args.description.length < 20) {
    errors.push("--description must be at least 20 characters");
  }
  if (!args.image || !args.image.startsWith("https://")) {
    errors.push("--image must be an https URL");
  }
  if (!args.payout || !isSolanaAddress(args.payout)) {
    errors.push(
      "--payout must be a Solana address. It receives 75% of creator fees " +
        "and cannot be changed once the token exists.",
    );
  }

  const wanted = (args.stock ?? "").toLowerCase();
  const pair = pairs.assets.find(
    (a) => a.symbol.toLowerCase() === wanted || a.mint === args.stock,
  );
  if (!args.stock) {
    errors.push("--stock is required, e.g. AAPLx (see `pairs`)");
  } else if (!pair) {
    errors.push(
      `${args.stock} is not in ClawPump's live pair catalogue. Run \`pairs\`.`,
    );
  } else if (!args.anyPair && !isTokenizedStock(pair)) {
    errors.push(
      `${pair.symbol} (${pair.name}) is not a tokenized stock. ` +
        "An Arclis agent pairs against an equity, not a memecoin or a " +
        "stablecoin. Pass --any-pair if it is one.",
    );
  }

  const { min, max, default: dflt } = pairs.creatorFeeBps;
  const feeBps = args.feeBps ?? dflt;
  if (!Number.isInteger(feeBps) || feeBps < min || feeBps > max) {
    errors.push(`--fee-bps must be an integer from ${min} to ${max}`);
  }

  if (errors.length > 0 || !pair) return { errors };
  return {
    pair,
    plan: {
      agentId: args.agentId!,
      name: args.name ?? args.symbol!,
      symbol: args.symbol!.toUpperCase(),
      description: args.description!,
      imageUrl: args.image!,
      payoutWallet: args.payout!,
      pumpQuoteMint: pair.mint,
      pumpCreatorFeeBps: feeBps,
      selfFunded: true,
      // No dev buy. The treasury is funded by the curve, not by the operator
      // buying its own token on the way out of the door.
      initialBuySol: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// the API
// ---------------------------------------------------------------------------

export class ClawPumpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export function client(key: string, fetchImpl: typeof fetch = fetch) {
  if (!key.startsWith("cpk_")) {
    throw new Error("CLAWPUMP_API_KEY must start with cpk_");
  }

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown) {
    const res = await fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Refuse to follow a redirect rather than silently lose the header.
      redirect: "error",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    const requestId = json?.meta?.requestId;
    if (!res.ok) {
      throw new ClawPumpError(
        res.status,
        json?.error ?? `HTTP ${res.status}`,
        json,
        requestId,
      );
    }
    return json as T & { meta?: { requestId: string } };
  }

  return {
    pairs: () => call<PumpPairs>("GET", "/pump-pairs"),
    agents: () => call<{ agents: any[] }>("GET", "/agents"),
    createAgent: (name: string) =>
      // Launch-only skills. A chat turn can move funds, so an agent whose job
      // is to hold a token does not get trading or sniping.
      call<any>("POST", "/agents", { name, skills: ["token-launch"] }),
    price: (mint: string) =>
      call<{ price: number; symbol: string }>(
        "GET",
        `/price?mint=${encodeURIComponent(mint)}`,
      ),
    launch: (plan: LaunchPlan) => call<any>("POST", "/launch", plan),
  };
}

// ---------------------------------------------------------------------------
// command line
// ---------------------------------------------------------------------------

function flags(argv: string[]) {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const key = process.env.CLAWPUMP_API_KEY ?? "";
  if (!key) throw new Error("set CLAWPUMP_API_KEY first (never commit it)");
  const cp = client(key);

  switch (command) {
    case "pairs": {
      const p = await cp.pairs();
      console.log(`\n  creator fee: ${p.creatorFeeBps.min}-${p.creatorFeeBps.max} bps\n`);
      for (const a of p.assets) {
        const tag = isTokenizedStock(a) ? "stock" : "     ";
        console.log(`  ${tag}  ${a.symbol.padEnd(10)} ${a.mint}  ${a.name}`);
      }
      console.log();
      return;
    }
    case "snapshot": {
      // Refresh the list the interface shows. Entries already reviewed stay;
      // new xStocks are recognised by their mint. Anything else new is
      // printed for a human to decide on, not added silently.
      const p = await cp.pairs();
      const keep = p.assets.filter(isTokenizedStock);
      const unknown = p.assets.filter((a) => !isTokenizedStock(a));
      const file = path.resolve(__dirname, "../../app/src/lib/clawpump/stock-pairs.json");
      writeFileSync(
        file,
        JSON.stringify(
          {
            ...stockPairs,
            snapshot: new Date().toISOString().slice(0, 10),
            creatorFeeBps: p.creatorFeeBps,
            pairs: keep.map((a) => ({
              symbol: a.symbol,
              mint: a.mint,
              name: STOCK_PAIRS.find((s) => s.mint === a.mint)?.name ?? a.name,
              kind:
                STOCK_PAIRS.find((s) => s.mint === a.mint)?.kind ??
                (/ETF|Fund/.test(a.name) ? "etf" : "equity"),
            })),
          },
          null,
          1,
        ) + "\n",
      );
      console.log(`\n  wrote ${keep.length} stock pairs to ${file}`);
      console.log(`  ${unknown.length} other assets left out; add any real stocks by hand\n`);
      return;
    }
    case "agents": {
      const { agents } = await cp.agents();
      for (const a of agents) {
        console.log(`  ${a.id}  ${a.name.padEnd(24)} ${a.status}  wallet ${a.walletAddress}`);
      }
      return;
    }
    case "create-agent": {
      if (typeof f.name !== "string") throw new Error("--name is required");
      const a = await cp.createAgent(f.name);
      console.log(`\n  created ${a.id ?? a.agent?.id}\n  fund its wallet with SOL before launching\n`);
      return;
    }
    case "launch": {
      const pairs = await cp.pairs();
      const result = planLaunch(
        {
          agentId: f.agent as string,
          stock: f.stock as string,
          symbol: f.symbol as string,
          name: f.name as string,
          description: f.description as string,
          image: f.image as string,
          payout: f.payout as string,
          feeBps: f["fee-bps"] ? Number(f["fee-bps"]) : undefined,
          anyPair: f["any-pair"] === true,
        },
        pairs,
      );
      if ("errors" in result) {
        console.error("\n  refusing to launch:\n");
        for (const e of result.errors) console.error(`    - ${e}`);
        console.error();
        process.exit(1);
      }
      const { plan, pair } = result;
      const price = await cp.price(pair.mint).catch(() => null);

      console.log("\n  launch plan (Pump.fun, MAINNET, real SOL)\n");
      console.log(`    token        ${plan.name} (${plan.symbol})`);
      console.log(`    quoted in    ${pair.symbol} ${pair.mint}`);
      if (price) console.log(`    ${pair.symbol} now  $${price.price}`);
      console.log(`    creator fee  ${plan.pumpCreatorFeeBps / 100}% of volume, paid in ${pair.symbol}`);
      console.log(`    fee payout   ${plan.payoutWallet} (75% share, permanent)`);
      console.log(`    paid from    the agent's own SOL wallet`);

      if (f.execute !== true) {
        console.log("\n  dry run. Re-run with --execute to launch.\n");
        return;
      }

      // Sent once. `/launch` is not idempotent: on a timeout, check the agent
      // with `agents` before trying again, never blind-retry.
      const res = await cp.launch(plan);
      console.log(`\n  launched ${res.mintAddress}\n  tx ${res.txHash}`);
      if (res.payoutWallet && res.payoutWallet !== plan.payoutWallet) {
        console.error(
          `\n  WARNING: ClawPump registered payout ${res.payoutWallet}, not ` +
            `${plan.payoutWallet}. Fees will go there, permanently.`,
        );
      }
      console.log(`  request ${res.meta?.requestId}\n`);
      return;
    }
    default:
      console.log("commands: pairs | snapshot | agents | create-agent | launch");
  }
}

if (process.argv[1]?.endsWith("launch.ts")) {
  main().catch((e) => {
    if (e instanceof ClawPumpError) {
      console.error(`\n  ClawPump ${e.status}: ${e.message}`);
      if (e.status === 402) {
        console.error("  The agent wallet needs SOL:", JSON.stringify(e.body));
      }
      if (e.requestId) console.error(`  request ${e.requestId}`);
    } else {
      console.error(`\n  ${e.message ?? e}`);
    }
    process.exit(1);
  });
}
