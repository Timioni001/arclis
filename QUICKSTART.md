# Running Arclis

Written for someone who does not write code. Every command is copy-paste, and
each section says what you should see when it works.

You are on Ubuntu. Open a terminal with **Ctrl+Alt+T**.

---

## Get the code

```bash
git clone https://github.com/Timioni001/stocklana-perp-engine.git
cd stocklana-perp-engine
git checkout claude/quirky-faraday-tls27g
```

That last line matters, the work lives on that branch, not on `main`.

---

## Install the tools (once, 20–45 minutes)

```bash
bash scripts/setup-ubuntu.sh
```

It installs four things: Rust and Node (programming languages), the Solana
command-line tool, and Anchor (the framework this is built with). It will ask
for your password once, that is Ubuntu's installer, not Arclis.

Most of the time is Anchor compiling itself. It is normal for it to sit quiet
for ten minutes. Safe to re-run if it stops partway; it skips whatever is
already done.

**When it finishes, close the terminal and open a new one.** The new tools are
only on the menu for terminals opened afterwards.

---

## Check everything works

```bash
cd stocklana-perp-engine
npm install
bash scripts/verify.sh
```

This runs all four levels of checking and prints a summary:

```
  PASS  Rust unit tests (114 passed)
  PASS  DBC tests (37 passing)
  PASS  anchor build
  PASS  anchor test
```

### What each line means

**Rust unit tests**: the money logic. Profit and loss, funding, margin,
liquidation, stock splits, the liquidity pool. 114 separate checks that the
arithmetic is right. Runs in about a second and needs nothing but Rust.

**DBC tests**: the Meteora launch tooling, checked against Meteora's real
software. Confirms the pool configuration Arclis generates is one Meteora will
actually accept.

**anchor build**: compiles the program into something Solana can run.

**anchor test**: starts a private blockchain on your machine and runs the
whole thing end to end: create a market, deposit, open a position, move the
price, close, liquidate.

### If the last two fail

**That is expected, and it is not a setback.** The program has never been
compiled or run before, this is genuinely the first time anyone will see those
results. The first run of new code almost always surfaces a few small,
mechanical problems.

The script tells you where the log is (`/tmp/arclis-build.log` or
`/tmp/arclis-test.log`). Send me that file and I will fix what it found.

The first two checks passing already tells you the important part: the logic
that decides who gets paid is correct.

---

## See it actually do something

The most interesting thing you can run without a wallet, planning a real token
launch quoted in a tokenized stock:

```bash
npm run dbc:plan -- --symbol AAPL --price 250 --vol 0.28 \
  --initial-fdv 5000 --migration-fdv 50000 --session closed
```

You will get something like:

```
--- thresholds (DBC stores these in shares, not dollars) ---
initial FDV        $5,000       = 20.000000 AAPL
migration FDV      $50,000      = 200.000000 AAPL

--- graduation drift over 30d ---
target band        $45,396 … $55,071 (±9.7%)

--- fees ---
schedule           400bps → 100bps over 18.0h
rationale          AAPL is closed; its quote price is frozen for 18.0h. Anyone
                   trading this pool before the open holds a free option on the
                   gap, so the fee starts at 400bps (4x base) and decays to
                   100bps exactly as the venue reopens.

--- Meteora config ---
built and validated against the SDK's own validateConfigParameters.
```

**Why this matters.** You asked for $50,000. Meteora does not store "$50,000" -
it stores "200 AAPL shares". If Apple drops 10%, your $50,000 target quietly
becomes $45,000. That band is the drift, and no launchpad shows it, because for
a normal USDC-quoted launch there is nothing to show.

It signs nothing and spends nothing. Change the numbers and re-run as often as
you like.

Try it with the market open to see the fee logic change:

```bash
npm run dbc:plan -- --symbol AAPL --price 250 --vol 0.28 \
  --initial-fdv 5000 --migration-fdv 50000 --session open
```

The gap premium disappears, because when the market is open there is no frozen
price to protect against.

---

## Everyday commands

Run these from inside the project folder.

| What you want | Command |
|---|---|
| Check everything | `bash scripts/verify.sh` |
| Just the money logic (fast) | `cargo test --lib` |
| Just the launch tooling | `npm run test:dbc` |
| Compile the program | `anchor build` |
| Full end-to-end test | `anchor test` |
| Plan a launch | `npm run dbc:plan -- --symbol AAPL --price 250 ...` |
| Watch a live pool | `npm run dbc:monitor -- --pool <address> --symbol AAPL --price 250` |

---

## When something goes wrong

**`command not found: cargo` / `anchor` / `solana`**
The terminal was open before the tools were installed. Close it, open a new one.
If it persists: `source ~/.bashrc`.

**`error: linker cc not found`**
Missing build tools: `sudo apt-get install -y build-essential`

**`no space left on device`**
Compiling uses a lot of disk. `cargo clean` frees several gigabytes; the next
build is slower but works.

**`anchor build` complains about `edition2024`**
This should not happen, it is the exact problem that was fixed, but if it
does, someone has run `cargo update`. `BUILD.md` explains the fix, and
`python3 scripts/audit_msrv.py` diagnoses it.

**Anything else**
Copy the error and send it over. Errors in this world look alarming and are
usually two lines to fix.

---

## If `anchor test` fails with "Building IDL failed"

Use the wrapper instead:

```bash
bash scripts/anchor-test.sh
```

Anchor's IDL step re-resolves dependencies, ignores this repo's lockfile, and
fails on a modern host compiler. Nothing needs it: the IDL is already
generated and committed. The wrapper builds with `--no-idl`, reconciles the
program ID with the keypair your build generated, stages the committed IDL,
and runs the tests. Full explanation in `BUILD.md`.

## Two things before real money

1. **The program keypair has been rotated, but the old secret is still in
   git history.** The program now points at a fresh key, so nothing you deploy
   is at risk. Purge the old file from history anyway before the repository
   goes public. Steps are in `BUILD.md`.

2. **Nothing is deployed and nothing holds value.** Everything above runs on
   your own machine or a private blockchain that disappears when you stop it.
   You cannot lose money with any command on this page.

---

## Where to read next

- **`docs/ARCHITECTURE.md`**: what every part does. Written for whoever builds
  the interface.
- **`docs/HACKATHON.md`**: how this maps to each bounty.
- **`docs/FEASIBILITY.md`**: the honest assessment, including what is still
  unsolved.
- **`BUILD.md`**: the toolchain detail, for a developer.
