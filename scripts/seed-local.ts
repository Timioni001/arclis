/**
 * Put a working world on a local validator.
 *
 * The interface runs against `VITE_DATA_SOURCE=mock` out of the box, which is
 * enough to check layout and copy but proves nothing about whether the client
 * can actually read the chain. Pointing it at `rpc` needs a config, oracles,
 * markets, pools with capital in them and at least one open position - about
 * twenty instructions in a specific order, with PDAs that must match the ones
 * the frontend derives. Doing that by hand is how you end up debugging a typo
 * instead of the thing you meant to test.
 *
 *     solana-test-validator --reset          # terminal one
 *     anchor deploy                          # terminal two
 *     npm run seed                           # then this
 *
 * Every step checks whether its account already exists and skips if so, so
 * re-running after a partial failure resumes rather than starting over. The
 * quote mint is derived from a fixed seed for the same reason: re-running
 * gives you the same mint instead of orphaning the last one.
 *
 * `--airdrop <pubkey>` is the flag you will actually want. The wallet you
 * connect in the browser is not the wallet that ran this script, and a
 * connected wallet with no SOL and no quote tokens can look at the interface
 * but cannot use it.
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
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
  createMint,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const ROOT = path.resolve(__dirname, "..");
const SCALE = 1_000_000; // price, quote and base all share 1e6

/** What gets listed. Prices are indicative, not live - the keeper owns live. */
const LISTINGS = [
  { symbol: "AAPL", price: 228.5, long: 50 },
  { symbol: "NVDA", price: 178.2, long: 0 },
  { symbol: "MSFT", price: 431.0, long: 0 },
  { symbol: "TSLA", price: 412.75, long: -20 },
  { symbol: "GOOGL", price: 192.3, long: 0 },
];

const LP_DEPOSIT = 500_000;
const TRADER_COLLATERAL = 25_000;
const MINT_TO_WALLET = 250_000;

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

interface Args {
  url: string;
  wallet: string;
  programId?: string;
  airdrop: string[];
  writeEnv: boolean;
  allowMainnet: boolean;
  delayMs: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899",
    wallet:
      process.env.ANCHOR_WALLET ??
      path.join(os.homedir(), ".config", "solana", "id.json"),
    airdrop: [],
    writeEnv: false,
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
      case "--airdrop":
        args.airdrop.push(next());
        break;
      case "--write-env":
        args.writeEnv = true;
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
        throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return args;
}

const USAGE = `
  npm run seed -- [options]

    --url <rpc>           default http://127.0.0.1:8899
    --wallet <path>       default ~/.config/solana/id.json
    --program-id <pubkey> default: the declare_id! in programs/arclis/src/lib.rs
    --airdrop <pubkey>    give a wallet SOL and quote tokens. Repeatable.
                          Use this for the wallet you connect in the browser.
    --write-env           write app/.env.local instead of printing it
    --allow-mainnet       required before this will touch a mainnet URL
    --delay <ms>          pause between RPC calls. Default 0 on a local
                          validator, 400 elsewhere, because a shared endpoint
                          rate-limits a script that does not wait.
`;

/**
 * The deployed program, which is not necessarily the one the committed IDL
 * names. Anyone who has rotated their own key locally has a different
 * `declare_id!`, and seeding the address in the IDL would silently build a
 * world under a program that is not running.
 */
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function symbolBytes(symbol: string): number[] {
  const b = Buffer.alloc(16);
  if (Buffer.byteLength(symbol, "utf8") > 16) {
    throw new Error(`symbol ${symbol} does not fit the 16-byte seed`);
  }
  Buffer.from(symbol, "utf8").copy(b);
  return Array.from(b);
}

/**
 * A deterministic mint, so a second run reuses the first run's token instead
 * of minting a new one and leaving every balance from the last run stranded
 * under an address nothing references any more.
 */
function localQuoteMintKeypair(): Keypair {
  const seed = createHash("sha256").update("arclis local quote mint v1").digest();
  return Keypair.fromSeed(seed.subarray(0, 32));
}

/**
 * Which cluster a URL points at.
 *
 * The interface reads `VITE_CLUSTER` to build explorer links, and it accepts
 * exactly three values. Writing `localnet` for a devnet URL produces links of
 * the form `?cluster=custom&customUrl=...`, which is the wrong shape for a
 * public cluster. Unrecognised hosts fall back to devnet, matching what
 * `config.ts` does with a value it does not know, because guessing mainnet
 * for a private endpoint is the dangerous direction to be wrong in.
 */
type Cluster = "localnet" | "devnet" | "mainnet-beta";

function clusterFor(url: string): { cluster: Cluster; certain: boolean } {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return { cluster: "localnet", certain: true };
  }
  if (/devnet/i.test(host)) return { cluster: "devnet", certain: true };
  if (/testnet/i.test(host)) return { cluster: "devnet", certain: false };
  if (/mainnet/i.test(host)) return { cluster: "mainnet-beta", certain: true };
  return { cluster: "devnet", certain: false };
}

const dollars = (n: number) => new BN(Math.round(n * SCALE));
const units = (n: number) => new BN(Math.round(n * SCALE));

/**
 * How long to wait between RPC calls.
 *
 * A local validator will take everything as fast as it is offered. A public
 * endpoint will not: it rate-limits per method, and this script makes about a
 * dozen calls per listing. Unpaced against devnet it got three markets in
 * before the node started answering 429 to everything and the run died
 * part-built.
 *
 * Set once from the cluster, overridable with `--delay`.
 */
let DELAY_MS = 0;
const pace = () =>
  DELAY_MS > 0
    ? new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    : Promise.resolve();

let step = 0;
const say = (msg: string) => console.log(`  ${String(++step).padStart(2)}. ${msg}`);
const skip = (msg: string) => console.log(`      already done: ${msg}`);

async function exists(conn: Connection, address: PublicKey): Promise<boolean> {
  await pace();
  return (await conn.getAccountInfo(address)) !== null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Before anything opens a socket. This script creates markets and mints
  // millions of quote tokens; against a local validator or devnet that is the
  // point, and against mainnet it is a mistake somebody is one flag away from
  // making. Refusing after the connection is made is refusing too late to be
  // reassuring.
  const { cluster, certain } = clusterFor(args.url);
  if (cluster === "mainnet-beta" && !args.allowMainnet) {
    throw new Error(
      "that URL looks like mainnet.\n" +
        "  This seeds five markets and mints its own quote token, which is not\n" +
        "  something to do by accident on a live cluster. If you meant it,\n" +
        "  pass --allow-mainnet.",
    );
  }

  // Three things can be wrong before a single instruction is built, and each
  // one has a different fix. A parse error from deep inside a keypair loader
  // or a bare "fetch failed" tells you none of them.
  let walletKp: Keypair;
  try {
    const raw = JSON.parse(fs.readFileSync(args.wallet, "utf8"));
    walletKp = Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch (e: any) {
    throw new Error(
      `could not read a keypair from ${args.wallet}\n` +
        `  ${e?.message ?? e}\n` +
        "  Pass --wallet <path>, or create one with `solana-keygen new`.",
    );
  }

  const wallet = new anchor.Wallet(walletKp);
  const conn = new Connection(args.url, "confirmed");

  try {
    await conn.getVersion();
  } catch (e: any) {
    throw new Error(
      `no validator answering at ${args.url}\n` +
        `  ${e?.message ?? e}\n` +
        "  Start one with `solana-test-validator --reset`, or pass --url.",
    );
  }
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const programId = deployedProgramId(args.programId);
  if (!(await exists(conn, programId))) {
    throw new Error(
      `no program deployed at ${programId.toBase58()} on ${args.url}.\n` +
        "Start a validator and `anchor deploy` before seeding.",
    );
  }

  // The IDL carries an address, and it is not necessarily the deployed one.
  const idl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "idl", "arclis.json"), "utf8"),
  );
  idl.address = programId.toBase58();
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const program = new anchor.Program(idl, provider) as any;

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, programId)[0];

  console.log(`\n  program   ${programId.toBase58()}`);
  console.log(`  payer     ${walletKp.publicKey.toBase58()}`);
  DELAY_MS = args.delayMs ?? (cluster === "localnet" ? 0 : 400);

  console.log(`  rpc       ${args.url}`);
  console.log(
    `  cluster   ${cluster}${certain ? "" : "  (guessed from the URL)"}`,
  );
  console.log(`  pacing    ${DELAY_MS}ms between calls\n`);

  // --- payer funding -------------------------------------------------------
  //
  // A local validator hands out whatever you ask for. Devnet's faucet is rate
  // limited and rejects large requests outright, so asking it for 50 SOL fails
  // the whole run rather than funding anything. Ask for what that faucet will
  // actually give, and when it refuses, say so and check whether there is
  // enough already rather than dying on a request that was optional.
  const MIN_SOL = 0.5;
  const balance = await conn.getBalance(walletKp.publicKey);
  if (balance < 5 * LAMPORTS_PER_SOL) {
    const ask = cluster === "localnet" ? 50 : 2;
    say(`requesting ${ask} SOL for the payer`);
    try {
      await conn.confirmTransaction(
        await conn.requestAirdrop(walletKp.publicKey, ask * LAMPORTS_PER_SOL),
        "confirmed",
      );
    } catch (e: any) {
      console.log(`      faucet refused: ${e?.message ?? e}`);
    }
  }

  const funded = await conn.getBalance(walletKp.publicKey);
  console.log(`      balance ${(funded / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  if (funded < MIN_SOL * LAMPORTS_PER_SOL) {
    throw new Error(
      `the payer holds ${(funded / LAMPORTS_PER_SOL).toFixed(3)} SOL, and ` +
        `seeding ${LISTINGS.length} markets needs about ${MIN_SOL}.\n` +
        "  Top it up with `solana airdrop 2` (repeat if rate limited) or\n" +
        "  https://faucet.solana.com, then run this again. It resumes.",
    );
  }

  // --- quote mint ----------------------------------------------------------
  const mintKp = localQuoteMintKeypair();
  const quoteMint = mintKp.publicKey;
  if (await exists(conn, quoteMint)) {
    say(`quote mint ${quoteMint.toBase58()}`);
    skip("mint exists");
  } else {
    say(`creating quote mint ${quoteMint.toBase58()}`);
    await createMint(conn, walletKp, walletKp.publicKey, null, 6, mintKp);
    await pace();
  }

  const payerAta = getAssociatedTokenAddressSync(quoteMint, walletKp.publicKey);
  if (!(await exists(conn, payerAta))) {
    await createAssociatedTokenAccount(
      conn,
      walletKp,
      quoteMint,
      walletKp.publicKey,
    );
    await pace();
  }
  const needed = (LP_DEPOSIT * LISTINGS.length + TRADER_COLLATERAL * 2) * 2;
  say(`minting ${needed.toLocaleString()} quote to the payer`);
  await mintTo(
    conn,
    walletKp,
    quoteMint,
    payerAta,
    walletKp,
    units(needed).toNumber(),
  );
  await pace();

  // --- global config -------------------------------------------------------
  const configPda = pda([Buffer.from("config")]);
  say("global config");
  if (await exists(conn, configPda)) {
    skip(configPda.toBase58());
  } else {
    await program.methods
      .initializeGlobalConfig(10)
      .accounts({
        authority: walletKp.publicKey,
        config: configPda,
        insuranceFund: walletKp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await pace();
  }

  // --- one world per listing ----------------------------------------------
  for (const listing of LISTINGS) {
    const symbol = symbolBytes(listing.symbol);
    const oracle = pda([Buffer.from("oracle"), Buffer.from(symbol)]);
    const market = pda([Buffer.from("market"), oracle.toBuffer()]);
    const marketVault = pda([Buffer.from("vault"), market.toBuffer()]);
    const pool = pda([Buffer.from("lp_pool"), market.toBuffer()]);
    const poolVault = pda([Buffer.from("lp_vault"), pool.toBuffer()]);
    const lpPosition = pda([
      Buffer.from("lp_position"),
      walletKp.publicKey.toBuffer(),
      pool.toBuffer(),
    ]);
    const position = pda([
      Buffer.from("position"),
      walletKp.publicKey.toBuffer(),
      market.toBuffer(),
    ]);

    say(`${listing.symbol} at $${listing.price}`);

    if (!(await exists(conn, oracle))) {
      await program.methods
        .initializePriceOracle(symbol, dollars(listing.price))
        .accounts({
          authority: walletKp.publicKey,
          oracle,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await pace();
    }

    // Publish the price, which is what a keeper does and what the program
    // insists on. `set_market_session` refuses to open against a mark older
    // than MAX_ORACLE_STALENESS_SECS - 60 seconds - so that nobody walks
    // through the door and trades against Friday's close, and every
    // risk-increasing instruction applies the same rule.
    //
    // On a local validator this script runs fast enough that the oracle it
    // just created is still fresh and the point never comes up. On devnet a
    // resumed run finds an oracle from an hour ago, and the program is right
    // to refuse it. Seeding twice is not a reason to weaken a staleness rule;
    // it is a reason for the seeder to behave like the keeper it stands in
    // for. Called again before the position opens, because sixty seconds is
    // not many when every instruction is a network round trip.
    const publishPrice = async () => {
      await program.methods
        .updatePriceOracle(dollars(listing.price), new BN(0))
        .accounts({ authority: walletKp.publicKey, oracle })
        .rpc();
      await pace();
    };

    await publishPrice();

    // A fresh oracle starts Closed, which refuses every increase-risk action.
    // Forced open here so the interface is usable at any hour; the keeper is
    // what decides this from the real NYSE calendar in a running system.
    await program.methods
      .setMarketSession({ open: {} })
      .accounts({ authority: walletKp.publicKey, oracle })
      .rpc();
    await pace();

    if (!(await exists(conn, market))) {
      await program.methods
        .createMarket({
          maxLeverage: 10,
          maintenanceMarginBps: 500,
          takerFeeBps: 10,
          liquidationPenaltyBps: 500,
          fundingIntervalSecs: new BN(3600),
          fundingSensitivityBps: 100,
          maxOpenInterest: units(1_000_000),
          maxSkewBps: 10_000,
          maxUtilizationBps: 8_000,
        })
        .accounts({
          creator: walletKp.publicKey,
          config: configPda,
          oracle,
          market,
          quoteMint,
          vault: marketVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      await pace();
    }

    if (!(await exists(conn, pool))) {
      await program.methods
        .initializeLiquidityPool(new BN(3600))
        .accounts({
          authority: walletKp.publicKey,
          config: configPda,
          market,
          quoteMint,
          pool,
          vault: poolVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      await pace();
    }

    if (!(await exists(conn, lpPosition))) {
      await program.methods
        .depositLiquidity(units(LP_DEPOSIT))
        .accounts({
          owner: walletKp.publicKey,
          config: configPda,
          market,
          oracle,
          pool,
          lpPosition,
          vault: poolVault,
          ownerTokenAccount: payerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await pace();
    }

    // An empty book renders as zeros everywhere, which looks like a broken
    // reader rather than an idle market. Two of the listings carry a real
    // position so open interest, skew and funding have something to show, and
    // one of them is short so the interface is not only ever exercised from
    // the long side.
    if (listing.long !== 0 && !(await exists(conn, position))) {
      await publishPrice();

      await program.methods
        .depositCollateral(units(TRADER_COLLATERAL))
        .accounts({
          owner: walletKp.publicKey,
          config: configPda,
          market,
          oracle,
          position,
          ownerTokenAccount: payerAta,
          vault: marketVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await pace();

      await program.methods
        .openPosition(units(listing.long))
        .accounts({
          owner: walletKp.publicKey,
          config: configPda,
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

      const side = listing.long > 0 ? "long" : "short";
      console.log(`      ${side} ${Math.abs(listing.long)} units open`);
    }
  }

  // --- browser wallets -----------------------------------------------------
  for (const raw of args.airdrop) {
    const target = new PublicKey(raw);
    say(`funding ${target.toBase58()}`);
    const bal = await conn.getBalance(target);
    if (bal < 2 * LAMPORTS_PER_SOL) {
      const ask = cluster === "localnet" ? 10 : 1;
      try {
        await conn.confirmTransaction(
          await conn.requestAirdrop(target, ask * LAMPORTS_PER_SOL),
          "confirmed",
        );
      } catch (e: any) {
        // The quote tokens below are the part that matters and are minted, not
        // begged for. A refused faucet should not cost the caller those.
        console.log(`      faucet refused SOL: ${e?.message ?? e}`);
      }
    }
    const ata = getAssociatedTokenAddressSync(quoteMint, target);
    if (!(await exists(conn, ata))) {
      await createAssociatedTokenAccount(conn, walletKp, quoteMint, target);
      await pace();
    }
    await mintTo(
      conn,
      walletKp,
      quoteMint,
      ata,
      walletKp,
      units(MINT_TO_WALLET).toNumber(),
    );
    await pace();
    console.log(`      10 SOL and ${MINT_TO_WALLET.toLocaleString()} quote tokens`);
  }

  // --- what the interface needs to read any of this ------------------------
  const env = [
    `# Written by \`npm run seed\` against ${cluster}.`,
    "VITE_DATA_SOURCE=rpc",
    `VITE_CLUSTER=${cluster}`,
    `VITE_RPC_URL=${args.url}`,
    `VITE_PROGRAM_ID=${programId.toBase58()}`,
    `VITE_QUOTE_MINT=${quoteMint.toBase58()}`,
    `VITE_MARKETS=${LISTINGS.map((l) => l.symbol).join(",")}`,
    "VITE_REFRESH_MS=5000",
    "",
  ].join("\n");

  if (args.writeEnv) {
    const dest = path.join(ROOT, "app", ".env.local");
    fs.writeFileSync(dest, env);
    console.log(`\n  wrote app/.env.local\n\n  npm run app:dev\n`);
  } else {
    console.log(`\n  put this in app/.env.local, or re-run with --write-env:\n`);
    console.log(
      env
        .split("\n")
        .map((l) => (l ? `    ${l}` : l))
        .join("\n"),
    );
  }

  if (args.airdrop.length === 0) {
    console.log(
      "  The wallet you connect in the browser is not this one. Give it\n" +
        "  funds with:\n\n" +
        "      npm run seed -- --airdrop <your browser wallet pubkey>\n",
    );
  }
}

main().catch((e) => {
  console.error(`\n  seeding failed: ${e?.message ?? e}\n`);
  if (e?.logs) for (const l of e.logs) console.error(`    ${l}`);
  process.exit(1);
});
