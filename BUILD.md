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

## `anchor test` fails in the IDL step

The symptom is a wall of errors about `proc_macro::SourceFile` while compiling
`proc-macro2`, ending in `Error: Building IDL failed`:

```
error[E0425]: cannot find type `SourceFile` in crate `proc_macro`
   --> .../proc-macro2-1.0.94/src/wrapper.rs:366:26
error: could not compile `proc-macro2` (lib) due to 3 previous errors
Error: Building IDL failed
```

### What is actually happening

`anchor build` runs two separate compilations. The first cross-compiles the
program for Solana with the rustc inside platform-tools, and it works. The
second compiles the program **for the host** with `--features idl-build` to
extract the IDL, and it is the one that fails.

That second step **re-resolves dependencies and ignores this repo's
`Cargo.lock`**. You can see it in the error: the lockfile pins `proc-macro2` to
1.0.107, and the failure is in 1.0.94. All the pinning documented above
protects the program build and does nothing for the IDL build, because the IDL
build is not using it. `proc-macro2` 1.0.94 then references
`proc_macro::SourceFile`, which newer rustc versions removed.

### The fix: do not run that step

Nothing needs it. `scripts/build-idl.py` generates the IDL from the same source
without Anchor's IDL step, and the result is committed under `idl/`. So:

```bash
bash scripts/anchor-test.sh
```

That builds with `--no-idl`, reconciles the program ID, stages the committed
IDL where `anchor.workspace` looks for it, and runs the suite with
`--skip-build`. The steps by hand, if you would rather see them:

```bash
anchor build --no-idl                          # the program, no IDL step
node scripts/rotate-program-key.mjs --adopt    # sync declare_id! to the keypair
anchor build --no-idl                          # rebuild if the ID changed
mkdir -p target/idl target/types
cp idl/arclis.json target/idl/ && cp idl/arclis.ts target/types/
anchor test --skip-build
```

### The program ID trap

`target/` is gitignored, so a fresh clone has **no program keypair**. The first
`anchor build` generates a random one, which then disagrees with
`declare_id!`, and every test fails with `DeclaredProgramIdMismatch`.

Step two above is what fixes it: `--adopt` points `declare_id!`, `Anchor.toml`
and `idl/` at whatever key is on disk. The rebuild afterwards is not optional,
because the old ID is compiled into the `.so`.

The consequence is that **your program ID is a local fact**, and three tracked
files carry it. `git pull` will then refuse to merge over them:

```
error: Your local changes to the following files would be overwritten by merge
```

Stash them before pulling. There is nothing to preserve: the script re-adopts
your key on the next run.

```bash
git stash push -m "local program id" \
  programs/arclis/src/lib.rs Anchor.toml idl/arclis.json idl/arclis.ts
git pull
bash scripts/anchor-test.sh
```

If a pull is blocked by `Cargo.lock` or `programs/arclis/Cargo.toml`, stash
those too, and do not restore them. `Cargo.lock` in this repo is deliberately
pinned and audited against the rustc inside platform-tools; a locally
re-resolved one can reintroduce the edition-2024 wall. The `idl-build` feature
that earlier instructions had you add by hand has been in
`programs/arclis/Cargo.toml` since the restructure, so a local copy of it is
redundant.

### "Test validator does not look started"

```
Unable to get latest blockhash. Test validator does not look started.
```

Four causes, in the order they actually occur. `scripts/anchor-test.sh` handles
all of them and prints the validator log when it still fails, which is the only
thing that says which one it was.

**1. Anchor's five-second stopwatch.** `solana-test-validator` builds a genesis
ledger on first start and routinely takes 20 to 40 seconds on an older machine
or under WSL. Anchor's default `startup_wait` is 5000ms. `Anchor.toml` now sets
90000, which costs nothing when the validator is quick because Anchor polls and
proceeds as soon as it answers.

**2. The open-file limit.** The classic WSL killer. Ubuntu ships a limit of
1024 descriptors; the validator opens far more and dies during genesis with
nothing useful on stdout. The script raises it for its own shell. To raise the
hard limit permanently, add to `/etc/security/limits.conf`:

```
<your-username> hard nofile 65536
```

then close and reopen the WSL terminal.

**3. A stray validator or a wedged ledger.** An aborted run leaves a process
holding the ports, or a half-written `.anchor/test-ledger`. Both make the next
start fail silently. The script clears them.

**4. Memory.** The validator wants around 1.5GB and WSL2 defaults to half the
host's RAM. On an older machine that can land under it without saying so.
Create `%UserProfile%\.wslconfig` in Windows:

```
[wsl2]
memory=4GB
```

then `wsl --shutdown` in PowerShell and reopen Ubuntu.

### Running the validator yourself

When the validator is the problem rather than the tests, run it where you can
see its output:

```bash
solana-test-validator --reset          # terminal one
USE_RUNNING_VALIDATOR=1 bash scripts/anchor-test.sh   # terminal two
```

### The platform-tools notice

```
The latest cargo build-sbf platform-tools (v1.57) is not installed.
```

Informational. If the build reaches `Finished release [optimized] target(s)`,
the version you have worked. Installing v1.57 is a large download and is not
needed for this repo, which targets the Solana 1.18.x pair.

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
