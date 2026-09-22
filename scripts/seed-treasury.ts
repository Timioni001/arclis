/**
 * Open a working agent treasury on a cluster that already has markets.
 *
 * `seed-local.ts` builds the trading world: config, oracles, markets, pools,
 * a couple of positions. It deliberately stops there, because a treasury is
 * not part of the trading world - it is what an agent does *after* a bonding
 * curve graduates, and it needs a token that curve launched.
 *
 * This script stands in for that launch so the treasury path can be exercised
 * without one. What it creates is real on-chain state, not a fixture: a real
 * SPL mint for the agent, a real treasury account and stock vault, a real perp
 * position owned by the treasury PDA, and a NAV computed from whatever the
 * oracle is publishing right now. The one thing it cannot make real is the
 * tokenized stock itself, because AAPLx is a mainnet instrument and this runs
 * on devnet, so the "stock" is a mint this script creates. That is the same
 * compromise `seed-local.ts` already makes for the quote token, and it is
 * stated here rather than left for someone to infer.
 *
 *     npx tsx scripts/seed-treasury.ts --url https://api.devnet.solana.com
 *
 * Every step checks for the account it is about to create and skips if it is
 * already there, so a re-run after a rate limit resumes rather than starting
 * over or minting a second agent.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const ROOT = path.resolve(__dirname, "..");
const SCALE = 1_000_000;

/**
 * What this agent looks like.
 *
 * A 90% hedge rather than 100% is the more honest default to demonstrate: it
 * leaves a visible residual delta, so the screen's drift dial shows a real
 * number instead of a permanent zero, and it is what an agent that wants a
 * little upside would actually choose.
 */
const AGENT = {
  name: "Helios Quant",
  symbol: "HELIO",
  /** Shares of the underlying the agent "raised". */
  stockQty: 4_000,
  /** Agent tokens on the curve, as the NAV denominator. */
  tokensOutstanding: 10_000_000,
  hedgeRatioBps: 9_000,
  rebalanceToleranceBps: 250,
  /** Quote posted as margin behind the short. */
  hedgeMargin: 150_000,
};

const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

interface Args {
  url: string;
  wallet: string;
  programId?: string;
  symbol: string;
  allowMainnet: boolean;
  delayMs: number | null;
}

const USAGE = `
  npx tsx scripts/seed-treasury.ts [options]

    --url <rpc>           default http://127.0.0.1:8899
    --wallet <path>       default ~/.config/solana/id.json
    --program-id <pubkey> default: the declare_id! in programs/arclis/src/lib.rs
    --symbol <ticker>     the market to hedge against. Default AAPL.
    --allow-mainnet       required before this will touch a mainnet URL
    --delay <ms>          pause between RPC calls. Default 0 locally, 400 else.
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899",
    wallet:
      process.env.ANCHOR_WALLET ??
      path.join(os.homedir(), ".config", "solana", "id.json"),
    symbol: "AAPL",
    allowMainnet: false,
    delayMs: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--url":
        args.url = next();
        break;
      case "--wallet":
        args.wallet = next();
        break;
      case "--program-id":
        args.programId = next();
        break;
      case "--symbol":
        args.symbol = next().toUpperCase();
        break;
      case "--allow-mainnet":
        args.allowMainnet = true;
        break;
      case "--delay":
        args.delayMs = Number(next());
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let DELAY_MS = 0;
const pace = () =>
  DELAY_MS > 0
    ? new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    : Promise.resolve();

let step = 0;
const say = (msg: string) =>
  console.log(`  ${String(++step).padStart(2)}. ${msg}`);
const skip = (msg: string) => console.log(`      already done: ${msg}`);
const warn = (msg: string) => console.log(`      note: ${msg}`);

const units = (n: number) => new BN(Math.round(n * SCALE));

async function exists(conn: Connection, address: PublicKey) {
  await pace();
  return (await conn.getAccountInfo(address)) !== null;
}

function symbolBytes(symbol: string): Buffer {
  const b = Buffer.alloc(16);
  if (Buffer.byteLength(symbol, "utf8") > 16) {
    throw new Error(`symbol ${symbol} does not fit the 16-byte seed`);
  }
  Buffer.from(symbol, "utf8").copy(b);
  return b;
}

/**
 * Deterministic mints, so a second run reuses the first run's agent instead of
 * launching a rival one and leaving the first treasury stranded. Keyed by the
 * market symbol, because one agent per market is the shape the screen expects.
 */
function derivedMint(label: string, symbol: string): Keypair {
  const seed = createHash("sha256")
    .update(`arclis ${label} ${symbol} v1`)
    .digest();
  return Keypair.fromSeed(seed.subarray(0, 32));
}

function deployedProgramId(explicit?: string): PublicKey {
  if (explicit) return new PublicKey(explicit);
  const lib = fs.readFileSync(
    path.join(ROOT, "programs", "arclis", "src", "lib.rs"),
    "utf8",
  );
  const found = /declare_id!\("([^"]+)"\)/.exec(lib);
  if (!found) throw new Error("no declare_id! in programs/arclis/src/lib.rs");
  return new PublicKey(found[1]);
}

function isMainnet(url: string) {
  try {
    return /mainnet/i.test(new URL(url).hostname);
  } catch {
    return /mainnet/i.test(url);
  }
}

function isLocal(url: string) {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// token metadata
// ---------------------------------------------------------------------------

/**
 * `CreateMetadataAccountV3`, built by hand.
 *
 * The interface reads an agent's name from its token metadata, because that is
 * where a ClawPump-launched agent's name actually lives and putting a second
 * copy on the treasury account would be thirty-two bytes of drift waiting to
 * happen. So a seeded agent needs metadata too, or it shows up on the screen
 * as its own mint address.
 *
 * This is hand-built rather than pulled from `@metaplex-foundation/*` because
 * the instruction is one discriminator byte and three Borsh strings, and the
 * SDK is a large dependency tree for a script that runs once. Borsh here: a
 * `String` is a u32 LE length then its bytes, and an `Option` is one byte,
 * zero for `None`.
 */
function createMetadataIx(args: {
  metadata: PublicKey;
  mint: PublicKey;
  authority: PublicKey;
  name: string;
  symbol: string;
}): TransactionInstruction {
  const str = (s: string) => {
    const bytes = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([len, bytes]);
  };

  const data = Buffer.concat([
    Buffer.from([33]), // CreateMetadataAccountV3
    str(args.name),
    str(args.symbol),
    str(""), // uri: nothing to point at, and an invented one would be a lie
    Buffer.from([0, 0]), // seller_fee_basis_points: u16
    Buffer.from([0]), // creators: None
    Buffer.from([0]), // collection: None
    Buffer.from([0]), // uses: None
    Buffer.from([1]), // is_mutable: true
    Buffer.from([0]), // collection_details: None
  ]);

  return new TransactionInstruction({
    programId: METADATA_PROGRAM_ID,
    keys: [
      { pubkey: args.metadata, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.authority, isSigner: true, isWritable: false }, // mint authority
      { pubkey: args.authority, isSigner: true, isWritable: true }, // payer
      { pubkey: args.authority, isSigner: false, isWritable: false }, // update authority
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  )[0];
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (isMainnet(args.url) && !args.allowMainnet) {
    throw new Error(
      "that URL looks like mainnet.\n" +
        "  This mints two tokens and opens a leveraged short, which is not\n" +
        "  something to do by accident. If you meant it, pass --allow-mainnet.",
    );
  }
  DELAY_MS = args.delayMs ?? (isLocal(args.url) ? 0 : 400);

  let walletKp: Keypair;
  try {
    const raw = JSON.parse(fs.readFileSync(args.wallet, "utf8"));
    walletKp = Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch (e: any) {
    throw new Error(
      `could not read a keypair from ${args.wallet}\n  ${e?.message ?? e}`,
    );
  }

  const conn = new Connection(args.url, "confirmed");
  const provider = new anchor.AnchorProvider(
    conn,
    new anchor.Wallet(walletKp),
    { commitment: "confirmed" },
  );
  anchor.setProvider(provider);

  const programId = deployedProgramId(args.programId);
  const idl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "idl", "arclis.json"), "utf8"),
  );
  idl.address = programId.toBase58();
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const program = new anchor.Program(idl, provider) as any;

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, programId)[0];

  const configPda = pda([Buffer.from("config")]);
  const oracle = pda([Buffer.from("oracle"), symbolBytes(args.symbol)]);
  const market = pda([Buffer.from("market"), oracle.toBuffer()]);
  const marketVault = pda([Buffer.from("vault"), market.toBuffer()]);
  const pool = pda([Buffer.from("lp_pool"), market.toBuffer()]);
  const poolVault = pda([Buffer.from("lp_vault"), pool.toBuffer()]);

  console.log(`\n  program   ${programId.toBase58()}`);
  console.log(`  payer     ${walletKp.publicKey.toBase58()}`);
  console.log(`  rpc       ${args.url}`);
  console.log(`  market    ${args.symbol}`);
  console.log(`  pacing    ${DELAY_MS}ms between calls\n`);

  // The treasury hangs off a market that has to already exist. Saying which
  // account is missing beats an Anchor error naming a PDA nobody can place.
  if (!(await exists(conn, market))) {
    throw new Error(
      `no ${args.symbol} market at ${market.toBase58()} on ${args.url}.\n` +
        "  Run `npm run seed` first, or pass a --symbol that exists.",
    );
  }

  // Which token the market settles in. The treasury posts its hedge margin in
  // the same one, so read it off the vault rather than assuming.
  const vaultInfo = await conn.getAccountInfo(marketVault);
  if (!vaultInfo) throw new Error(`market vault ${marketVault} is missing`);
  const quoteMint = new PublicKey(vaultInfo.data.subarray(0, 32));
  console.log(`  quote     ${quoteMint.toBase58()}\n`);

  // --- the agent's token ---------------------------------------------------
  const agentKp = derivedMint("agent mint", args.symbol);
  const agentMint = agentKp.publicKey;
  say(`agent mint ${agentMint.toBase58()}`);
  if (await exists(conn, agentMint)) {
    skip("mint exists");
  } else {
    await createMint(conn, walletKp, walletKp.publicKey, null, 6, agentKp);
    await pace();
  }

  // --- the agent's name ----------------------------------------------------
  //
  // Best effort. A missing metadata account costs the screen a pretty name and
  // nothing else, so a failure here is reported and stepped over rather than
  // taking the treasury down with it.
  const metadata = metadataPda(agentMint);
  say(`agent metadata ${metadata.toBase58()}`);
  if (await exists(conn, metadata)) {
    skip("metadata exists");
  } else {
    try {
      const tx = new Transaction().add(
        createMetadataIx({
          metadata,
          mint: agentMint,
          authority: walletKp.publicKey,
          name: AGENT.name,
          symbol: AGENT.symbol,
        }),
      );
      await provider.sendAndConfirm(tx, []);
      await pace();
    } catch (e: any) {
      warn(
        `could not write token metadata: ${e?.message ?? e}\n` +
          `      The treasury will show as its mint address instead.`,
      );
    }
  }

  // --- the tokenized stock it raised in -----------------------------------
  const stockKp = derivedMint("stock mint", args.symbol);
  const stockMint = stockKp.publicKey;
  say(`stock mint ${stockMint.toBase58()} (stands in for ${args.symbol}x)`);
  if (await exists(conn, stockMint)) {
    skip("mint exists");
  } else {
    await createMint(conn, walletKp, walletKp.publicKey, null, 6, stockKp);
    await pace();
  }

  // --- the treasury --------------------------------------------------------
  const treasury = pda([Buffer.from("treasury"), agentMint.toBuffer()]);
  const stockVault = pda([
    Buffer.from("treasury_stock"),
    treasury.toBuffer(),
  ]);
  say(`treasury ${treasury.toBase58()}`);
  if (await exists(conn, treasury)) {
    skip("treasury exists");
  } else {
    await program.methods
      .initializeTreasury(AGENT.hedgeRatioBps, AGENT.rebalanceToleranceBps)
      .accounts({
        authority: walletKp.publicKey,
        config: configPda,
        agentMint,
        stockMint,
        market,
        treasury,
        stockVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    await pace();
  }

  // --- the raise -----------------------------------------------------------
  const stockAta = await getOrCreateAssociatedTokenAccount(
    conn,
    walletKp,
    stockMint,
    walletKp.publicKey,
  );
  await pace();

  const treasuryNow = await program.account.agentTreasury.fetch(treasury);
  const held = BigInt(treasuryNow.stockQty.toString());
  const want = BigInt(units(AGENT.stockQty).toString());
  say(`stock in the vault: ${Number(held) / SCALE} of ${AGENT.stockQty}`);
  if (held >= want) {
    skip("already funded");
  } else {
    const shortfall = new BN((want - held).toString());
    await mintTo(
      conn,
      walletKp,
      stockMint,
      stockAta.address,
      walletKp,
      BigInt(shortfall.toString()),
    );
    await pace();
    await program.methods
      .depositStock(shortfall)
      .accounts({
        authority: walletKp.publicKey,
        config: configPda,
        treasury,
        stockVault,
        authorityTokenAccount: stockAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    await pace();
  }

  // --- the NAV denominator -------------------------------------------------
  //
  // Supply lives on the bonding curve, which this program has no CPI it can
  // trust for, so the authority maintains it. Without it NAV per token divides
  // by zero and the screen shows a dash where the number that matters goes.
  say(`tokens outstanding ${AGENT.tokensOutstanding.toLocaleString()}`);
  if (BigInt(treasuryNow.tokensOutstanding.toString()) > 0n) {
    skip("already set");
  } else {
    await program.methods
      .setTreasuryPolicy(
        AGENT.hedgeRatioBps,
        AGENT.rebalanceToleranceBps,
        true,
        units(AGENT.tokensOutstanding),
      )
      .accounts({
        authority: walletKp.publicKey,
        config: configPda,
        treasury,
      })
      .rpc();
    await pace();
  }

  // --- margin behind the hedge --------------------------------------------
  const position = pda([
    Buffer.from("position"),
    treasury.toBuffer(),
    market.toBuffer(),
  ]);
  const quoteAta = getAssociatedTokenAddressSync(
    quoteMint,
    walletKp.publicKey,
  );
  say(`hedge margin ${AGENT.hedgeMargin.toLocaleString()}`);
  if (await exists(conn, position)) {
    skip(`position ${position.toBase58()}`);
  } else {
    if (!(await exists(conn, quoteAta))) {
      throw new Error(
        `the payer holds no ${quoteMint.toBase58()} account.\n` +
          "  Run `npm run seed` against this cluster first: it mints the quote\n" +
          "  token this market settles in.",
      );
    }
    await program.methods
      .fundTreasuryHedge(units(AGENT.hedgeMargin))
      .accounts({
        authority: walletKp.publicKey,
        config: configPda,
        treasury,
        market,
        oracle,
        position,
        authorityTokenAccount: quoteAta,
        vault: marketVault,
        pool,
        poolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await pace();
  }

  // --- open the short ------------------------------------------------------
  //
  // Permissionless, so this is the same call the keeper makes on a schedule.
  // `RebalanceNotNeeded` is the success case on a re-run: it means the hedge
  // is already inside its tolerance band.
  say("opening the hedge");
  try {
    await program.methods
      .rebalanceHedge()
      .accounts({
        cranker: walletKp.publicKey,
        config: configPda,
        treasury,
        market,
        oracle,
        position,
        pool,
        poolVault,
        marketVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    await pace();
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/RebalanceNotNeeded/.test(msg)) {
      skip("already inside the tolerance band");
    } else {
      throw new Error(
        `the hedge did not open: ${msg}\n` +
          "  A stale oracle is the usual cause: rebalancing increases risk, so\n" +
          "  it takes the strict price budget and refuses a price older than a\n" +
          "  minute. Start the keeper, or run this during market hours.",
      );
    }
  }

  const final = await program.account.agentTreasury.fetch(treasury);
  const pos = await program.account.position.fetch(position).catch(() => null);
  console.log("\n  treasury open\n");
  console.log(`    agent        ${AGENT.name} (${agentMint.toBase58()})`);
  console.log(`    treasury     ${treasury.toBase58()}`);
  console.log(
    `    stock held   ${Number(final.stockQty) / SCALE} ${args.symbol}`,
  );
  console.log(
    `    hedge        ${pos ? Number(pos.size) / SCALE : 0} shares (target ${
      AGENT.hedgeRatioBps / 100
    }% short)`,
  );
  console.log(
    `\n  The Treasuries screen scans for this on its next pass, which is`,
  );
  console.log(`  within about five minutes of a page load.\n`);
}

main().catch((e) => {
  console.error(`\n  ${e.message ?? e}\n`);
  process.exit(1);
});
