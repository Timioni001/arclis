/**
 * The faucet's limits. The token is worthless; the keeper's SOL, which pays
 * for every grant and for every price it publishes, is not.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { DEFAULT_LIMITS, FaucetPolicy, grantInstructions, parseRecipient } from "./faucet";

const HOUR = 3_600_000;
const addr = () => Keypair.generate().publicKey.toBase58();

describe("FaucetPolicy", () => {
  it("funds a wallet once a day", () => {
    const p = new FaucetPolicy();
    const a = addr();
    expect(p.check(a, "1.1.1.1", 0).ok).toBe(true);
    p.begin(a);
    p.finish(a, "1.1.1.1", 0, true);
    const again = p.check(a, "2.2.2.2", 23 * HOUR);
    expect(again).toMatchObject({ ok: false, status: 429 });
    expect(p.check(a, "2.2.2.2", 24 * HOUR).ok).toBe(true);
  });

  it("refuses a second request while the first is in flight", () => {
    const p = new FaucetPolicy();
    const a = addr();
    p.begin(a);
    expect(p.check(a, "1.1.1.1", 0)).toMatchObject({ ok: false, status: 409 });
  });

  it("does not count a grant that failed", () => {
    const p = new FaucetPolicy();
    const a = addr();
    p.begin(a);
    p.finish(a, "1.1.1.1", 0, false);
    expect(p.check(a, "1.1.1.1", 1).ok).toBe(true);
  });

  it("caps grants per client address", () => {
    const p = new FaucetPolicy({ ...DEFAULT_LIMITS, perIpPerDay: 2 });
    for (let i = 0; i < 2; i++) {
      const a = addr();
      p.begin(a);
      p.finish(a, "9.9.9.9", i, true);
    }
    expect(p.check(addr(), "9.9.9.9", 10)).toMatchObject({ ok: false, status: 429 });
    expect(p.check(addr(), "8.8.8.8", 10).ok).toBe(true);
  });

  it("stops at the daily budget", () => {
    const p = new FaucetPolicy({ ...DEFAULT_LIMITS, dailyCap: 1 });
    const a = addr();
    p.begin(a);
    p.finish(a, "1.1.1.1", 0, true);
    expect(p.check(addr(), "2.2.2.2", HOUR)).toMatchObject({ ok: false, status: 503 });
  });
});

describe("parseRecipient", () => {
  it("accepts a wallet and refuses junk and program-derived addresses", () => {
    const wallet = addr();
    expect(parseRecipient(wallet)?.toBase58()).toBe(wallet);
    expect(parseRecipient("not-an-address")).toBeNull();
    expect(parseRecipient(null)).toBeNull();
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("x")], SystemProgram.programId);
    expect(parseRecipient(pda.toBase58())).toBeNull();
  });
});

describe("grantInstructions", () => {
  const payer = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const to = Keypair.generate().publicKey;

  it("creates the token account idempotently and mints", () => {
    expect(grantInstructions(payer, mint, to, 1n, 0)).toHaveLength(2);
  });

  it("adds a SOL transfer only when asked", () => {
    const ixs = grantInstructions(payer, mint, to, 1n, 50_000_000);
    expect(ixs).toHaveLength(3);
    expect(ixs[2].programId.equals(SystemProgram.programId)).toBe(true);
  });
});
