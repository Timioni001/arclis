/**
 * Base58 in the Bitcoin alphabet, which is what Solana addresses use.
 *
 * Written out rather than pulled in because it is forty lines, it is on the
 * path that turns a freshly generated key into an address the user sees, and a
 * dependency on that path is a dependency that can change under you between
 * the key being made and the address being shown.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  // Leading zero bytes are not carried by the big-integer conversion, so they
  // are counted first and re-attached as '1's afterwards. Dropping them would
  // silently produce a different address for a key that happens to start with
  // a zero, which is roughly one key in 256.
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0)
    leadingZeros++;

  const digits: number[] = [];
  for (let i = leadingZeros; i < bytes.length; i++) {
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

  let out = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array(0);

  let leadingOnes = 0;
  while (leadingOnes < value.length && value[leadingOnes] === "1")
    leadingOnes++;

  const bytes: number[] = [];
  for (let i = leadingOnes; i < value.length; i++) {
    const index = ALPHABET.indexOf(value[i]);
    if (index < 0) throw new Error(`Not a base58 character: ${value[i]}`);
    let carry = index;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(leadingOnes + bytes.length);
  for (let i = 0; i < bytes.length; i++)
    out[leadingOnes + i] = bytes[bytes.length - 1 - i];
  return out;
}
