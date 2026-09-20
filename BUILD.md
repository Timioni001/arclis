# Building on Ubuntu

## The error you hit

```
error: failed to parse manifest at `~/.cargo/registry/src/.../toml_edit-0.25.15/Cargo.toml`

Caused by:
  feature `edition2024` is required

  The package requires the Cargo feature called `edition2024`, but that feature
  is not stabilized in this version of Cargo (1.75.0-dev).
```

or, depending on which crate Cargo reaches first:

```
error: lock file version 4 requires `-Znext-lockfile-bump`
```

Neither is a problem with your Ubuntu install, your `rustup`, or your Anchor
version. Both are the same underlying situation.

## Why it happens

`anchor build` does not use the Rust on your `PATH`. It shells out to
`cargo build-sbf`, which uses a **second, bundled Rust toolchain** that ships
inside Solana's platform-tools:

| Anchor | Solana platform-tools | bundled rustc | bundled cargo |
|--------|----------------------|---------------|---------------|
| 0.30.1 | 1.18.x               | **1.75.0**    | **1.75.0**    |
| 0.31.x | 2.1.x                | 1.84.1        | 1.84.1        |

Your host `rustc` can be 1.90 and it makes no difference, the on-chain program
is compiled by the bundled 1.75.0.

Meanwhile `Cargo.lock` was resolved by your *host* Cargo, which happily picked
the newest version of every transitive dependency. Several of those have since
moved to Rust edition 2024, which requires rustc 1.85+. The dependency chain
that breaks this repo is:

```
anchor-lang 0.30.1
  └─ borsh 1.8.1
      └─ borsh-derive 1.8.1
          └─ proc-macro-crate 3.5.0        (MSRV 1.82)
              └─ toml_edit 0.25.15         (edition 2024, MSRV 1.85)  ← fails
                  └─ toml_datetime 1.1.1   (edition 2024, MSRV 1.85)
```

Cargo 1.75 cannot even *parse* an edition-2024 manifest, so it fails before
compiling a single line of your code. That is why the error names a crate you
have never heard of and never imported.

The lockfile-version error is the same story: your host Cargo wrote a v4
lockfile, and Cargo 1.75 only understands v3.

## What was done here

`Cargo.lock` is now resolved against **rustc 1.75.0** and committed in **v3**
format. Concretely:

- `programs/arclis/Cargo.toml` declares `rust-version = "1.75.0"`.
- The lock was regenerated with Cargo's MSRV-aware resolver, which picks the
  newest version of each dependency that 1.75.0 can actually compile.
- Four crates that declare no MSRV metadata (so the resolver could not see the
  problem) were pinned by hand: `blake3`, and the `digest 0.11` /
  `block-buffer 0.12` / `crypto-common 0.2` chain it pulled in.
- Every one of the 251 registry crates in the lock was then audited against
  crates.io. Two entries still exceed 1.75, `wasip2` and `wit-bindgen`: and
  both are gated behind `cfg(target_os = "wasi")`, so they are never downloaded
  or parsed for the SBF target. `cargo tree -i wasip2` returns "nothing to
  print" for any non-WASI target, which is the check to re-run if you doubt it.

**Do not run a bare `cargo update`.** It will re-resolve against your host
toolchain and put the edition-2024 crates straight back. If you need to add a
dependency, see *Re-auditing* below.

## Building

```bash
# One-time toolchain install
sh -c "$(curl -sSfL https://release.anza.xyz/v1.18.26/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1 && avm use 0.30.1

# Fast loop: the arithmetic, on the host, no validator needed
cargo test --lib

# The on-chain program
anchor build

# Integration tests against a local validator
yarn install
anchor test
```

`cargo test --lib` is the one to run constantly, 48 tests covering PnL,
funding, margin, and the liquidation waterfall, in well under a second. It needs
no Solana toolchain at all.

## The program keypair has been rotated

**Current program ID: `A2WJAgqLpcZSkyqHu1cJA62gANDjiYx7M5Qyz9kZdoH3`**

### What happened

`target/deploy/perp_engine-keypair.json` was committed to this repository's git
history. That file was the **secret key** for program ID `8KwHVevdqvNrwTCgsTvwQzvWXNsdonHKCi9mrH6gN23x`,
so anyone who has ever cloned this repo can deploy to and upgrade that ID.

### What was done about it

A fresh keypair was generated, `declare_id!` and `Anchor.toml` were synced to
it, and the old file was deleted from the working tree. `target/` and
`**/*-keypair.json` are both in `.gitignore`, so it cannot happen again by
accident.

**`8KwHVevdqvNrwTCgsTvwQzvWXNsdonHKCi9mrH6gN23x` is burned.** Never deploy to it, never
fund it, and treat any program found at that address as hostile. It is named
here on purpose: a burned key you can recognise is safer than one you cannot.

### What is still outstanding

**Removing a file from the index does not remove it from history.** The old
secret key is still in this repository's git objects. It no longer matters for
the program the code now points at, but purge it anyway before the repo goes
public:

```bash
git filter-repo --path target/deploy/perp_engine-keypair.json --invert-paths
git push --force
```

Coordinate with anyone holding a clone first, since this rewrites history.

### Rotating again

The current key is on disk at `target/deploy/arclis-keypair.json` and is *not*
tracked. If you lose it before deploying, or want a fresh one:

```bash
solana-keygen new -o target/deploy/arclis-keypair.json --force
anchor keys sync     # rewrites declare_id! and Anchor.toml together
```

If you ever need to do this without the Solana toolchain installed:

```bash
node scripts/rotate-program-key.mjs          # write a key, print the ID
node scripts/rotate-program-key.mjs --sync   # and rewrite declare_id!/Anchor.toml/IDL
node scripts/rotate-program-key.mjs --adopt  # sync to a key already on disk
```

A keypair file is just a JSON array of 64 bytes, the 32-byte ed25519 seed
followed by the 32-byte public key, so the script's output is byte-identical to
what `solana-keygen` writes. `--adopt` is the mode to use when someone hands you
a key to deploy under, or when a generate step ran twice.

## If you would rather upgrade than pin

Moving to Anchor 0.31.1 + Agave 2.1.x gets you rustc 1.84.1, which clears the
MSRV-1.82 crates but **not** the edition-2024 ones (they need 1.85). Solana 2.3
platform-tools ships rustc 1.87 and clears all of them.

Either upgrade is a real change, not a drop-in: Anchor 0.31 changed
`declare_id!` handling, the IDL format, and several `Accounts` constraint
behaviours. Worth doing before mainnet, not worth doing the week of a demo. The
pinned lock here works today on the toolchain you already have.

## Re-auditing after a dependency change

```bash
# 1. Resolve against the platform-tools MSRV
sed -i 's/^resolver = "2"$/resolver = "3"/' Cargo.toml
rm Cargo.lock && cargo generate-lockfile
sed -i 's/^resolver = "3"$/resolver = "2"/' Cargo.toml   # 1.75 cannot read resolver 3

# 2. Check nothing slipped through
python3 scripts/audit_msrv.py
```

`scripts/audit_msrv.py` queries crates.io for every locked crate and prints any
that need more than rustc 1.75 or use edition 2024. Anything it reports must be
pinned back by hand with `cargo update -p <crate>@<ver> --precise <older>`, or
confirmed target-gated with `cargo tree -i <crate>`.
