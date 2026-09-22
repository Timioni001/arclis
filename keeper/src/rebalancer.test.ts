/**
 * The agent-hedge crank.
 *
 * `rebalance_hedge` is permissionless by design, so that an agent whose own
 * keeper falls over does not silently drift back to fully long. That promise
 * only means something if something is actually cranking it, and nothing was.
 *
 * Two things here can be wrong in silence, and both are what these cover. The
 * discriminator is the whole scan: get the name's capitalisation wrong and the
 * `memcmp` matches nothing, so the pass finds no treasuries and reports a clean
 * zero. And a treasury hedging a market this keeper does not run must be
 * skipped rather than submitted against another market's addresses, which
 * would build an instruction the program rejects for reasons that look like
 * anything but the real one.
 */

import { BN, BorshCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import idl from "../../idl/arclis.json";
import { addressesFor, rebalancePass, scanTreasuries } from "./cranks";
import type { ChainConfig } from "./chain";

/* eslint-disable @typescript-eslint/no-explicit-any */
const coder = new BorshCoder(idl as any);

const PROGRAM = new PublicKey("BuN69a1vsMdPQx6bWjaA7FJMbnBKo6yZ66cHrdyiTbiP");
const AGENT_MINT = new PublicKey("8nMZjpyLpGGtnCkdCotT8jWUDUpSnJeVjeuazyYVvqGu");
const OTHER_MARKET = new PublicKey("11111111111111111111111111111112");

const bn = (v: bigint) => new BN(v.toString());

async function treasuryBytes(market: PublicKey, hedgingEnabled = true) {
  return coder.accounts.encode("AgentTreasury", {
    authority: PROGRAM,
    agent_mint: AGENT_MINT,
    stock_mint: PROGRAM,
    market,
    stock_vault: PROGRAM,
    stock_qty: bn(4_000_000_000n),
    tokens_outstanding: bn(10_000_000_000_000n),
    hedge_ratio_bps: 9_000,
    rebalance_tolerance_bps: 250,
    hedging_enabled: hedgingEnabled,
    last_nav_per_token: bn(0n),
    last_nav_ts: bn(0n),
    bump: 255,
    stock_vault_bump: 254,
    _reserved: Array(64).fill(0),
  } as any);
}

function config(
  accounts: { pubkey: PublicKey; data: Buffer }[],
  send = vi.fn(async () => ({ ok: true, signature: "sig" })),
): { config: ChainConfig; sent: typeof send } {
  const connection = {
    getProgramAccounts: vi.fn(async () =>
      accounts.map(({ pubkey, data }) => ({ pubkey, account: { data } })),
    ),
    // `send` is stubbed, so nothing below this reaches a node.
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
    })),
    sendTransaction: send,
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
  };
  return {
    config: {
      connection,
      programId: PROGRAM,
      payer: Keypair.generate(),
      log: () => {},
    } as unknown as ChainConfig,
    sent: send,
  };
}

describe("scanTreasuries", () => {
  it("finds treasuries by the IDL's own account name", async () => {
    const data = await treasuryBytes(addressesFor(PROGRAM, "AAPL").market);
    const { config: c } = config([{ pubkey: AGENT_MINT, data }]);

    const found = await scanTreasuries(c);
    expect(found).toHaveLength(1);
    expect(found[0].agentMint.toBase58()).toBe(AGENT_MINT.toBase58());
    expect(found[0].hedgingEnabled).toBe(true);
  });

  it("filters on a discriminator, not on everything the program owns", async () => {
    const data = await treasuryBytes(addressesFor(PROGRAM, "AAPL").market);
    const { config: c } = config([{ pubkey: AGENT_MINT, data }]);
    await scanTreasuries(c);

    // A scan with no filter downloads every position in every market on every
    // pass, which is how a keeper rate-limits itself off its own endpoint.
    const call = (c.connection.getProgramAccounts as any).mock.calls[0];
    expect(call[1].filters[0].memcmp.offset).toBe(0);
    expect(call[1].filters[0].memcmp.bytes).toBeTruthy();
  });

  it("drops an undecodable account rather than the whole pass", async () => {
    const good = await treasuryBytes(addressesFor(PROGRAM, "AAPL").market);
    const { config: c } = config([
      { pubkey: OTHER_MARKET, data: Buffer.alloc(16) },
      { pubkey: AGENT_MINT, data: good },
    ]);

    expect(await scanTreasuries(c)).toHaveLength(1);
  });
});

describe("rebalancePass", () => {
  it("submits for a treasury whose market this keeper runs", async () => {
    const data = await treasuryBytes(addressesFor(PROGRAM, "AAPL").market);
    const { config: c, sent } = config([{ pubkey: AGENT_MINT, data }]);

    const result = await rebalancePass(c, ["AAPL"]);
    expect(result.scanned).toBe(1);
    expect(sent).toHaveBeenCalled();
  });

  it("skips a treasury hedging a market this keeper does not run", async () => {
    const data = await treasuryBytes(OTHER_MARKET);
    const { config: c, sent } = config([{ pubkey: AGENT_MINT, data }]);

    const result = await rebalancePass(c, ["AAPL"]);
    // Scanned, but not cranked: the addresses for another market would build
    // an instruction rejected for a reason that looks like anything but this.
    expect(result.scanned).toBe(1);
    expect(result.rebalanced).toHaveLength(0);
    expect(sent).not.toHaveBeenCalled();
  });

  it("leaves a treasury alone when its agent has hedging switched off", async () => {
    const data = await treasuryBytes(addressesFor(PROGRAM, "AAPL").market, false);
    const { config: c, sent } = config([{ pubkey: AGENT_MINT, data }]);

    await rebalancePass(c, ["AAPL"]);
    expect(sent).not.toHaveBeenCalled();
  });

  it("does not scan a second time when there is nothing to crank", async () => {
    const { config: c, sent } = config([]);
    const result = await rebalancePass(c, ["AAPL"]);

    expect(result).toEqual({ scanned: 0, rebalanced: [] });
    expect(sent).not.toHaveBeenCalled();
  });
});
