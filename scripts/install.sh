#!/usr/bin/env bash
# Install the single-file dsh-tui binary onto the user's PATH by symlinking
# dist/dsh-tui into ~/.local/bin. Builds it first if the binary is missing.
#
# Usage: pnpm install:local     (or: bash scripts/install.sh)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_FILENAME="dsh-tui"
TARGET="$REPO_ROOT/dist/$BIN_FILENAME"
INSTALL_DIR="${HOME}/.local/bin"
LINK="$INSTALL_DIR/$BIN_FILENAME"

# Build if the binary is not present (or not executable).
if [[ ! -x "$TARGET" ]]; then
  echo "dsh-tui: building $TARGET (first run)…"
  (cd "$REPO_ROOT" && pnpm build) >&2
fi

if [[ ! -x "$TARGET" ]]; then
  echo "dsh-tui: build did not produce $TARGET; aborting" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"

# Atomic-ish: replace an existing symlink or file at the link path.
if [[ -L "$LINK" || -e "$LINK" ]]; then
  rm -f "$LINK"
fi
ln -s "$TARGET" "$LINK"

echo "dsh-tui: linked $TARGET -> $LINK"

# Ensure the install dir is on PATH for bash shells.
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo "dsh-tui: warning: $INSTALL_DIR is not on PATH."
  echo "          Add the following to your shell profile (~/.bashrc):"
  echo "            $PATH_LINE"
fi

echo "dsh-tui: installed. Run 'dsh-tui' (or 'dsh-tui --help')."
