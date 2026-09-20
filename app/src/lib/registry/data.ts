/**
 * The registry's data source.
 *
 * # What this is and is not
 *
 * The rows below are a **modelled dataset**, not a live feed, and the interface
 * says so on every screen that renders them. They are shaped from the public
 * structure of the four issuer families shipping tokenized equities on Solana,
 * and they exist so the pipeline, the scoring and the page can be built and
 * tested end to end before any key is issued.
 *
 * Shipping this as if it were live would be the exact failure the product is
 * about, so it is not presented that way anywhere. `RegistrySource` is the seam
 * a real pipeline drops into: the same interface, backed by issuer disclosures,
 * `getAccountInfo` on each mint, and Jupiter quote calls for depth. Every field
 * carries a `disclosureUrl` because the intended end state is that no number
 * here is takeable on trust, including ours.
 *
 * # Where each field would come from
 *
 *   mint authorities, supply, extensions -> `getAccountInfo(mint)`, parsed
 *   pool depth and impact                -> Jupiter `/quote` at several sizes
 *   on-chain price                       -> the deepest pool's mid
 *   reference price and session          -> the same equity feed Arclis reads
 *   structure, custody, redemption       -> the issuer's own disclosure PDF
 *
 * Only the last one needs a human, which is why it is the one with a link
 * beside it.
 */

import type { Issuer, TokenizedStock } from "./types";

export const ISSUERS: Issuer[] = [
  {
    id: "backed",
    name: "Backed Finance (xStocks)",
    jurisdiction: "Switzerland / Liechtenstein",
    structure:
      "Tracker certificate issued under a Liechtenstein base prospectus",
    regulator: "FMA Liechtenstein",
    disclosureUrl: "https://backed.fi/legal-documentation",
    attestationUrl: "https://backed.fi/transparency",
    attestation: "Daily",
  },
  {
    id: "ondo",
    name: "Ondo Finance",
    jurisdiction: "United States / British Virgin Islands",
    structure: "Tokenized note issued by a bankruptcy-remote SPV",
    regulator: "SEC-registered transfer agent in the structure",
    disclosureUrl: "https://ondo.finance/global-markets",
    attestationUrl: "https://ondo.finance/transparency",
    attestation: "Daily",
  },
  {
    id: "backpack",
    name: "Backpack Exchange",
    jurisdiction: "United Arab Emirates",
    structure: "Exchange-issued claim against exchange-held custody",
    regulator: "VARA Dubai",
    disclosureUrl: "https://backpack.exchange/legal",
    attestationUrl: null,
    attestation: "Monthly",
  },
  {
    id: "prestocks",
    name: "PreStocks",
    jurisdiction: "Undisclosed",
    structure: "Synthetic price tracker, no stated share custody",
    regulator: null,
    disclosureUrl: "https://prestocks.com",
    attestationUrl: null,
    attestation: "None",
  },
];

export function issuerById(id: string): Issuer | undefined {
  return ISSUERS.find((i) => i.id === id);
}

const P = 1_000_000n;
const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));

/** A recent weekday close, so the seeded session and timestamps line up. */
const REFERENCE_TS = Math.floor(Date.UTC(2026, 8, 18, 20, 0, 0) / 1000);

export const TOKENIZED_STOCKS: TokenizedStock[] = [
  {
    symbol: "AAPLx",
    underlying: "AAPL",
    name: "Apple Inc.",
    issuerId: "backed",
    backing: "Redeemable",
    redemption: "VerifiedHolders",
    custodian: "InCore Bank AG",
    dividendTreatment:
      "Cash dividends accrue into the certificate's value rather than being paid out, so the token price steps up instead of you receiving cash.",
    corporateActionPolicy:
      "Splits and mergers are passed through by the issuer, who adjusts the certificate ratio.",
    issuerRisk:
      "You hold a certificate issued by Backed, not the share itself. If the issuer fails, you are a creditor against the collateral pool, not an Apple shareholder.",
    mint: {
      mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
      decimals: 6,
      supply: usd(412_000),
      mintAuthority: "BkdMintAuth11111111111111111111111111111111",
      freezeAuthority: "BkdFreezeAuth1111111111111111111111111111111",
      extensions: [],
    },
    pools: [
      {
        venue: "Raydium CLMM",
        poolAddress: "RayAAPLx1111111111111111111111111111111111",
        quoteLiquidity: usd(2_340_000),
        baseLiquidity: usd(9_180),
        sellImpactBps: 18,
        depthProbeQuote: usd(25_000),
        volume24h: usd(1_820_000),
      },
      {
        venue: "Meteora DLMM",
        poolAddress: "MetAAPLx111111111111111111111111111111111",
        quoteLiquidity: usd(860_000),
        baseLiquidity: usd(3_400),
        sellImpactBps: 41,
        depthProbeQuote: usd(25_000),
        volume24h: usd(640_000),
      },
    ],
    onChainPrice: usd(254.9),
    referencePrice: usd(254.2),
    referenceTs: REFERENCE_TS,
    referenceSession: "Closed",
    arclisSymbol: "AAPL",
  },
  {
    symbol: "NVDAx",
    underlying: "NVDA",
    name: "NVIDIA Corporation",
    issuerId: "backed",
    backing: "Redeemable",
    redemption: "VerifiedHolders",
    custodian: "InCore Bank AG",
    dividendTreatment:
      "Accrues into the certificate value. NVIDIA's yield is negligible either way.",
    corporateActionPolicy:
      "Passed through. The 2024 10-for-1 split was handled by ratio adjustment.",
    issuerRisk:
      "Creditor claim against Backed's collateral pool if the issuer fails, not a direct NVIDIA holding.",
    mint: {
      mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
      decimals: 6,
      supply: usd(198_500),
      mintAuthority: "BkdMintAuth11111111111111111111111111111111",
      freezeAuthority: "BkdFreezeAuth1111111111111111111111111111111",
      extensions: [],
    },
    pools: [
      {
        venue: "Raydium CLMM",
        poolAddress: "RayNVDAx1111111111111111111111111111111111",
        quoteLiquidity: usd(4_120_000),
        baseLiquidity: usd(22_400),
        sellImpactBps: 11,
        depthProbeQuote: usd(25_000),
        volume24h: usd(5_640_000),
      },
    ],
    onChainPrice: usd(183.4),
    referencePrice: usd(182.9),
    referenceTs: REFERENCE_TS,
    referenceSession: "Closed",
    arclisSymbol: "NVDA",
  },
  {
    symbol: "oUSTB-MSFT",
    underlying: "MSFT",
    name: "Microsoft Corporation",
    issuerId: "ondo",
    backing: "CustodyBacked",
    redemption: "AuthorizedParticipants",
    custodian: "Clear Street LLC",
    dividendTreatment:
      "Dividends are collected by the SPV and reflected in NAV. Holders do not receive cash directly.",
    corporateActionPolicy:
      "Handled at the SPV level; token supply is adjusted to match.",
    issuerRisk:
      "The SPV is bankruptcy-remote, which is stronger than an operating-company claim, but redemption runs through authorized participants. Retail exits by selling.",
    mint: {
      mint: "OndoMSFT111111111111111111111111111111111111",
      decimals: 6,
      supply: usd(88_000),
      mintAuthority: "OndoMintAuth1111111111111111111111111111111",
      freezeAuthority: "OndoFreezeAuth11111111111111111111111111111",
      extensions: ["Transfer hook: allowlist"],
    },
    pools: [
      {
        venue: "Orca Whirlpool",
        poolAddress: "OrcaMSFT11111111111111111111111111111111",
        quoteLiquidity: usd(410_000),
        baseLiquidity: usd(760),
        sellImpactBps: 142,
        depthProbeQuote: usd(25_000),
        volume24h: usd(96_000),
      },
    ],
    onChainPrice: usd(519.1),
    referencePrice: usd(511.6),
    referenceTs: REFERENCE_TS,
    referenceSession: "Closed",
    arclisSymbol: "MSFT",
  },
  {
    symbol: "SPCX-TSLA",
    underlying: "TSLA",
    name: "Tesla, Inc.",
    issuerId: "backpack",
    backing: "CustodyBacked",
    redemption: "VerifiedHolders",
    custodian: "Backpack Exchange (self-custody)",
    dividendTreatment:
      "Tesla pays no dividend, so the question has not been tested for this token.",
    corporateActionPolicy:
      "Stated as handled by the exchange. No published mechanism for how a split is reflected on-chain.",
    issuerRisk:
      "The custodian and the issuer are the same company. That is one balance sheet standing behind both halves of the claim, which is materially weaker than a third-party custodian.",
    mint: {
      mint: "SPCXTSLA1111111111111111111111111111111111",
      decimals: 6,
      supply: usd(140_000),
      mintAuthority: "BpkMintAuth11111111111111111111111111111111",
      freezeAuthority: "BpkFreezeAuth1111111111111111111111111111111",
      extensions: [],
    },
    pools: [
      {
        venue: "Meteora DLMM",
        poolAddress: "MetTSLA11111111111111111111111111111111111",
        quoteLiquidity: usd(1_240_000),
        baseLiquidity: usd(2_900),
        sellImpactBps: 64,
        depthProbeQuote: usd(25_000),
        volume24h: usd(880_000),
      },
    ],
    onChainPrice: usd(441.2),
    referencePrice: usd(438.0),
    referenceTs: REFERENCE_TS,
    referenceSession: "Closed",
    arclisSymbol: "TSLA",
  },
  {
    symbol: "preOPENAI",
    underlying: "OPENAI (private)",
    name: "OpenAI (pre-IPO exposure)",
    issuerId: "prestocks",
    backing: "Synthetic",
    redemption: "None",
    custodian: null,
    dividendTreatment: "Not applicable. Nothing is held and nothing is paid.",
    corporateActionPolicy:
      "None. There is no share for an action to happen to.",
    issuerRisk:
      "This token holds nothing. Its price is whatever the pool says it is, and the reference is an estimated private valuation, not a traded price. If the issuer stops supporting it, the only floor is the pool.",
    mint: {
      mint: "PreOpenAI111111111111111111111111111111111",
      decimals: 6,
      supply: usd(1_950_000),
      mintAuthority: "PreMintAuth11111111111111111111111111111111",
      freezeAuthority: null,
      extensions: [],
    },
    pools: [
      {
        venue: "Raydium CPMM",
        poolAddress: "RayPreOpenAI1111111111111111111111111111",
        quoteLiquidity: usd(190_000),
        baseLiquidity: usd(3_100),
        sellImpactBps: 780,
        depthProbeQuote: usd(25_000),
        volume24h: usd(2_100_000),
      },
    ],
    onChainPrice: usd(71.4),
    referencePrice: usd(61.0),
    referenceTs: REFERENCE_TS,
    // A private company has no session. Modelled as Closed: there is a
    // reference mark, it is stale by construction, and it never opens.
    referenceSession: "Closed",
    arclisSymbol: null,
  },
  {
    symbol: "GOOGLx",
    underlying: "GOOGL",
    name: "Alphabet Inc. Class A",
    issuerId: "backed",
    backing: "Redeemable",
    redemption: "VerifiedHolders",
    custodian: "InCore Bank AG",
    dividendTreatment: "Accrues into the certificate value.",
    corporateActionPolicy: "Passed through by ratio adjustment.",
    issuerRisk:
      "Creditor claim against the Backed collateral pool if the issuer fails.",
    mint: {
      mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
      decimals: 6,
      supply: usd(96_400),
      mintAuthority: "BkdMintAuth11111111111111111111111111111111",
      freezeAuthority: "BkdFreezeAuth1111111111111111111111111111111",
      extensions: [],
    },
    pools: [
      {
        venue: "Raydium CLMM",
        poolAddress: "RayGOOGLx111111111111111111111111111111111",
        quoteLiquidity: usd(1_050_000),
        baseLiquidity: usd(4_200),
        sellImpactBps: 33,
        depthProbeQuote: usd(25_000),
        volume24h: usd(720_000),
      },
    ],
    onChainPrice: usd(247.8),
    referencePrice: usd(247.1),
    referenceTs: REFERENCE_TS,
    referenceSession: "Closed",
    arclisSymbol: "GOOGL",
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
