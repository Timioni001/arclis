#!/usr/bin/env node
/**
 * Why did the program reject an argument the client says it sent correctly?
 *
 *   node scripts/diagnose-args.mjs
 *
 * `create_market` failed with InvalidLeverageParam on a `maxLeverage: 10` that
 * is plainly inside the 1..=20 bound. That can only be one of three things,
 * and they need different fixes, so this prints enough to tell them apart:
 *
 *   1. The client encodes the wrong bytes. Then `max_leverage` below is not
 *      10, and the IDL's field list will show why (wrong order, wrong type, a
 *      missing field, or snake_case leaking through).
 *   2. The client is right and the deployed program disagrees. Then the bytes
 *      are correct here, and the `.so` on the validator was built from
 *      different source than the IDL describes.
 *   3. The IDL staged in target/ is not the one that was copied there.
 */

import { createRequire } from "node:module";
import { statSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const anchor = require("@coral-xyz/anchor");
const { Program, BN, AnchorProvider, Wallet } = anchor;
const { Connection, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID } = require("@solana/spl-token");

const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);

console.log("\n\u001b[1mClient\u001b[0m");
line("@coral-xyz/anchor", require("@coral-xyz/anchor/package.json").version);
line("@solana/web3.js", require("@solana/web3.js/package.json").version);

const IDL_PATH = "./target/idl/arclis.json";
if (!existsSync(IDL_PATH)) {
  console.error(`\n  ${IDL_PATH} is missing. Run: bash scripts/anchor-test.sh\n`);
  process.exit(1);
}
const idl = require(IDL_PATH.replace("./", "../"));

console.log("\n\u001b[1mIDL as staged in target/\u001b[0m");
line("path", IDL_PATH);
line("modified", statSync(IDL_PATH).mtime.toISOString());
line("address", idl.address);
line("instructions", idl.instructions.length);

const mp = idl.types.find((t) => t.name === "MarketParams");
if (!mp) {
  console.error("\n  MarketParams is not in the IDL at all.\n");
  process.exit(1);
}
console.log("\n\u001b[1mMarketParams, as the IDL describes it\u001b[0m");
console.log("  (this order and these types must match programs/arclis/src/instructions/create_market.rs)");
for (const [i, f] of mp.type.fields.entries()) {
  line(`  ${i}. ${f.name}`, typeof f.type === "string" ? f.type : JSON.stringify(f.type));
}

console.log("\n\u001b[1mWhat the client actually puts on the wire\u001b[0m");
const provider = new AnchorProvider(
  new Connection("http://127.0.0.1:8899"),
  new Wallet(Keypair.generate()),
  {},
);
const program = new Program(idl, provider);
const K = () => Keypair.generate().publicKey;

const params = {
  maxLeverage: 10,
  maintenanceMarginBps: 500,
  takerFeeBps: 10,
  liquidationPenaltyBps: 500,
  fundingIntervalSecs: new BN(3600),
  fundingSensitivityBps: 100,
  maxOpenInterest: new BN(1_000_000_000_000),
  maxSkewBps: 10_000,
  maxUtilizationBps: 8_000,
};

const ix = await program.methods
  .createMarket(params)
  .accounts({
    creator: K(), config: K(), oracle: K(), market: K(), quoteMint: K(),
    vault: K(), tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
  })
  .instruction();

const body = ix.data.subarray(8);
line("discriminator", ix.data.subarray(0, 8).toString("hex"));
line("argument bytes", body.subarray(0, 16).toString("hex"));
line("max_leverage (u8)", body[0]);
line("maintenance_margin_bps", body.readUInt16LE(1));
line("taker_fee_bps", body.readUInt16LE(3));
line("liquidation_penalty_bps", body.readUInt16LE(5));
line("funding_interval_secs", body.readBigInt64LE(7).toString());

console.log("\n\u001b[1mThe compiled program\u001b[0m");
const SO = "./target/deploy/arclis.so";
if (existsSync(SO)) {
  const s = statSync(SO);
  line("target/deploy/arclis.so", `${(s.size / 1024).toFixed(0)} KB`);
  line("built at", s.mtime.toISOString());
} else {
  line("target/deploy/arclis.so", "MISSING");
}

console.log("\n\u001b[1mVerdict\u001b[0m");
if (body[0] !== 10) {
  console.log("  The CLIENT is wrong: max_leverage went out as", body[0], "not 10.");
  console.log("  Compare the IDL field list above against create_market.rs.\n");
} else {
  console.log("  The client is correct: max_leverage = 10 on the wire.");
  console.log("  So the deployed program read different bytes, which means the .so");
  console.log("  the validator is running was built from different source than this");
  console.log("  IDL describes. Check that 'built at' above is newer than your last");
  console.log("  edit to create_market.rs, then rerun scripts/anchor-test.sh.\n");
}
