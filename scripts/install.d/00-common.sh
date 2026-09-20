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

# Release plumbing. Assets live at `<base>/download/<tag>/<asset>`, and each source
# is asked for its newest tag in whichever way that host answers:
#
#   - GitHub issues a 302 for `<base>/latest/download/<asset>`, and the tag is in
#     the Location. No API, so nothing counts against the 60/hour unauthenticated
#     API limit — which is why the redirect is read rather than the API.
#   - gitcode answers that same path with an HTML page (verified: 200, text/html,
#     no redirect), so its tag comes from the v5 releases API instead. That API
#     answers unauthenticated; its ASSET downloads are what need care — only GET
#     works there (HEAD is refused with 401), and only GET is ever used here.
#
# The two are NOT equivalent: GitHub is the primary and always carries the newest
# release, the mirror lags. A fallback install can therefore land on an older tag
# than GitHub would have given — which is exactly why the updater refuses to move
# backwards (see `compareVersions` in packages/qialike-app/src/upgrade-policy.ts).
#
# A source is `<base>` or `<base>|<api>`, comma-separated, the first that answers
# winning. The API is optional because it is DERIVED for the hosts that need one
# (`qialike_api_for`), so the list is normally just host names.
# `packages/qialike-app/src/self-update.ts` carries the same list, and
# `tests/self-update.test.ts` fails if the two ever drift apart.
DEFAULT_SOURCES='https://github.com/qialike/qialike/releases,https://gitcode.com/qialike/qialike/releases'

# Probe budget, in seconds. Short on purpose: the point is to notice a blackholed
# GitHub and move on, rather than making the user wait out curl's own defaults.
CONNECT_TIMEOUT=4
PROBE_TIMEOUT=10

# Give up on a body that has stalled. Below 1 KB/s for 30s is not a slow download,
# it is a blocked one — and that is the shape a throttled GitHub takes: the connect
# succeeds, so only a throughput guard can tell it apart from a working source.
SPEED_LIMIT=1024
SPEED_TIME=30

# The sources to try, and the one currently in use. Declared here rather than only
# inside parse_args so the arrays are never UNSET under `set -u` when a test sources
# the bundle and calls a function directly.
SOURCE_BASES=()
SOURCE_APIS=()
SOURCE_INDEX=0
BASE_URL=''
RESOLVED_TAG=''

# The releases API for a host with no `latest` redirect, derived from the base
# rather than hardcoded per repository: `<host>/<owner>/<repo>/releases` becomes
# `<host>/api/v5/repos/<owner>/<repo>/releases/latest`. Only gitcode is known to
# need one, so only gitcode is asked.
qialike_api_for() {
  local base=$1 path

  case "$base" in
    https://gitcode.com/*/releases)
      path=${base#https://gitcode.com/}
      path=${path%/releases}
      printf 'https://gitcode.com/api/v5/repos/%s/releases/latest\n' "$path"
      ;;
    *) return 1 ;;
  esac
}

# The sources as one comma-separated line, for messages.
qialike_source_list() {
  local out='' base

  for base in "${SOURCE_BASES[@]}"; do
    out="${out:+$out, }$base"
  done
  printf '%s\n' "$out"
}

say() { printf '%s: %s\n' "$APP" "$*"; }
warn() { printf '%s: warning — %s\n' "$APP" "$*" >&2; }
die() {
  printf '%s: %s\n' "$APP" "$*" >&2
  exit 1
}
