/**
 * Every address the program derives, derived the same way here.
 *
 * These seeds are duplicated from `programs/arclis/src/state/*.rs`. Duplication
 * across a language boundary is a real risk, so the rule is that this file
 * contains seeds and nothing else: no arithmetic, no conditionals, one function
 * per PDA. A mismatch then shows up as "account does not exist" on the very
 * first call rather than as a subtly wrong balance later.
 */

import { PublicKey } from "@solana/web3.js";

/** Symbols are a fixed 16-byte seed, right-padded with zeros. */
export function symbolSeed(symbol: string): Uint8Array {
  const bytes = new Uint8Array(16);
  const encoded = new TextEncoder().encode(symbol);
  if (encoded.length > 16) {
    throw new Error(
      `Symbol "${symbol}" is longer than the 16-byte seed allows.`,
    );
  }
  bytes.set(encoded);
  return bytes;
}

const seed = (s: string) => new TextEncoder().encode(s);

export function globalConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("config")], programId)[0];
}

export function oraclePda(programId: PublicKey, symbol: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [seed("oracle"), symbolSeed(symbol)],
    programId,
  )[0];
}

export function marketPda(programId: PublicKey, oracle: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [seed("market"), oracle.toBuffer()],
    programId,
  )[0];
}

export function marketVaultPda(
  programId: PublicKey,
  market: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [seed("vault"), market.toBuffer()],
    programId,
  )[0];
}

export function positionPda(
  programId: PublicKey,
  owner: PublicKey,
  market: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [seed("position"), owner.toBuffer(), market.toBuffer()],
    programId,
  )[0];
}

export function poolPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [seed("lp_pool"), market.toBuffer()],
    programId,
  )[0];
}

export function poolVaultPda(programId: PublicKey, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [seed("lp_vault"), pool.toBuffer()],
    programId,
  )[0];
}

export function lpPositionPda(
  programId: PublicKey,
  owner: PublicKey,
  pool: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [seed("lp_position"), owner.toBuffer(), pool.toBuffer()],
    programId,
  )[0];
}

export function treasuryPda(
  programId: PublicKey,
  agentMint: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [seed("treasury"), agentMint.toBuffer()],
    programId,
  )[0];
}

/**
 * Everything derivable for one market, in one call.
 *
 * Handlers need four or five of these at once and deriving them ad hoc is how
 * a wrong vault reaches a transaction. Asking for the set means the set is
 * always internally consistent.
 */
export interface MarketAddresses {
  oracle: PublicKey;
  market: PublicKey;
  marketVault: PublicKey;
  pool: PublicKey;
  poolVault: PublicKey;
}

export function marketAddresses(
  programId: PublicKey,
  symbol: string,
): MarketAddresses {
  const oracle = oraclePda(programId, symbol);
  const market = marketPda(programId, oracle);
  const pool = poolPda(programId, market);
  return {
    oracle,
    market,
    marketVault: marketVaultPda(programId, market),
    pool,
    poolVault: poolVaultPda(programId, pool),
  };
}
