# Shared constants and output helpers.
#
# No side effects: this module only sets variables and defines functions, so a
# test may source it (plus one other module) without running an install.

APP=qialike
BIN=qialike

# Deliberately NOT derived from $DSH_HOME. `qialike uninstall`
# (apps/tui-bin/src/bin.ts) scans exactly `$HOME/.local/bin` and `$HOME/.dsh/bin`
# and drops the PATH line by matching it byte-for-byte, so honouring a DSH_HOME
# override here would place the binary somewhere uninstall cannot reach.
INSTALL_DIR="$HOME/.dsh/bin"

# The marker comment written above PATH_LINE, and the line itself. Both are a
# contract with `qialike uninstall`: it removes the line only on an exact match,
# and then also removes a preceding `# qialike`. Single quotes on purpose — the
# literal text `$HOME` is what the shell profile must contain, so it has to
# survive being written.
MARKER='# qialike'
PATH_LINE='export PATH="$HOME/.dsh/bin:$PATH"'

# Release plumbing. `DEFAULT_BASE_URL` is the releases directory, not the repo:
# assets live at `<BASE_URL>/download/<tag>/<asset>` and the newest tag is
# resolved through `<BASE_URL>/latest/download/<asset>`.
DEFAULT_BASE_URL='https://github.com/qialike/qialike/releases'

say() { printf '%s: %s\n' "$APP" "$*"; }
warn() { printf '%s: warning — %s\n' "$APP" "$*" >&2; }
die() {
  printf '%s: %s\n' "$APP" "$*" >&2
  exit 1
}
