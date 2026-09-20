/**
 * Mint parsing tests, against hand-built buffers.
 *
 * Byte-level parsing is the kind of code that looks right and is off by four.
 * These build the buffers explicitly so a wrong offset fails here rather than
 * showing a holder the wrong freeze authority.
 */

import { describe, expect, it } from "vitest";
import { encodeBase58, parseMint, supplyAtScale } from "./mint";

/** Build a base (Token program) mint account. */
function baseMint(options: {
  mintAuthority?: Uint8Array | null;
  freezeAuthority?: Uint8Array | null;
  supply?: bigint;
  decimals?: number;
}): Uint8Array {
  const data = new Uint8Array(82);
  const view = new DataView(data.buffer);

  if (options.mintAuthority) {
    view.setUint32(0, 1, true);
    data.set(options.mintAuthority, 4);
  }

  view.setBigUint64(36, options.supply ?? 0n, true);
  data[44] = options.decimals ?? 6;
  data[45] = 1; // initialised

  if (options.freezeAuthority) {
    view.setUint32(46, 1, true);
    data.set(options.freezeAuthority, 50);
  }
  return data;
}

/** Extend a base mint with Token-2022 TLV entries. */
function withExtensions(
  base: Uint8Array,
  entries: Array<[number, number]>,
): Uint8Array {
  const tlvLength = entries.reduce((sum, [, len]) => sum + 4 + len, 0);
  const data = new Uint8Array(166 + tlvLength);
  data.set(base, 0);
  data[165] = 1; // account type: mint

  let cursor = 166;
  for (const [type, length] of entries) {
    data[cursor] = type & 0xff;
    data[cursor + 1] = (type >> 8) & 0xff;
    data[cursor + 2] = length & 0xff;
    data[cursor + 3] = (length >> 8) & 0xff;
    cursor += 4 + length;
  }
  return data;
}

const AUTHORITY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OTHER = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);

describe("parseMint, base fields", () => {
  it("reads decimals and supply", () => {
    const facts = parseMint(
      "M",
      baseMint({ supply: 412_000_000_000n, decimals: 6 }),
    );
    expect(facts.decimals).toBe(6);
    expect(facts.supply).toBe(412_000_000_000n);
  });

  it("reads a supply past 2^53 exactly", () => {
    // A u64 supply on a 9-decimal mint crosses the float boundary easily, and
    // a Number would round it.
    const huge = 18_000_000_000_000_000_001n;
    expect(parseMint("M", baseMint({ supply: huge })).supply).toBe(huge);
  });

  it("reports a set mint authority", () => {
    const facts = parseMint("M", baseMint({ mintAuthority: AUTHORITY }));
    expect(facts.mintAuthority).toBe(encodeBase58(AUTHORITY));
  });

  it("reports a revoked mint authority as null, not as the zero address", () => {
    // The COption tag is what says "none". Reading the 32 bytes regardless
    // would report the system program as the authority on every fixed-supply
    // mint in existence.
    expect(parseMint("M", baseMint({})).mintAuthority).toBeNull();
  });

  it("reads mint and freeze authorities from their own offsets", () => {
    // The two are 46 bytes apart with a supply and decimals between them, and
    // swapping them is the classic error here.
    const facts = parseMint(
      "M",
      baseMint({ mintAuthority: AUTHORITY, freezeAuthority: OTHER }),
    );
    expect(facts.mintAuthority).toBe(encodeBase58(AUTHORITY));
    expect(facts.freezeAuthority).toBe(encodeBase58(OTHER));
    expect(facts.mintAuthority).not.toBe(facts.freezeAuthority);
  });

  it("reports a freeze authority set without a mint authority", () => {
    const facts = parseMint("M", baseMint({ freezeAuthority: OTHER }));
    expect(facts.mintAuthority).toBeNull();
    expect(facts.freezeAuthority).toBe(encodeBase58(OTHER));
  });

  it("refuses a buffer too short to be a mint", () => {
    expect(() => parseMint("M", new Uint8Array(40))).toThrow(/too short/);
  });
});

describe("parseMint, Token-2022 extensions", () => {
  it("finds no extensions on a base-length mint", () => {
    const facts = parseMint("M", baseMint({}));
    expect(facts.extensions).toEqual([]);
    expect(facts.isToken2022).toBe(false);
  });

  it("names a transfer hook and flags it as control", () => {
    const data = withExtensions(baseMint({}), [[14, 64]]);
    const facts = parseMint("M", data);
    expect(facts.extensions).toContain("Transfer hook");
    expect(facts.controlExtensions).toContain("Transfer hook");
    expect(facts.isToken2022).toBe(true);
  });

  it("walks past one extension to reach the next", () => {
    // The length field is what advances the cursor. Ignoring it would find the
    // first extension and miss everything after it, which is how a permanent
    // delegate goes unreported.
    const data = withExtensions(baseMint({}), [
      [18, 64],
      [12, 32],
    ]);
    const facts = parseMint("M", data);
    expect(facts.extensions).toEqual([
      "Metadata pointer",
      "Permanent delegate",
    ]);
  });

  it("separates housekeeping extensions from ones with power over a balance", () => {
    const data = withExtensions(baseMint({}), [
      [18, 64],
      [19, 40],
      [12, 32],
    ]);
    const facts = parseMint("M", data);
    expect(facts.extensions).toHaveLength(3);
    // A metadata pointer is housekeeping; a permanent delegate is somebody
    // else's key over your tokens.
    expect(facts.controlExtensions).toEqual(["Permanent delegate"]);
  });

  it("stops at uninitialised padding rather than inventing extensions", () => {
    const data = withExtensions(baseMint({}), [[14, 64]]);
    const padded = new Uint8Array(data.length + 32);
    padded.set(data, 0); // trailing zeros
    expect(parseMint("M", padded).extensions).toEqual(["Transfer hook"]);
  });

  it("names an unknown extension id rather than dropping it", () => {
    // A new extension the table does not know is still a fact about the mint.
    const data = withExtensions(baseMint({}), [[999, 8]]);
    expect(parseMint("M", data).extensions).toEqual(["Extension 999"]);
  });

  it("does not run past the end of a truncated TLV", () => {
    const data = withExtensions(baseMint({}), [[14, 64]]);
    expect(() =>
      parseMint("M", data.subarray(0, data.length - 20)),
    ).not.toThrow();
  });
});

describe("supplyAtScale", () => {
  const facts = (supply: bigint, decimals: number) =>
    parseMint("M", baseMint({ supply, decimals }));

  it("passes a 6-decimal supply through unchanged", () => {
    expect(supplyAtScale(facts(412_000_000_000n, 6))).toBe(412_000_000_000n);
  });

  it("scales a 9-decimal supply down to 1e6", () => {
    // 412,000 whole tokens at 9 decimals.
    expect(supplyAtScale(facts(412_000_000_000_000n, 9))).toBe(
      412_000_000_000n,
    );
  });

  it("scales a 2-decimal supply up to 1e6", () => {
    // 100 whole tokens at 2 decimals is 100_000_000 at 1e6.
    expect(supplyAtScale(facts(10_000n, 2))).toBe(100_000_000n);
  });
});
