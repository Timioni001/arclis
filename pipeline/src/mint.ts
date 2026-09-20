/**
 * Reading an SPL mint, including the Token-2022 extensions.
 *
 * # Why this is hand-parsed
 *
 * `@solana/spl-token` will decode a mint, but the registry needs the
 * extensions, and the extension list is the part that matters most: a transfer
 * hook or a permanent delegate is a power over a holder's balance that no
 * price chart shows and no issuer disclosure is obliged to mention. Reading
 * the TLV directly means the registry reports what the chain says rather than
 * what a helper chose to surface.
 *
 * # Layout
 *
 * The base mint is 82 bytes:
 *
 *   0   4   COption tag for the mint authority (0 = none, 1 = some)
 *   4   32  mint authority
 *   36  8   supply, little-endian u64
 *   44  1   decimals
 *   45  1   is_initialized
 *   46  4   COption tag for the freeze authority
 *   50  32  freeze authority
 *
 * A Token-2022 mint with extensions is longer. After the 82 bytes comes one
 * padding byte to 83, then a single account-type byte at 165 (the size of a
 * token *account*, which is what the padding exists to avoid colliding with),
 * then TLV entries: u16 type, u16 length, then that many bytes.
 */

const MINT_LEN = 82;
const ACCOUNT_TYPE_OFFSET = 165;
const TLV_START = 166;

/** Token-2022 extension type ids, as published in the program's own enum. */
const EXTENSION_NAMES: Record<number, string> = {
  1: "Transfer fee config",
  2: "Transfer fee amount",
  3: "Mint close authority",
  4: "Confidential transfer mint",
  5: "Confidential transfer account",
  6: "Default account state",
  7: "Immutable owner",
  8: "Memo transfer",
  9: "Non-transferable",
  10: "Interest bearing config",
  11: "CPI guard",
  12: "Permanent delegate",
  13: "Non-transferable account",
  14: "Transfer hook",
  15: "Transfer hook account",
  16: "Confidential transfer fee config",
  17: "Confidential transfer fee amount",
  18: "Metadata pointer",
  19: "Token metadata",
  20: "Group pointer",
  21: "Token group",
  22: "Group member pointer",
  23: "Token group member",
  24: "Confidential mint burn",
  25: "Scaled UI amount",
  26: "Pausable",
  27: "Pausable account",
};

/**
 * Extensions that let somebody act on a holder's tokens without them.
 *
 * Reported separately because the distinction matters: a metadata pointer is
 * housekeeping, a permanent delegate is somebody else's key over your balance.
 */
export const CONTROL_EXTENSIONS = new Set([9, 12, 14, 26, 6, 3]);

export interface MintFacts {
  mint: string;
  decimals: number;
  /** Raw supply, in the mint's own base units. */
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Human-readable extension names, in the order the TLV lists them. */
  extensions: string[];
  /** The subset of `extensions` that can act on a holder's balance. */
  controlExtensions: string[];
  /** True when the mint is Token-2022 rather than the original program. */
  isToken2022: boolean;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function encodeBase58(bytes: Uint8Array): string {
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

function readU32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

function readU16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function readU64(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]);
  return value;
}

/**
 * Parse a mint account.
 *
 * Throws on anything shorter than a base mint rather than returning zeros: a
 * mint that cannot be read is a fact the registry must surface, and a silent
 * `supply: 0` would render as a token nobody holds.
 */
export function parseMint(
  address: string,
  data: Uint8Array,
  owner?: string,
): MintFacts {
  if (data.length < MINT_LEN) {
    throw new Error(
      `${address}: ${data.length} bytes is too short to be a mint (need ${MINT_LEN}).`,
    );
  }

  const mintAuthority =
    readU32(data, 0) === 1 ? encodeBase58(data.subarray(4, 36)) : null;
  const freezeAuthority =
    readU32(data, 46) === 1 ? encodeBase58(data.subarray(50, 82)) : null;

  const extensions: string[] = [];
  const controlExtensions: string[] = [];

  // Extensions only exist past the account-type byte. A base-length mint is
  // the original Token program and has none.
  if (data.length > ACCOUNT_TYPE_OFFSET) {
    let cursor = TLV_START;
    // Bounded by the buffer, and each step must advance, so a malformed
    // zero-length entry cannot spin.
    while (cursor + 4 <= data.length) {
      const type = readU16(data, cursor);
      const length = readU16(data, cursor + 2);
      if (type === 0) break; // uninitialised padding
      const name = EXTENSION_NAMES[type] ?? `Extension ${type}`;
      extensions.push(name);
      if (CONTROL_EXTENSIONS.has(type)) controlExtensions.push(name);
      cursor += 4 + length;
    }
  }

  return {
    mint: address,
    decimals: data[44],
    supply: readU64(data, 36),
    mintAuthority,
    freezeAuthority,
    extensions,
    controlExtensions,
    isToken2022:
      data.length > ACCOUNT_TYPE_OFFSET ||
      owner === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  };
}

/** Supply scaled to the registry's 1e6 convention. */
export function supplyAtScale(facts: MintFacts): bigint {
  const SCALE = 1_000_000n;
  if (facts.decimals === 6) return facts.supply;
  if (facts.decimals > 6) {
    return facts.supply / 10n ** BigInt(facts.decimals - 6);
  }
  return (facts.supply * 10n ** BigInt(6 - facts.decimals) * SCALE) / SCALE;
}
