/**
 * Measuring the exit, by quoting real sells.
 *
 * # Why this is not a pool read
 *
 * Every other dashboard reports TVL, and TVL is the wrong number. A $10m pool
 * that is 95% one-sided will not let you out; a $400k pool that is balanced
 * will. What a holder experiences is **price impact on the size they actually
 * hold**, and the only honest way to get it is to ask the router what it would
 * fill.
 *
 * So this quotes a ladder of sizes rather than one. A single probe hides the
 * shape of the book: a token can look fine at $1,000 and be untradeable at
 * $50,000, and the holder who matters is the one with $50,000. The ladder is
 * also what produces a usable "how much can I sell before it costs me 1%",
 * which is the question behind the question.
 *
 * # Impact, measured against the small-size fill
 *
 * Impact is the degradation from the *best available* rate, not from an
 * external reference price. Comparing to an oracle would fold the token's NAV
 * deviation into its liquidity score, and those are two different risks that
 * the registry deliberately reports separately.
 */

export interface DepthProbe {
  /** Quote-side notional probed, at 1e6. */
  size: bigint;
  /** Base units the router would deliver, at 1e6. */
  out: bigint;
  /** Degradation from the best rate on the ladder, in bps. */
  impactBps: number;
}

export interface DepthResult {
  venue: string;
  probes: DepthProbe[];
  /** Impact at the reference size, in bps. The headline number. */
  referenceImpactBps: number;
  /** Largest ladder size whose impact stays under 100 bps, at 1e6. */
  depthAt1Pct: bigint;
  /** Routes the quote actually used, for the detail view. */
  routes: string[];
}

/** The ladder, in whole quote units. Retail through to a real position. */
export const DEFAULT_LADDER = [1_000, 5_000, 25_000, 100_000, 250_000];
export const REFERENCE_SIZE = 25_000;

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  /** Raw base units of the input mint. */
  amount: bigint;
  slippageBps?: number;
}

export interface QuoteResponse {
  /** Raw base units out. */
  outAmount: bigint;
  routes: string[];
}

export interface Router {
  readonly name: string;
  quote(request: QuoteRequest): Promise<QuoteResponse | null>;
}

/**
 * Jupiter's quote API.
 *
 * Returns null rather than throwing on a route that cannot be found: "no route"
 * is a real and important answer about a token, and it is not the same as the
 * router being down. The caller distinguishes them.
 */
export function jupiterRouter(baseUrl = "https://quote-api.jup.ag/v6"): Router {
  return {
    name: "jupiter",
    async quote({ inputMint, outputMint, amount, slippageBps = 50 }) {
      const url =
        `${baseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
        `&amount=${amount.toString()}&slippageBps=${slippageBps}` +
        `&swapMode=ExactIn&onlyDirectRoutes=false`;

      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      // 400 from Jupiter is "no route", which is data. Anything else is a
      // failure the caller should hear about.
      if (response.status === 400) return null;
      if (!response.ok) throw new Error(`jupiter ${response.status}`);

      const body = (await response.json()) as Record<string, any>;
      const outAmount = String(body.outAmount ?? "");
      if (!/^\d+$/.test(outAmount)) return null;

      const routes: string[] = [];
      for (const step of body.routePlan ?? []) {
        const label = step?.swapInfo?.label;
        if (typeof label === "string" && !routes.includes(label))
          routes.push(label);
      }

      return { outAmount: BigInt(outAmount), routes };
    },
  };
}

/**
 * Impact of each rung against the best rate on the ladder.
 *
 * Pure, so the arithmetic is testable without a router. The best rate is
 * normally the smallest rung, but not always: a pool with a concentrated range
 * can fill a mid-size order better than a dust one, and taking the max rather
 * than assuming rung zero means impact is never reported as negative.
 */
export function impactLadder(
  probes: Array<{ size: bigint; out: bigint }>,
): DepthProbe[] {
  if (probes.length === 0) return [];

  // Rate in base-out per quote-in, scaled so integer division keeps precision.
  const SCALE = 1_000_000_000_000n;
  const rate = (p: { size: bigint; out: bigint }) =>
    p.size === 0n ? 0n : (p.out * SCALE) / p.size;

  let best = 0n;
  for (const p of probes) {
    const r = rate(p);
    if (r > best) best = r;
  }
  if (best === 0n) {
    return probes.map((p) => ({ ...p, impactBps: 10_000 }));
  }

  return probes.map((p) => {
    const r = rate(p);
    // Degradation from the best rate, floored at zero.
    const impact = r >= best ? 0n : ((best - r) * 10_000n) / best;
    return { size: p.size, out: p.out, impactBps: Number(impact) };
  });
}

/** The largest rung whose impact is still under `thresholdBps`. */
export function depthUnder(probes: DepthProbe[], thresholdBps = 100): bigint {
  let deepest = 0n;
  for (const p of probes) {
    if (p.impactBps <= thresholdBps && p.size > deepest) deepest = p.size;
  }
  return deepest;
}

export interface MeasureOptions {
  router: Router;
  /** The tokenized stock being sold. */
  tokenMint: string;
  /** What it is sold for, normally USDC. */
  quoteMint: string;
  /** Decimals of the token being sold. */
  tokenDecimals: number;
  /** Approximate token price in quote units, to size the probes. */
  approxPrice: number;
  ladder?: number[];
  referenceSize?: number;
}

/**
 * Quote a ladder of sells and return the shape of the exit.
 *
 * Sells are quoted **token in, quote out**, which is the direction a holder
 * actually leaves in. Quoting the buy side instead is the other classic error
 * here: pools are frequently asymmetric, and the side that is easy to enter is
 * often the side that is hard to leave.
 */
export async function measureDepth(
  options: MeasureOptions,
): Promise<DepthResult | null> {
  const ladder = options.ladder ?? DEFAULT_LADDER;
  const reference =
    BigInt(options.referenceSize ?? REFERENCE_SIZE) * 1_000_000n;

  const probes: Array<{ size: bigint; out: bigint }> = [];
  const routes = new Set<string>();

  for (const dollars of ladder) {
    // Dollars to token base units, via the approximate price.
    const tokens = dollars / Math.max(options.approxPrice, 0.000001);
    const amount = BigInt(Math.round(tokens * 10 ** options.tokenDecimals));
    if (amount <= 0n) continue;

    const quote = await options.router.quote({
      inputMint: options.tokenMint,
      outputMint: options.quoteMint,
      amount,
    });
    // No route at this size ends the ladder: larger sizes will not route
    // either, and a gap in the middle would make the impact curve meaningless.
    if (!quote) break;

    for (const r of quote.routes) routes.add(r);
    probes.push({
      size: BigInt(dollars) * 1_000_000n,
      // Quote mints are 6-decimal in every case the registry covers; scaling
      // here keeps the ladder in one unit.
      out: quote.outAmount,
    });
  }

  if (probes.length === 0) return null;

  const withImpact = impactLadder(probes);
  const atReference =
    withImpact.find((p) => p.size === reference) ??
    // No exact rung at the reference size: use the largest rung below it,
    // which understates impact rather than overstating it.
    [...withImpact].reverse().find((p) => p.size <= reference) ??
    withImpact[withImpact.length - 1];

  return {
    venue: [...routes][0] ?? options.router.name,
    probes: withImpact,
    referenceImpactBps: atReference.impactBps,
    depthAt1Pct: depthUnder(withImpact, 100),
    routes: [...routes],
  };
}
