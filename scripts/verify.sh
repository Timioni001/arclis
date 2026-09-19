#!/usr/bin/env bash
#
# Run everything that can be checked, and print a plain-English summary.
#
#   bash scripts/verify.sh
#
# Never fails the whole run because one thing is missing - it reports what it
# could and could not check, so you always get the full picture.

set -uo pipefail
cd "$(dirname "$0")/.."

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

PASS=0; FAIL=0; SKIP=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
skip() { printf '  \033[33mSKIP\033[0m  %s  (%s)\n' "$1" "$2"; SKIP=$((SKIP+1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

section "The maths — does the money logic work?"
if command -v cargo >/dev/null 2>&1; then
  OUT=$(cargo test --lib 2>&1)
  if echo "$OUT" | grep -q "test result: ok"; then
    N=$(echo "$OUT" | grep -o '[0-9]* passed' | head -1)
    pass "Rust unit tests ($N)"
  else
    fail "Rust unit tests"
    echo "$OUT" | grep -E "^(error|test result)" | head -5 | sed 's/^/        /'
  fi
else
  skip "Rust unit tests" "Rust not installed — run scripts/setup-ubuntu.sh"
fi

section "The launch tooling — does the Meteora config build?"
if command -v node >/dev/null 2>&1; then
  if [ -d node_modules ]; then
    OUT=$(npm run --silent test:dbc 2>&1)
    if echo "$OUT" | grep -qE "[0-9]+ passing" && ! echo "$OUT" | grep -q "failing"; then
      pass "DBC tests ($(echo "$OUT" | grep -oE '[0-9]+ passing' | head -1))"
    else
      fail "DBC tests"
      echo "$OUT" | tail -5 | sed 's/^/        /'
    fi
  else
    skip "DBC tests" "dependencies not installed — run: npm install"
  fi
else
  skip "DBC tests" "Node not installed — run scripts/setup-ubuntu.sh"
fi

section "The on-chain program — does it compile for Solana?"
if command -v anchor >/dev/null 2>&1; then
  echo "        (first build takes several minutes)"
  if anchor build >/tmp/arclis-build.log 2>&1; then
    pass "anchor build"
  else
    fail "anchor build  — full log: /tmp/arclis-build.log"
    grep -E "^error" /tmp/arclis-build.log | head -5 | sed 's/^/        /'
  fi
else
  skip "anchor build" "Anchor not installed — run scripts/setup-ubuntu.sh"
fi

section "End to end — does it work on a real (local) blockchain?"
if command -v anchor >/dev/null 2>&1 && [ -d node_modules ]; then
  echo "        (starts a local blockchain, takes a few minutes)"
  if anchor test >/tmp/arclis-test.log 2>&1; then
    pass "anchor test"
  else
    fail "anchor test  — full log: /tmp/arclis-test.log"
    grep -E "Error|error|failing" /tmp/arclis-test.log | head -5 | sed 's/^/        /'
  fi
else
  skip "anchor test" "needs Anchor and: npm install"
fi

printf '\n\033[1m—————\033[0m\n'
printf '  %d passed, %d failed, %d skipped\n\n' "$PASS" "$FAIL" "$SKIP"

if [ "$FAIL" -gt 0 ]; then
  cat <<'MSG'
  Something failed. That is expected for the last two checks — the on-chain
  program has never been compiled or run before, so this is the first time
  anyone has seen those results.

  Send the log file it names. The errors are usually small and mechanical.

MSG
  exit 1
fi

if [ "$SKIP" -gt 0 ]; then
  echo "  Everything that could run, passed. Run scripts/setup-ubuntu.sh to"
  echo "  unlock the skipped checks."
  echo
fi
