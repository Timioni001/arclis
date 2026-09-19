#!/usr/bin/env bash
#
# One-time toolchain setup for Arclis on Ubuntu / Debian.
#
# Safe to re-run: every step checks whether the tool is already there and skips
# it if so. Nothing here touches the Arclis code - it only installs compilers.
#
#   bash scripts/setup-ubuntu.sh
#
# Takes 20-45 minutes on a first run, most of it compiling the Anchor CLI.

set -euo pipefail

# Versions are pinned to match Anchor.toml. Do not bump them casually - see
# BUILD.md for why this specific pair matters.
SOLANA_VERSION="1.18.26"
ANCHOR_VERSION="0.30.1"

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$1"; }
skip() { printf '    \033[33m--\033[0m  %s\n' "$1"; }

say "1/5  System packages"
if dpkg -s build-essential pkg-config libssl-dev >/dev/null 2>&1; then
  skip "build tools already installed"
else
  echo "    (you will be asked for your password - this is apt, not Arclis)"
  sudo apt-get update -qq
  sudo apt-get install -y build-essential pkg-config libssl-dev libudev-dev curl git
  ok "build tools"
fi

say "2/5  Rust"
if command -v cargo >/dev/null 2>&1; then
  skip "rust already installed ($(cargo --version))"
else
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
  ok "rust"
fi
export PATH="$HOME/.cargo/bin:$PATH"

say "3/5  Node.js"
if command -v node >/dev/null 2>&1; then
  skip "node already installed ($(node --version))"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ok "node"
fi

say "4/5  Solana CLI $SOLANA_VERSION"
if command -v solana >/dev/null 2>&1 && solana --version | grep -q "$SOLANA_VERSION"; then
  skip "solana $SOLANA_VERSION already installed"
else
  sh -c "$(curl -sSfL https://release.anza.xyz/v${SOLANA_VERSION}/install)"
  ok "solana"
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

say "5/5  Anchor $ANCHOR_VERSION  (this is the slow one, ~15-30 min)"
if command -v anchor >/dev/null 2>&1 && anchor --version | grep -q "$ANCHOR_VERSION"; then
  skip "anchor $ANCHOR_VERSION already installed"
else
  if ! command -v avm >/dev/null 2>&1; then
    cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
  fi
  avm install "$ANCHOR_VERSION"
  avm use "$ANCHOR_VERSION"
  ok "anchor"
fi

say "Making the tools available in new terminals"
SHELL_RC="$HOME/.bashrc"
[ -n "${ZSH_VERSION:-}" ] && SHELL_RC="$HOME/.zshrc"
LINE='export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"'
if grep -qF "$LINE" "$SHELL_RC" 2>/dev/null; then
  skip "PATH already set in $SHELL_RC"
else
  printf '\n# Arclis toolchain\n%s\n' "$LINE" >> "$SHELL_RC"
  ok "added to $SHELL_RC"
fi

say "A wallet to deploy and test with"
if [ -f "$HOME/.config/solana/id.json" ]; then
  skip "wallet already exists at ~/.config/solana/id.json"
else
  solana-keygen new --no-bip39-passphrase -o "$HOME/.config/solana/id.json"
  ok "wallet created"
fi

cat <<'DONE'

  Setup finished.

  Open a NEW terminal (so the PATH change takes effect), then:

      cd <this folder>
      bash scripts/verify.sh

DONE
