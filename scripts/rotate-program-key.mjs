#!/usr/bin/env node
/**
 * Rotate the program keypair without the Solana toolchain.
 *
 * `solana-keygen new` plus `anchor keys sync` is the normal path and you should
 * use it when you have them. This exists because the one time you most need to
 * rotate a key is when you have just discovered it in git history, and that
 * moment does not always coincide with having a working Solana install.
 *
 * A Solana keypair file is a JSON array of 64 bytes: the 32-byte ed25519 seed
 * followed by the 32-byte public key. Node's crypto can produce exactly that,
 * and the result is byte-identical to what the CLI writes.
 *
 *   node scripts/rotate-program-key.mjs             # write a key, print the ID
 *   node scripts/rotate-program-key.mjs --sync      # and rewrite the sources
 *   node scripts/rotate-program-key.mjs --adopt     # sync to the key already on disk
 *
 * `--sync` rewrites `declare_id!`, `Anchor.toml` and the committed IDL, which
 * is what `anchor keys sync` does plus the IDL Anchor leaves alone.
 *
 * `--adopt` generates nothing and points the sources at the keypair already at
 * `target/deploy/arclis-keypair.json`. That is the mode you want after running
 * the default twice, or when someone hands you a key to deploy under.
 */

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_PATH = join(ROOT, "target/deploy/arclis-keypair.json");

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bitcoin-alphabet base58, which is what Solana addresses use. */
function base58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
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
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

function currentProgramId() {
  const lib = readFileSync(join(ROOT, "programs/arclis/src/lib.rs"), "utf8");
  return lib.match(/declare_id!\("([^"]+)"\)/)?.[1] ?? null;
}

const adopt = process.argv.includes("--adopt");
const sync = adopt || process.argv.includes("--sync");
const previous = currentProgramId();

let programId;
if (adopt) {
  if (!existsSync(KEY_PATH)) {
    console.error(`\n  No keypair at ${KEY_PATH.replace(ROOT + "/", "")}. Nothing to adopt.\n`);
    process.exit(1);
  }
  const secret = Uint8Array.from(JSON.parse(readFileSync(KEY_PATH, "utf8")));
  if (secret.length !== 64) {
    console.error(`\n  That file is ${secret.length} bytes, not 64. Not a keypair.\n`);
    process.exit(1);
  }
  programId = base58(secret.subarray(32));
  console.log(`\n  adopting ${KEY_PATH.replace(ROOT + "/", "")}`);
  console.log(`  current  ${previous ?? "unknown"}`);
  console.log(`  on disk  ${programId}\n`);
} else {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // PKCS8 for ed25519 ends with the 32-byte seed; SPKI ends with the 32-byte
  // public key. Both are fixed-length encodings, so the tail slice is exact.
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  programId = base58(pub);

  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, JSON.stringify([...Buffer.concat([seed, pub])]));

  console.log(`\n  wrote    ${KEY_PATH.replace(ROOT + "/", "")}`);
  console.log(`  previous ${previous ?? "unknown"}`);
  console.log(`  new      ${programId}\n`);
}

if (programId === previous) {
  console.log("  Sources already point at this key. Nothing to do.\n");
  process.exit(0);
}

if (!sync) {
  console.log("  Re-run with --sync to rewrite declare_id!, Anchor.toml and the IDL,");
  console.log("  or run `anchor keys sync` if you have the toolchain.\n");
  process.exit(0);
}

if (!previous) {
  console.error("  Could not read the current declare_id!; sync aborted.\n");
  process.exit(1);
}

// Deliberately an explicit file list rather than a recursive search. A blanket
// replace across the tree rewrites the burned ID inside the very documentation
// that warns about it, which turns a security note into a lie.
const FILES = [
  "Anchor.toml",
  "programs/arclis/src/lib.rs",
  "idl/arclis.json",
  "idl/arclis.ts",
];

let touched = 0;
for (const rel of FILES) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) continue;
  const before = readFileSync(path, "utf8");
  const after = before.split(previous).join(programId);
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`  synced   ${rel}`);
    touched++;
  }
}

console.log(`\n  ${touched} file(s) updated.`);
if (adopt) {
  console.log(`  Sources now point at ${programId}.\n`);
} else {
  console.log(`  ${previous} is now burned. Record it somewhere you will recognise it.\n`);
}
