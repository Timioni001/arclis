/**
 * The registry's fallback dataset.
 *
 * # What this is and is not
 *
 * The live registry is built by the keeper (`keeper/src/registry.ts`) from
 * `pipeline/curated.json` plus the chain, Jupiter and the equity feed, and is
 * served at `/registry`. This file is what the page shows when that is
 * unreachable, and the interface labels it as sample data whenever it does.
 *
 * The two halves are deliberately different in kind:
 *
 *   - **Issuer facts** (structure, custodian, redemption, dividends, mints)
 *     are the real curated facts, identical to `pipeline/curated.json`. A test
 *     holds them in step, so the fallback never tells a different story from
 *     the live page.
 *   - **Market numbers** (supply, pools, prices, authorities) are samples.
 *     They exist so the scoring and the page render end to end, and they are
 *     never presented as live.
 */

import type { Issuer, MintFacts, PoolDepth, TokenizedStock } from "./types";

/** When the curated issuer facts were last checked against public sources. */
export const CHECKED_AT = "2026-10-01";

export const ISSUERS: Issuer[] = [
  {
    id: "backed",
    name: "xStocks (Backed Finance)",
    issuingEntity: "Backed Assets (JE) Limited",
    jurisdiction: "Jersey; base prospectus approved in Liechtenstein",
    structure:
      "Tracker certificate, collateralised 1:1 by the underlying share, issued under a bankruptcy-remote structure",
    regulator: "FMA Liechtenstein (prospectus approval)",
    website: "https://xstocks.fi",
    disclosureUrl: "https://assets.backed.fi/legal-documentation",
    attestationUrl: null,
    attestation: "Unverified",
    checkedAt: CHECKED_AT,
  },
  {
    id: "ondo",
    name: "Ondo Global Markets",
    issuingEntity: "Ondo Global Markets (BVI) Limited",
    jurisdiction: "British Virgin Islands; not offered to US persons",
    structure:
      "Structured note issued by a bankruptcy-remote SPV, backed 1:1 by shares held at US-registered broker-dealers",
    regulator: null,
    website: "https://ondo.finance",
    disclosureUrl: "https://docs.ondo.finance",
    attestationUrl: null,
    attestation: "Daily",
    checkedAt: CHECKED_AT,
  },
  {
    id: "backpack",
    name: "Backpack Securities",
    issuingEntity: "Backpack Securities",
    jurisdiction: "United States",
    structure:
      "Tokenized security entitlement; each token backed 1:1 by a share held in US broker-dealer custody under New York UCC Article 8",
    regulator: "US broker-dealer",
    website: "https://backpack.exchange",
    disclosureUrl: "https://learn.backpack.exchange/blog/tokenized-spacex-spcx",
    attestationUrl: null,
    attestation: "Unverified",
    checkedAt: CHECKED_AT,
  },
  {
    id: "prestocks",
    name: "PreStocks",
    issuingEntity: "PreStocks",
    jurisdiction: "Not stated in the sources Arclis checked",
    structure:
      "Token giving economic exposure to interests in SPVs that hold pre-IPO shares directly or indirectly",
    regulator: null,
    website: "https://prestocks.com",
    disclosureUrl: "https://prestocks.com",
    attestationUrl: null,
    attestation: "Unverified",
    checkedAt: CHECKED_AT,
  },
];

export function issuerById(id: string): Issuer | undefined {
  return ISSUERS.find((i) => i.id === id);
}

const P = 1_000_000n;
const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));

/** A recent weekday close, so the sample session and timestamps line up. */
const REFERENCE_TS = Math.floor(Date.UTC(2026, 8, 30, 20, 0, 0) / 1000);

/**
 * Sample mint state. Regulated share tokens keep both authorities, so the
 * sample does too; the live registry reads the real ones from the chain.
 */
function sampleMint(
  mint: string,
  decimals: number,
  supplyTokens: number,
  extensions: string[],
): MintFacts {
  return {
    mint,
    decimals,
    supply: usd(supplyTokens),
    mintAuthority: "sample",
    freezeAuthority: "sample",
    extensions,
  };
}

function pool(
  venue: string,
  quoteLiquidity: number,
  sellImpactBps: number,
  volume24h: number,
): PoolDepth {
  return {
    venue,
    poolAddress: `sample-${venue}`,
    quoteLiquidity: usd(quoteLiquidity),
    baseLiquidity: 0n,
    sellImpactBps,
    depthProbeQuote: usd(25_000),
    volume24h: usd(volume24h),
  };
}

export const TOKENIZED_STOCKS: TokenizedStock[] = [
  {
    symbol: "AAPLx",
    underlying: "AAPL",
    referenceSymbol: "AAPL",
    name: "Apple Inc.",
    issuerId: "backed",
    backing: "Redeemable",
    redemption: "VerifiedHolders",
    custodian: "Alpaca Securities LLC, with InCore Bank AG as backup",
    dividendTreatment:
      "Reinvested. On Solana the token's display multiplier (the Scaled UI amount extension) rises instead of cash being paid.",
    corporateActionPolicy:
      "Splits are reflected through the same display multiplier, adjusted by the issuer.",
    issuerRisk:
      "You hold a certificate issued by Backed, not the share itself. If the issuer fails, the bankruptcy-remote structure and a security agent stand between you and the collateral; you are not an Apple shareholder.",
    mint: sampleMint("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", 8, 41200, [
      "Scaled UI amount",
    ]),
    pools: [
      pool("Raydium CLMM", 2340000, 18, 1820000),
      pool("Meteora DLMM", 860000, 41, 640000),
    ],
    onChainPrice: usd(254.9),
    referencePrice: usd(254.2),
    referenceTs: REFERENCE_TS,
    referenceSession: "Closed",
    arclisSymbol: "AAPL",
  },
  {
    symbol: "AAPLon",
    underlying: "AAPL",
    referenceSymbol: "AAPL",
    name: "Apple Inc.",
    issuerId: "ondo",
    backing: "Redeemable",
    redemption: "VerifiedHolders",
    custodian: "US-registered broker-dealers",
    dividendTreatment:
      "Total return. Dividends are reinvested and show up as more tokens in your balance.",
    corporateActionPolicy: "Handled by the issuer at the note level.",
    issuerRisk:
      "You hold a note issued by an SPV, not the share. The SPV is bankruptcy-remote, and minting and redemption are open only to eligible, onboarded non-US investors; everyone else exits by selling.",
    mint: sampleMint(
      "123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo",
      6,
      30500,
      [],
    ),
    pools: [pool("Meteora DLMM", 620000, 35, 410000)],
    onChainPrice: usd(255.4),
    referencePrice: usd(254.2),
    referenceTs: REFERENCE_TS,
    referenceSession: "Closed",
    arclisSymbol: "AAPL",
  },
  {
    symbol: "NVDAx",
    underlying: "NVDA",
    referenceSymbol: "NVDA",
    name: "NVIDIA Corporation",
    issuerId: "backed",
    backing: "Redeemable",
    redemption: "VerifiedHolders",
    custodian: "Alpaca Securities LLC, with InCore Bank AG as backup",
    dividendTreatment:
      "Reinvested through the display multiplier. NVIDIA's yield is small either way.",
    corporateActionPolicy:
      "Splits are reflected through the display multiplier, adjusted by the issuer.",
    issuerRisk:
      "A certificate claim against Backed's collateral, not a direct NVIDIA holding.",
    mint: sampleMint("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", 8, 88400, [
      "Scaled UI amount",
    ]),
    pools: [pool("Raydium CLMM", 4120000, 11, 5640000)],
    onChainPrice: usd(183.4),
    referencePrice: usd(182.9),
    referenceTs: REFERENCE_TS,
    referenceSession: "Closed",
    arclisSymbol: "NVDA",
  },
  {
    symbol: "GOOGLx",
    underlying: "GOOGL",
    referenceSymbol: "GOOGL",
    name: "Alphabet Inc. Class A",
    issuerId: "backed",
    backing: "Redeemable",
    redemption: "VerifiedHolders",
    custodian: "Alpaca Securities LLC, with InCore Bank AG as backup",
    dividendTreatment: "Reinvested through the display multiplier.",
    corporateActionPolicy:
      "Splits are reflected through the display multiplier, adjusted by the issuer.",
    issuerRisk:
      "A certificate claim against Backed's collateral, not a direct Alphabet holding.",
    mint: sampleMint("XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", 8, 9640, [
      "Scaled UI amount",
    ]),
    pools: [pool("Raydium CLMM", 1050000, 33, 720000)],
    onChainPrice: usd(247.8),
    referencePrice: usd(247.1),
    referenceTs: REFERENCE_TS,
    referenceSession: "Closed",
    arclisSymbol: "GOOGL",
  },
  {
    symbol: "SPYx",
    underlying: "SPY",
    referenceSymbol: "SPY",
    name: "SPDR S&P 500 ETF Trust",
    issuerId: "backed",
    backing: "Redeemable",
    redemption: "VerifiedHolders",
    custodian: "Alpaca Securities LLC, with InCore Bank AG as backup",
    dividendTreatment:
      "ETF distributions are reinvested through the display multiplier.",
    corporateActionPolicy:
      "Reflected through the display multiplier, adjusted by the issuer.",
    issuerRisk:
      "A certificate claim against Backed's collateral, not a direct holding of the ETF.",
    mint: sampleMint("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", 8, 18300, [
      "Scaled UI amount",
    ]),
    pools: [pool("Meteora DLMM", 2900000, 14, 2100000)],
    onChainPrice: usd(662.1),
    referencePrice: usd(661.4),
    referenceTs: REFERENCE_TS,
    referenceSession: "Closed",
    arclisSymbol: "SPY",
  },
  {
    symbol: "SPCX",
    underlying: "SpaceX (SPCX)",
    referenceSymbol: "SPCX",
    name: "Space Exploration Technologies Corp.",
    issuerId: "backpack",
    backing: "Redeemable",
    redemption: "VerifiedHolders",
    custodian: "Backpack Securities (US broker-dealer custody)",
    dividendTreatment:
      "Holders are entitled to cash dividends and corporate actions on the underlying share.",
    corporateActionPolicy:
      "Passed through by Backpack Securities as the broker-dealer holding the share.",
    issuerRisk:
      "The token is a security entitlement to a real share at a US broker-dealer. Verified holders can redeem it and move the share to another brokerage; unverified holders exit by selling.",
    mint: sampleMint(
      "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
      6,
      45000,
      [],
    ),
    pools: [pool("Meteora DLMM", 1800000, 52, 420000)],
    onChainPrice: usd(161.8),
    referencePrice: usd(160.9),
    referenceTs: REFERENCE_TS,
    referenceSession: "Closed",
    arclisSymbol: null,
  },
  {
    symbol: "OPENAI",
    underlying: "OpenAI (private)",
    referenceSymbol: null,
    name: "OpenAI (pre-IPO exposure)",
    issuerId: "prestocks",
    backing: "IssuerAttested",
    redemption: "None",
    custodian: null,
    dividendTreatment:
      "Not applicable. OpenAI is private and pays no dividend.",
    corporateActionPolicy:
      "Depends on the SPVs behind the token, which hold OpenAI exposure directly or indirectly.",
    issuerRisk:
      "You do not own OpenAI shares. The token tracks the issuer's SPV exposure, and with no listed share there is no public price to check it against: the pool is the market.",
    mint: sampleMint(
      "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
      6,
      27000,
      [],
    ),
    pools: [pool("Meteora DLMM", 190000, 780, 2100000)],
    onChainPrice: usd(71.4),
    referencePrice: usd(0),
    referenceTs: 0,
    referenceSession: "Closed",
    arclisSymbol: null,
  },
];

/**
 * The seam a live pipeline implements.
 *
 * `kind` is read by the UI to decide whether to show the modelled-data banner,
 * the same way `DataSource.kind` does for the protocol side. A source that
 * cannot say where its numbers came from does not get to render without a
 * label.
 */
export interface RegistrySource {
  kind: "modelled" | "live";
  issuers(): Issuer[];
  stocks(): TokenizedStock[];
  stock(symbol: string): TokenizedStock | undefined;
  /** When the underlying data was last refreshed, unix seconds. */
  asOf(): number;
}

export function modelledRegistry(): RegistrySource {
  return {
    kind: "modelled",
    issuers: () => ISSUERS,
    stocks: () => TOKENIZED_STOCKS,
    stock: (symbol) =>
      TOKENIZED_STOCKS.find(
        (s) => s.symbol.toLowerCase() === symbol.toLowerCase(),
      ),
    asOf: () => REFERENCE_TS,
  };
}

/** Exported for tests and for the pipeline to reuse the same rounding. */
export const REGISTRY_UNIT = P;
