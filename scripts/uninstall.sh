#!/usr/bin/env bash
# Remove the ~/.local/bin/qialike symlink created by the removed
# scripts/install.sh (legacy dev install; the current installer is scripts/install).
#
# Usage: pnpm uninstall:local     (or: bash scripts/uninstall.sh)
set -euo pipefail

INSTALL_DIR="${HOME}/.local/bin"
for name in qialike dsh-tui; do
  LINK="$INSTALL_DIR/$name"
  if [[ -L "$LINK" ]]; then
    rm -f "$LINK"
    echo "qialike: removed $LINK"
  else
    echo "qialike: no symlink at $LINK (nothing to remove)"
  fi
done
