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
# A source is `<base>` or `<base>|<api>`, comma-separated. Which one is used is the
# four-case policy in `qialike_decide_source` (30-version.sh): the mirror when only it
# answers, the primary when only IT answers, the faster of the two by throughput when
# both do, and a STOP with nothing written when neither does. The API is optional
# because it is DERIVED for the hosts that need one (`qialike_api_for`), so the list
# is normally just host names.
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

# What `qialike_probe_sources` found, filled in together and read by the decision
# (`qialike_decide_source`) and the download (`qialike_fetch_archive`):
#
#   PROBE_INDEXES     sources that ANSWERED, in configured order
#   PROBE_TAGS        tag each of those named, '' when it answered without one
#   PROBE_UNREACHABLE sources that did not answer at all
PROBE_INDEXES=()
PROBE_TAGS=()
PROBE_UNREACHABLE=()

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

# The built-in hosts `--source` names. GitHub is the canonical host; gitcode is the
# mirror a China-side user reaches without the CDN throttling that the reachability
# probe cannot see (see MEASURE_* below).
GITHUB_SOURCES='https://github.com/qialike/qialike/releases'
GITCODE_SOURCES='https://gitcode.com/qialike/qialike/releases'

# Throughput comparison between sources, used whenever there is more than one.
#
# Why measure at all: the probe above answers "is this host reachable", which is a
# DIFFERENT question from "can it move 55 MB". GitHub answers the small redirect
# request from `github.com` and then serves the body from
# `release-assets.githubusercontent.com` (measured: the 302 that comes back names
# that host), so a reachable GitHub whose asset CDN is throttled — the ordinary
# case behind the national firewall — passes the probe and then crawls for tens of
# minutes, with nothing in the output saying which host it chose. Sampling the real
# asset is what tells the two apart.
MEASURE=1
# Sample size and budget per source. 256 KB is enough to separate "throttled" from
# "fine" and small enough to be worth discarding.
MEASURE_BYTES=262144
MEASURE_TIMEOUT=8
# Resolved by parse_args: 1 = compare sources, 0 = use the probe's order.
SOURCE_MEASURE=1

# The sources for a `--source` name, or nothing for an unknown one.
qialike_named_sources() {
  case "$1" in
    github) printf '%s\n' "$GITHUB_SOURCES" ;;
    gitcode) printf '%s\n' "$GITCODE_SOURCES" ;;
    auto) printf '%s\n' "$DEFAULT_SOURCES" ;;
    *) return 1 ;;
  esac
}

# The host of a release base, for messages:
# `https://github.com/qialike/qialike/releases` -> `github.com`.
qialike_host_of() {
  printf '%s\n' "$1" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#/.*$##'
}

# The curl output path that discards a response body on THIS platform.
#
# Not `/dev/null` everywhere: Windows' curl does not map the POSIX spelling onto the
# null device — it resolves the request and then exits 23 trying to create
# `<drive>:\dev\null` — and this installer runs on Windows under Git Bash. The same
# spelling is used in `nullDevice()` on the launcher side, for the same reason.
qialike_null_device() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) printf 'NUL\n' ;;
    *) printf '/dev/null\n' ;;
  esac
}

say() { printf '%s: %s\n' "$APP" "$*"; }
warn() { printf '%s: warning — %s\n' "$APP" "$*" >&2; }
die() {
  printf '%s: %s\n' "$APP" "$*" >&2
  exit 1
}

# Case 4 of the source policy — no configured source is reachable — exits with THIS
# status rather than 1, so a caller can tell "the network is not there, nothing was
# touched, the installed copy still works" apart from "the install failed". Only the
# second is worth reporting to a user or retrying; the automatic updater maps this
# one onto "keep what is installed" and stays quiet. `apps/tui-bin/src/upgrade-
# command.ts` and `packages/qialike-app/src/self-update.ts` carry the same number.
EXIT_NO_SOURCE=3

# Stop an update because not one source answered.
#
# `die` would be the wrong shape: this is the policy's fourth case, not a
# malfunction, and the message has to carry the only fact that matters to the user —
# that nothing was downloaded and nothing was written over.
qialike_stop_no_source() {
  local keep='nothing was installed'
  if [[ -f "$INSTALL_DIR/$BIN" ]]; then
    keep='keeping the installed version'
  fi
  printf '%s: no release source is reachable (tried: %s) — %s\n' \
    "$APP" "$(qialike_source_list)" "$keep" >&2
  exit "$EXIT_NO_SOURCE"
}
