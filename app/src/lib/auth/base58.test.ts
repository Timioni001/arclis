/** Signatures and addresses go through this encoder, so it must agree with web3.js. */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { decodeBase58, encodeBase58 } from "./base58";

describe("base58", () => {
  it("matches web3.js on real addresses", () => {
    for (let i = 0; i < 20; i++) {
      const key = Keypair.generate().publicKey;
      expect(encodeBase58(key.toBytes())).toBe(key.toBase58());
      expect(decodeBase58(key.toBase58())).toEqual(key.toBytes());
    }
  });

  it("keeps leading zero bytes as leading 1s", () => {
    expect(encodeBase58(new Uint8Array(32))).toBe(new PublicKey(new Uint8Array(32)).toBase58());
    expect(encodeBase58(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(decodeBase58("112")).toEqual(new Uint8Array([0, 0, 1]));
  });

  it("round-trips a 64-byte signature", () => {
    const sig = crypto.getRandomValues(new Uint8Array(64));
    expect(decodeBase58(encodeBase58(sig))).toEqual(sig);
  });

  it("handles the empty input", () => {
    expect(encodeBase58(new Uint8Array())).toBe("");
    expect(decodeBase58("")).toEqual(new Uint8Array());
  });

  it("refuses characters outside the alphabet", () => {
    expect(() => decodeBase58("0OIl")).toThrow();
  });
});
