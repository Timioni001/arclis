/**
 * Every name the keeper hands to the coder, checked against the IDL.
 *
 * This bug class has now cost three separate outages, all silent:
 *
 *  - the frontend's five account decoders looked for "market" where the IDL
 *    says "Market", and every screen read an empty chain;
 *  - the liquidator did the same and threw "Account not found: market" on
 *    every pass since it was written;
 *  - `sessionArg` lowercased the enum variant to `{ open: {} }`, which
 *    matches no variant, so every session write the keeper ever attempted
 *    died inside buffer-layout with "unable to infer src variant" - a message
 *    naming neither the instruction nor the enum.
 *
 * The cause is always the same. `Program` camelCases IDL names; a raw
 * `BorshCoder` does not, and every one of these call sites uses a raw one.
 * Nothing about it fails loudly, and nothing about it fails at compile time,
 * so it has to fail here.
 */
import { BorshCoder, BN } from "@coral-xyz/anchor";
import { describe, expect, it } from "vitest";

import idl from "../../idl/arclis.json";

const coder = new BorshCoder(idl as never);
const doc = idl as unknown as {
  accounts: { name: string }[];
  instructions: { name: string; args: { name: string }[] }[];
  types: { name: string; type: { variants?: { name: string }[] } }[];
};

/** Exactly what `cranks.ts` decodes. */
const DECODED_ACCOUNTS = ["Position", "Market", "PriceOracle"];

/** Exactly what the keeper encodes. */
const ENCODED_INSTRUCTIONS = [
  "update_price_oracle",
  "set_market_session",
  "crank_funding",
  "liquidate",
  "apply_corporate_action",
  "apply_dividend",
];

describe("account names", () => {
  it.each(DECODED_ACCOUNTS)("the IDL defines %s", (name) => {
    expect(doc.accounts.map((a) => a.name)).toContain(name);
  });

  /*
   * `accountDiscriminator` takes the same name as `decode` and was missed
   * when `decode` was fixed, because this file only tested `decode`. It threw
   * "Account not found: position" from a different method on the same object.
   *
   * Had it not thrown it would have been worse: a discriminator for a name
   * that does not exist is a memcmp filter matching nothing, so the liquidator
   * would have scanned cleanly and found zero positions forever.
   */
  it.each(DECODED_ACCOUNTS)("%s has a discriminator", (name) => {
    const accounts = coder.accounts as unknown as {
      accountDiscriminator(n: string): Buffer;
    };
    expect(() => accounts.accountDiscriminator(name)).not.toThrow();
    expect(accounts.accountDiscriminator(name)).toHaveLength(8);
  });

  it.each(DECODED_ACCOUNTS)("camelCased %s has no discriminator", (name) => {
    const camel = name.charAt(0).toLowerCase() + name.slice(1);
    const accounts = coder.accounts as unknown as {
      accountDiscriminator(n: string): Buffer;
    };
    expect(() => accounts.accountDiscriminator(camel)).toThrow();
  });

  it.each(DECODED_ACCOUNTS)("camelCasing %s would not resolve", (name) => {
    // The guard on the assumption: if a future Anchor starts camelCasing
    // here, this fails and every call site needs revisiting together.
    const camel = name.charAt(0).toLowerCase() + name.slice(1);
    expect(doc.accounts.map((a) => a.name)).not.toContain(camel);
  });
});

describe("instruction names", () => {
  it.each(ENCODED_INSTRUCTIONS)("the IDL defines %s", (name) => {
    expect(doc.instructions.map((i) => i.name)).toContain(name);
  });
});

describe("field names read off decoded accounts", () => {
  // Each entry is a field `cranks.ts` reads after decoding.
  const READS: Array<[string, string[]]> = [
    [
      "Position",
      [
        "owner",
        "market",
        "size",
        "entry_price",
        "collateral",
        "entry_funding_index",
      ],
    ],
    ["Market", ["cumulative_funding_index", "maintenance_margin_bps"]],
    ["PriceOracle", ["price", "session"]],
  ];

  it.each(READS)("%s has every field the keeper reads", (account, fields) => {
    const defined = (
      doc.types.find((t) => t.name === account) as
        { type: { fields?: { name: string }[] } } | undefined
    )?.type?.fields?.map((f) => f.name);
    expect(defined, `${account} not found among IDL types`).toBeTruthy();
    for (const field of fields) expect(defined).toContain(field);
  });
});

describe("the market session enum", () => {
  const variants =
    doc.types.find((t) => t.name === "MarketSession")?.type.variants ?? [];

  it("has the four states the calendar produces", () => {
    expect(variants.map((v) => v.name)).toEqual([
      "Closed",
      "PreOpen",
      "Open",
      "Halted",
    ]);
  });

  it.each(variants.map((v) => v.name))("encodes { %s: {} }", (name) => {
    expect(() =>
      coder.instruction.encode("set_market_session", {
        session: { [name]: {} },
      }),
    ).not.toThrow();
  });

  it.each(variants.map((v) => v.name))(
    "refuses the camelCased { %s: {} }",
    (name) => {
      const camel = name.charAt(0).toLowerCase() + name.slice(1);
      expect(() =>
        coder.instruction.encode("set_market_session", {
          session: { [camel]: {} },
        }),
      ).toThrow(/unable to infer src variant/);
    },
  );
});

describe("instruction argument names", () => {
  it("apply_dividend takes per_share, not perShare", () => {
    expect(() =>
      coder.instruction.encode("apply_dividend", { per_share: new BN(1) }),
    ).not.toThrow();
  });

  it("update_price_oracle takes price and confidence", () => {
    expect(() =>
      coder.instruction.encode("update_price_oracle", {
        price: new BN(1),
        confidence: new BN(1),
      }),
    ).not.toThrow();
  });
});
