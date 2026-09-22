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
  // "Position", for the same reason the decode below says "Position": the IDL
  // spells it that way and a raw `BorshCoder` does not translate.
  //
  // This one hid behind the other. Fixing only the decode left this throwing
  // "Account not found: position" from a different method on the same object,
  // and had it not thrown it would have been worse - a discriminator for the
  // wrong name is a memcmp filter that matches nothing, so the scan would
  // have returned zero positions, every pass, in silence.
  const discriminator = (
    coder.accounts as unknown as { accountDiscriminator(name: string): Buffer }
  ).accountDiscriminator("Position");

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
      // "Position", not "position", and `entry_price`, not `entryPrice`.
      //
      // A raw `BorshCoder` uses the names the IDL uses; only `Program` does
      // the camelCase translation. Get the account name wrong and Anchor
      // throws "Account not found: position"; get a field name wrong and it
      // is `undefined.toString()`, which is worse, because the catch below
      // swallows it and the scan silently finds no positions to liquidate.
      const decoded = coder.accounts.decode("Position", account.data) as Record<
        string,
        any
      >;
      out.push({
        address: pubkey,
        owner: decoded.owner,
        market: decoded.market,
        size: BigInt(decoded.size.toString()),
        entryPrice: BigInt(decoded.entry_price.toString()),
        collateral: BigInt(decoded.collateral.toString()),
        entryFundingIndex: BigInt(decoded.entry_funding_index.toString()),
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

    const market = coder.accounts.decode("Market", marketInfo.data) as Record<
      string,
      any
    >;
    const oracle = coder.accounts.decode(
      "PriceOracle",
      oracleInfo.data,
    ) as Record<string, any>;

    const session = Object.keys(oracle.session ?? {})[0]?.toLowerCase();
    // PreOpen and Halted have no usable mark, so the program refuses to
    // liquidate against them. Closed is fine: that is the settled price.
    if (session === "preopen" || session === "halted") continue;

    const markPrice = BigInt(oracle.price.toString());
    const fundingIndex = BigInt(market.cumulative_funding_index.toString());
    const maintenance = BigInt(market.maintenance_margin_bps);

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

// ---------------------------------------------------------------------------
// Treasury hedges
// ---------------------------------------------------------------------------

/** A treasury account as the rebalancer needs it. */
export interface ScannedTreasury {
  address: PublicKey;
  agentMint: PublicKey;
  market: PublicKey;
  hedgingEnabled: boolean;
}

/**
 * Every agent treasury the program holds.
 *
 * Same shape as `scanPositions`: a treasury's PDA seed is its agent mint, and
 * the set of agents is not knowable in advance, so the discriminator is the
 * only handle. There is no second `memcmp` here because there is no market
 * filter worth applying - treasuries are counted in the tens, not the
 * thousands, and one pass covers every market at once.
 *
 * "AgentTreasury", with the IDL's capitalisation. A raw `BorshCoder` does not
 * camelCase, and the wrong name here is a filter that matches nothing, so the
 * rebalancer would find no treasuries and say nothing about it.
 */
export async function scanTreasuries(
  config: ChainConfig,
): Promise<ScannedTreasury[]> {
  const discriminator = (
    coder.accounts as unknown as { accountDiscriminator(name: string): Buffer }
  ).accountDiscriminator("AgentTreasury");

  const accounts = await config.connection.getProgramAccounts(
    config.programId,
    { filters: [{ memcmp: { offset: 0, bytes: bs58(discriminator) } }] },
  );

  const out: ScannedTreasury[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const decoded = coder.accounts.decode("AgentTreasury", account.data) as
        Record<string, any>;
      out.push({
        address: pubkey,
        agentMint: new PublicKey(decoded.agent_mint),
        market: new PublicKey(decoded.market),
        hedgingEnabled: Boolean(decoded.hedging_enabled),
      });
    } catch {
      // One treasury written by a previous account layout must not cost the
      // rest of the pass.
    }
  }
  return out;
}

/**
 * Bring every treasury back inside its tolerance band.
 *
 * This is the crank the on-chain design counts on. `rebalance_hedge` is
 * permissionless precisely so an agent whose own keeper is down does not
 * silently drift back to fully long, and that promise is only worth anything
 * if somebody is actually cranking it. Nobody was.
 *
 * `RebalanceNotNeeded` is the normal answer and is already benign, like
 * `FundingNotDue` on the funding crank: the program decides when a hedge has
 * drifted, not this. So the pass submits for every treasury whose market it
 * can price and lets the band do the filtering, rather than duplicating the
 * drift arithmetic here where it could disagree with the chain's.
 */
export async function rebalancePass(
  config: ChainConfig,
  symbols: string[],
): Promise<{ scanned: number; rebalanced: string[] }> {
  const treasuries = await scanTreasuries(config);
  if (treasuries.length === 0) return { scanned: 0, rebalanced: [] };

  // Market address back to symbol, so a treasury can be matched to the
  // addresses its instruction needs.
  const byMarket = new Map<string, ReturnType<typeof addressesFor>>();
  for (const symbol of symbols) {
    const a = addressesFor(config.programId, symbol);
    byMarket.set(a.market.toBase58(), a);
  }

  const rebalanced: string[] = [];
  for (const treasury of treasuries) {
    if (!treasury.hedgingEnabled) continue;
    const a = byMarket.get(treasury.market.toBase58());
    // A treasury hedging a market this keeper does not run is not this
    // keeper's to crank.
    if (!a) continue;

    const position = pda(config.programId, [
      seed("position"),
      treasury.address.toBuffer(),
      a.market.toBuffer(),
    ]);

    const outcome = await send(
      config,
      [
        ix(config.programId, "rebalance_hedge", {}, [
          { pubkey: config.payer.publicKey, isSigner: true, isWritable: false },
          ro(a.config),
          rw(treasury.address),
          rw(a.market),
          ro(a.oracle),
          rw(position),
          rw(a.pool),
          rw(a.poolVault),
          rw(a.marketVault),
          ro(TOKEN_PROGRAM_ID),
        ]),
      ],
      `rebalance_hedge ${treasury.address.toBase58().slice(0, 8)}`,
    );

    if (outcome.ok) {
      rebalanced.push(treasury.address.toBase58());
      config.log("info", "rebalanced an agent hedge", {
        treasury: treasury.address.toBase58(),
        signature: outcome.signature,
      });
    }
  }

  return { scanned: treasuries.length, rebalanced };
}
