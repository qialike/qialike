#!/usr/bin/env bash
# Remove the ~/.local/bin/dsh-tui symlink created by scripts/install.sh.
#
# Usage: pnpm uninstall:local     (or: bash scripts/uninstall.sh)
set -euo pipefail

INSTALL_DIR="${HOME}/.local/bin"
LINK="$INSTALL_DIR/dsh-tui"

if [[ -L "$LINK" ]]; then
  rm -f "$LINK"
  echo "dsh-tui: removed $LINK"
else
  echo "dsh-tui: no symlink at $LINK (nothing to remove)"
fi
