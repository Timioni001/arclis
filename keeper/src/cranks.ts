/**
 * The two permissionless cranks: funding, and liquidation.
 *
 * Neither needs privilege. Anyone can call both, and that is the design: the
 * protocol pays for them out of fees and penalties precisely so it does not
 * depend on one operator staying up. These implementations exist so somebody
 * is definitely running them, not because only this code may.
 *
 * Without a liquidator in particular, every solvency guarantee in the program
 * is theoretical: the loss waterfall only runs when something calls
 * `liquidate`, and a position that nobody closes becomes bad debt that the
 * pool eats.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BorshCoder } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import idl from "../../idl/arclis.json";
import { send, type ChainConfig } from "./chain";

const coder = new BorshCoder(idl as never);

const seed = (s: string) => Buffer.from(new TextEncoder().encode(s));

function pda(programId: PublicKey, parts: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(parts, programId)[0];
}

export interface MarketAddresses {
  symbol: string;
  oracle: PublicKey;
  market: PublicKey;
  marketVault: PublicKey;
  pool: PublicKey;
  poolVault: PublicKey;
  config: PublicKey;
}

export function addressesFor(
  programId: PublicKey,
  symbol: string,
): MarketAddresses {
  const symbolSeed = new Uint8Array(16);
  symbolSeed.set(new TextEncoder().encode(symbol));

  const oracle = pda(programId, [seed("oracle"), Buffer.from(symbolSeed)]);
  const market = pda(programId, [seed("market"), oracle.toBuffer()]);
  const pool = pda(programId, [seed("lp_pool"), market.toBuffer()]);

  return {
    symbol,
    oracle,
    market,
    marketVault: pda(programId, [seed("vault"), market.toBuffer()]),
    pool,
    poolVault: pda(programId, [seed("lp_vault"), pool.toBuffer()]),
    config: pda(programId, [seed("config")]),
  };
}

function ix(
  programId: PublicKey,
  name: string,
  args: Record<string, unknown>,
  keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys,
    data: coder.instruction.encode(name, args),
  });
}

const ro = (pubkey: PublicKey) => ({
  pubkey,
  isSigner: false,
  isWritable: false,
});
const rw = (pubkey: PublicKey) => ({
  pubkey,
  isSigner: false,
  isWritable: true,
});

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

/**
 * Crank funding on every market that is due.
 *
 * `FundingNotDue` is the expected answer most of the time and is treated as
 * success-with-nothing-to-do, not as an error. Calling early costs a
 * transaction fee and changes nothing on-chain, which is why calling it on a
 * short interval is safe: the program decides when funding accrues, not this.
 */
export async function crankFunding(
  config: ChainConfig,
  symbols: string[],
): Promise<{ cranked: string[]; notDue: string[] }> {
  const cranked: string[] = [];
  const notDue: string[] = [];

  for (const symbol of symbols) {
    const a = addressesFor(config.programId, symbol);
    const outcome = await send(
      config,
      [
        ix(config.programId, "crank_funding", {}, [
          { pubkey: config.payer.publicKey, isSigner: true, isWritable: false },
          ro(a.config),
          rw(a.market),
          ro(a.oracle),
          ro(a.pool),
          ro(a.poolVault),
        ]),
      ],
      `crank_funding ${symbol}`,
    );

    if (outcome.ok) {
      cranked.push(symbol);
      config.log("info", `funding accrued on ${symbol}`, {
        signature: outcome.signature,
      });
    } else if (outcome.benign) {
      notDue.push(symbol);
    }
  }

  return { cranked, notDue };
}

// ---------------------------------------------------------------------------
// Liquidation
// ---------------------------------------------------------------------------

/** A position account as the scanner needs it. */
export interface ScannedPosition {
  address: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  size: bigint;
  entryPrice: bigint;
  collateral: bigint;
  entryFundingIndex: bigint;
}

/**
 * Find every position in a market, by scanning the program's accounts.
 *
 * `getProgramAccounts` with a discriminator filter is the only way to enumerate
 * positions: the program cannot iterate them and neither can a PDA derivation,
 * because the owner is part of the seed and the set of owners is not known.
 *
 * The `market` filter is applied server-side via `memcmp` so the RPC does the
 * work. Without it this downloads every position in every market on every
 * pass, which is how a liquidator gets itself rate limited off its own
 * endpoint.
 */
export async function scanPositions(
  config: ChainConfig,
  market: PublicKey,
): Promise<ScannedPosition[]> {
  const discriminator = (
    coder.accounts as unknown as { accountDiscriminator(name: string): Buffer }
  ).accountDiscriminator("position");

  const accounts = await config.connection.getProgramAccounts(
    config.programId,
    {
      filters: [
        { memcmp: { offset: 0, bytes: bs58(discriminator) } },
        // owner (32) sits after the 8-byte discriminator, market follows it.
        { memcmp: { offset: 8 + 32, bytes: market.toBase58() } },
      ],
    },
  );

  const out: ScannedPosition[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const decoded = coder.accounts.decode("position", account.data) as Record<
        string,
        any
      >;
      out.push({
        address: pubkey,
        owner: decoded.owner,
        market: decoded.market,
        size: BigInt(decoded.size.toString()),
        entryPrice: BigInt(decoded.entryPrice.toString()),
        collateral: BigInt(decoded.collateral.toString()),
        entryFundingIndex: BigInt(decoded.entryFundingIndex.toString()),
      });
    } catch {
      // A future account layout, or a partially written account. Skipping one
      // row must not stop the scan finding the others.
    }
  }
  return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/**
 * Health, computed exactly as the program computes it.
 *
 * Duplicated deliberately rather than approximated: the scanner uses it only
 * to decide which positions are *worth submitting*, and the program re-checks
 * before doing anything. An optimistic estimate costs a failed transaction; a
 * pessimistic one costs a missed liquidation and, eventually, bad debt. The
 * pessimistic direction is the expensive one, so this errs toward submitting.
 */
export function marginRatioBps(
  position: ScannedPosition,
  markPrice: bigint,
  marketFundingIndex: bigint,
): bigint {
  const PRICE_SCALE = 1_000_000n;
  const FUNDING_SCALE = 1_000_000_000n;

  const size = position.size;
  if (size === 0n) return 0n;

  const abs = size < 0n ? -size : size;
  const notional = (abs * markPrice) / PRICE_SCALE;
  if (notional === 0n) return 0n;

  const unrealised = (size * (markPrice - position.entryPrice)) / PRICE_SCALE;
  const fundingOwed =
    (size * (marketFundingIndex - position.entryFundingIndex)) / FUNDING_SCALE;

  const equity = BigInt(position.collateral) + unrealised - fundingOwed;
  return (equity * 10_000n) / notional;
}

export interface LiquidatorOptions {
  config: ChainConfig;
  symbols: string[];
  /** The liquidator's quote token account. Derived when omitted. */
  quoteMint: PublicKey;
  /**
   * Submit anything within this many bps above maintenance, not just below it.
   *
   * The price moves between the scan and the landing, so a scanner that only
   * submits what is already underwater is a scanner that is always one block
   * late. The cost of being early is a `PositionHealthy` rejection, which is
   * a transaction fee.
   */
  marginBufferBps?: number;
}

/**
 * One liquidation pass over every market.
 *
 * Refuses to act while the venue is not open in a way that permits reducing
 * risk. The program enforces this too, but checking here saves a transaction
 * per underwater position per pass during a halt, which over a long halt is
 * not nothing.
 */
export async function liquidatePass(options: LiquidatorOptions): Promise<{
  scanned: number;
  attempted: number;
  liquidated: string[];
}> {
  const { config, symbols, quoteMint } = options;
  const buffer = BigInt(options.marginBufferBps ?? 50);

  let scanned = 0;
  let attempted = 0;
  const liquidated: string[] = [];

  const liquidatorAta = getAssociatedTokenAddressSync(
    quoteMint,
    config.payer.publicKey,
    true,
  );

  for (const symbol of symbols) {
    const a = addressesFor(config.programId, symbol);

    const [marketInfo, oracleInfo] =
      await config.connection.getMultipleAccountsInfo([a.market, a.oracle]);
    if (!marketInfo || !oracleInfo) continue;

    const market = coder.accounts.decode("market", marketInfo.data) as Record<
      string,
      any
    >;
    const oracle = coder.accounts.decode(
      "priceOracle",
      oracleInfo.data,
    ) as Record<string, any>;

    const session = Object.keys(oracle.session ?? {})[0]?.toLowerCase();
    // PreOpen and Halted have no usable mark, so the program refuses to
    // liquidate against them. Closed is fine: that is the settled price.
    if (session === "preopen" || session === "halted") continue;

    const markPrice = BigInt(oracle.price.toString());
    const fundingIndex = BigInt(market.cumulativeFundingIndex.toString());
    const maintenance = BigInt(market.maintenanceMarginBps);

    const positions = await scanPositions(config, a.market);
    scanned += positions.length;

    for (const position of positions) {
      if (position.size === 0n) continue;
      const ratio = marginRatioBps(position, markPrice, fundingIndex);
      if (ratio >= maintenance + buffer) continue;

      attempted++;
      const outcome = await send(
        config,
        [
          ix(config.programId, "liquidate", {}, [
            {
              pubkey: config.payer.publicKey,
              isSigner: true,
              isWritable: false,
            },
            rw(liquidatorAta),
            ro(a.config),
            rw(a.market),
            ro(a.oracle),
            rw(position.address),
            rw(a.marketVault),
            rw(a.pool),
            rw(a.poolVault),
            ro(TOKEN_PROGRAM_ID),
          ]),
        ],
        `liquidate ${symbol} ${position.owner.toBase58().slice(0, 8)}`,
      );

      if (outcome.ok) {
        liquidated.push(position.address.toBase58());
        config.log("info", `liquidated a position on ${symbol}`, {
          owner: position.owner.toBase58(),
          marginBps: ratio.toString(),
          signature: outcome.signature,
        });
      }
    }
  }

  return { scanned, attempted, liquidated };
}
