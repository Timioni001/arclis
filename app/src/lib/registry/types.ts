/**
 * The tokenized-equity registry read model.
 *
 * Four issuers are shipping products on Solana that render as an identical
 * price chart and are not the same instrument at all. One is a redeemable
 * claim on a share held by a regulated custodian. One is a note issued by a
 * company that holds the shares. One tracks the price and holds nothing. A
 * holder cannot tell which they own by looking at a wallet, and no issuer puts
 * the comparison on one page, because the comparison is not flattering to
 * everyone on it.
 *
 * So this is the read model for that page. It is deliberately a *separate*
 * model from `protocol/types.ts`: the registry describes instruments Arclis
 * does not issue, custody, or trade, and the moment those two models share a
 * type is the moment someone reads an Arclis market as an endorsement of a
 * third-party token.
 *
 * The one thing they do share is scale discipline. Every price and ratio here
 * is a `bigint` at a named scale, for the same reason the protocol types are:
 * a NAV deviation computed in floating point and then compared against a
 * threshold is a bug waiting for the day the two sides are equal.
 */

/** Prices, NAV and premiums, at 1e6. Same scale as the protocol's PRICE_SCALE. */
export const REGISTRY_PRICE_SCALE = 1_000_000n;

/** Ratios expressed in basis points. 10_000 == 100%. */
export const REGISTRY_BPS_SCALE = 10_000n;

/**
 * What a holder's claim actually is, strongest first.
 *
 * This ordering is the spine of the whole product, so it is an explicit,
 * ordered scale rather than a free-form string. The rank is what sorts,
 * filters and colours; the label is what a person reads.
 */
export type BackingTier =
  /** A legal right to redeem the token for the underlying share, or its cash
   *  value, from a named entity, enforceable by the holder. */
  | "Redeemable"
  /** Real shares are held by a named custodian and attested, but the holder
   *  cannot themselves demand them - redemption runs through the issuer, or is
   *  limited to qualified participants. */
  | "CustodyBacked"
  /** The issuer says shares exist somewhere. No named custodian, no attestation
   *  schedule, or both. */
  | "IssuerAttested"
  /** Nothing is held. The token tracks a price by construction - a swap, a
   *  perp, an oracle-fed mint. This is not a criticism: a synthetic that says
   *  it is synthetic is honest. It is a criticism when it is not disclosed. */
  | "Synthetic";

export const BACKING_RANK: Record<BackingTier, number> = {
  Redeemable: 4,
  CustodyBacked: 3,
  IssuerAttested: 2,
  Synthetic: 1,
};

export const BACKING_LABEL: Record<BackingTier, string> = {
  Redeemable: "Redeemable",
  CustodyBacked: "Custody backed",
  IssuerAttested: "Issuer attested",
  Synthetic: "Synthetic",
};

/** Who, concretely, can ask for the share back. */
export type RedemptionAccess =
  /** Anyone holding the token. */
  | "AnyHolder"
  /** Only KYC'd accounts with the issuer. */
  | "VerifiedHolders"
  /** Only authorised participants - market makers, in size. Retail exits by
   *  selling on a DEX, which is why pool depth matters so much for these. */
  | "AuthorizedParticipants"
  /** Nobody. */
  | "None";

export const REDEMPTION_LABEL: Record<RedemptionAccess, string> = {
  AnyHolder: "Any holder",
  VerifiedHolders: "Verified holders",
  AuthorizedParticipants: "Authorized participants",
  None: "Not redeemable",
};

/** How often somebody who is not the issuer checks the shares are there. */
export type AttestationCadence =
  "Realtime" | "Daily" | "Monthly" | "Quarterly" | "None";

export const ATTESTATION_LABEL: Record<AttestationCadence, string> = {
  Realtime: "Continuous",
  Daily: "Daily",
  Monthly: "Monthly",
  Quarterly: "Quarterly",
  None: "None published",
};

export interface Issuer {
  id: string;
  name: string;
  /** Jurisdiction the issuing entity is organised in. */
  jurisdiction: string;
  /** The legal wrapper a holder is actually inside. */
  structure: string;
  /** Named regulator, or null where the structure is unregulated. */
  regulator: string | null;
  /** Public URL for the disclosure this row was read from. Every claim on the
   *  page is meant to be checkable, and a claim with no link is not. */
  disclosureUrl: string;
  /** Where attestations are published, when they are. */
  attestationUrl: string | null;
  attestation: AttestationCadence;
}

/**
 * On-chain facts about the mint, read from the chain rather than from the
 * issuer. These are the ones an issuer cannot spin: either the freeze authority
 * is set or it is not.
 */
export interface MintFacts {
  mint: string;
  decimals: number;
  /** Supply in whole tokens at 1e6. */
  supply: bigint;
  /** Set means somebody can mint more. Null means the supply is fixed. */
  mintAuthority: string | null;
  /** Set means somebody can freeze a holder's balance. For a regulated
   *  security token this is usually *required*, so it is reported, not
   *  penalised - but it is never hidden either. */
  freezeAuthority: string | null;
  /** Token-2022 transfer hooks and permanent-delegate extensions in force. */
  extensions: string[];
}

/** One DEX pool holding this token, and how deep it actually is. */
export interface PoolDepth {
  venue: string;
  poolAddress: string;
  /** Quote-side liquidity in quote units at 1e6. */
  quoteLiquidity: bigint;
  /** Base-side liquidity in token units at 1e6. */
  baseLiquidity: bigint;
  /** Price impact in bps of selling `depthProbeQuote` worth. The honest
   *  measure of an exit: TVL says what is in the pool, impact says what leaving
   *  costs. */
  sellImpactBps: number;
  /** The trade size `sellImpactBps` was measured at, quote units at 1e6. */
  depthProbeQuote: bigint;
  volume24h: bigint;
}

/** One tokenized equity, as a holder would need to understand it. */
export interface TokenizedStock {
  /** The token's own ticker, which is often not the stock's. */
  symbol: string;
  /** The stock it references. */
  underlying: string;
  name: string;
  issuerId: string;

  backing: BackingTier;
  redemption: RedemptionAccess;
  /** Named custodian, or null when nobody is named. */
  custodian: string | null;
  /** Does the holder receive dividends, and how? Free text because the answers
   *  genuinely differ in kind: cash, extra tokens, NAV accrual, or nothing. */
  dividendTreatment: string;
  /** Are splits and other corporate actions handled, and by whom? */
  corporateActionPolicy: string;
  /** Plain-sentence statement of what breaks if the issuer disappears. */
  issuerRisk: string;

  mint: MintFacts;
  pools: PoolDepth[];

  /** Last traded price on-chain, at REGISTRY_PRICE_SCALE. */
  onChainPrice: bigint;
  /** The reference stock's price, at REGISTRY_PRICE_SCALE. */
  referencePrice: bigint;
  /** When the reference price was taken. */
  referenceTs: number;
  /** The reference venue's session, which decides whether a deviation is a
   *  warning or just arithmetic. Reuses the protocol's own session type,
   *  because it is the same question. */
  referenceSession: import("../protocol/types").MarketSession;

  /** Is there an Arclis market on this underlying? Cross-links the two halves
   *  of the product without conflating them. */
  arclisSymbol: string | null;
}
