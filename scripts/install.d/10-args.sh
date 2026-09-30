# Option parsing.
#
# An UNKNOWN option is an error, not a warning (opencode's installer warns and
# carries on). This script edits the user's shell profile, so a typo such as
# `--no-modify-pth` would otherwise silently do the one thing the user asked it
# not to do.
#
# Environment inputs (read here so `--version` and the upgrade path agree):
#   QIALIKE_VERSION          version to install; the automatic updater passes it
#   QIALIKE_SOURCE           `github`, `gitcode` or `auto` — the same as --source
#   QIALIKE_INSTALL_BASE_URL one explicit releases directory — NO fallback
#   QIALIKE_INSTALL_SOURCES  full source list, `<base>` or `<base>|<api>`, comma-
#                            separated (tests, private multi-mirror setups)
#   QIALIKE_INSTALL_MEASURE  `0` uses the probe's order instead of comparing speeds
#   QIALIKE_INSTALL_TARGET   platform override — TEST ONLY, see 20-platform.sh
#   QIALIKE_INSTALL_LIB_ONLY `1` sources the bundle without installing (tests)

qialike_usage() {
  cat <<'EOF'
qialike installer

Usage: install [options]

Options:
    -h, --help              display this help message
    -v, --version <version> install a specific version (e.g. 0.6.0 or v0.6.0)
        --no-modify-path    don't modify shell config files (.bashrc, .zshrc)
        --source <name>     github | gitcode | auto (default auto = the policy above)
        --base-url <url>    use exactly this releases directory, no fallback
        --dry-run           print what would be done, then change nothing

Two hosts carry the release: github.com/qialike/qialike (canonical) and
gitcode.com/qialike/qialike (mirror). Both are checked for connectivity first, and
which one is used follows from what answered:

    github only        use github
    gitcode only       use gitcode
    both               sample the real download from each and use the FASTER one —
                       reachability says nothing about a 55 MB body, and a GitHub
                       whose asset CDN is throttled is reachable
    neither            stop: nothing is downloaded, nothing is written, and an
                       installed qialike keeps working (exit 3)

    --source gitcode        skip the policy and use that host only
    --source github         likewise, for the canonical host
    QIALIKE_INSTALL_MEASURE=0   never compare, keep the policy's own order

Examples:
    curl -fsSL https://qialike.com/install | bash
    curl -fsSL https://qialike.com/install | bash -s -- --source gitcode
    curl -fsSL https://qialike.com/install | bash -s -- --version 0.6.0
    bash scripts/install --dry-run
EOF
}

# Split a source specification into two index-aligned arrays.
#
# Indexed arrays, not an associative one: macOS ships bash 3.2, which has none, and
# `60-path.sh` already goes out of its way to stay compatible with it. An entry with
# no `|` gets its API derived when the host is one that needs it, so
# `--base-url https://gitcode.com/qialike/qialike/releases` resolves instead of
# silently finding nothing.
qialike_parse_sources() {
  local spec=$1 entry base api
  local IFS=','

  SOURCE_BASES=()
  SOURCE_APIS=()
  for entry in $spec; do
    # Spaces are stripped rather than trimmed: a URL never contains one, and this
    # keeps a hand-written comma list readable without a helper.
    entry=${entry// /}
    if [[ -z "$entry" ]]; then
      continue
    fi

    # The separator has to be tested for, not inferred: `${entry#*|}` returns the
    # WHOLE string when there is no `|`, so a bare base would otherwise be taken as
    # its own API URL and asked for JSON.
    if [[ "$entry" == *"|"* ]]; then
      base=${entry%%|*}
      api=${entry#*|}
    else
      base=$entry
      api=''
    fi

    # An empty API slot always TRIES to derive one, so writing `base|` means the same
    # thing as plain `base`: the bare form is what a user types, and a host that needs
    # an API would otherwise resolve nothing for no visible reason. A host with no
    # derivable API derives nothing and is read through its redirect.
    if [[ -z "$api" ]]; then
      api=$(qialike_api_for "$base" || true)
    fi

    SOURCE_BASES+=("${base%/}")
    SOURCE_APIS+=("$api")
  done

  if (( ${#SOURCE_BASES[@]} == 0 )); then
    die "no release sources configured (check QIALIKE_INSTALL_SOURCES)"
  fi
}

parse_args() {
  REQUESTED_VERSION=${QIALIKE_VERSION:-}
  NO_MODIFY_PATH=false
  DRY_RUN=false

  # An explicit override means exactly ONE source. A private mirror or a test
  # fixture must not have the public fallbacks silently appended to it: a
  # deliberately unreachable host would then be papered over by a working one, and
  # the failure under test would never surface. Comparing speeds is only meaningful
  # with something to compare, so any single-source form turns it off.
  local spec=${DEFAULT_SOURCES}
  SOURCE_MEASURE=$MEASURE
  if [[ -n "${QIALIKE_INSTALL_SOURCES:-}" ]]; then
    spec=$QIALIKE_INSTALL_SOURCES
  elif [[ -n "${QIALIKE_INSTALL_BASE_URL:-}" ]]; then
    spec=$QIALIKE_INSTALL_BASE_URL
    SOURCE_MEASURE=0
  fi
  if [[ -n "${QIALIKE_SOURCE:-}" ]]; then
    spec=$(qialike_named_sources "$QIALIKE_SOURCE") \
      || die "unknown source '$QIALIKE_SOURCE' (expected github, gitcode or auto)"
    if [[ "$QIALIKE_SOURCE" != auto ]]; then
      SOURCE_MEASURE=0
    fi
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        qialike_usage
        exit 0
        ;;
      -v|--version)
        if [[ -z "${2:-}" ]]; then
          die "--version requires a version argument"
        fi
        REQUESTED_VERSION=$2
        shift 2
        ;;
      --no-modify-path)
        NO_MODIFY_PATH=true
        shift
        ;;
      --source)
        if [[ -z "${2:-}" ]]; then
          die "--source requires github, gitcode or auto"
        fi
        spec=$(qialike_named_sources "$2") \
          || die "unknown source '$2' (expected github, gitcode or auto)"
        if [[ "$2" != auto ]]; then
          SOURCE_MEASURE=0
        else
          SOURCE_MEASURE=$MEASURE
        fi
        shift 2
        ;;
      --base-url)
        if [[ -z "${2:-}" ]]; then
          die "--base-url requires a URL argument"
        fi
        spec=$2
        SOURCE_MEASURE=0
        shift 2
        ;;
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      *)
        die "unknown option '$1' (try --help)"
        ;;
    esac
  done

  # The escape hatch, applied last because it is the most explicit thing a caller
  # can say about the comparison.
  case "${QIALIKE_INSTALL_MEASURE:-}" in
    0) SOURCE_MEASURE=0 ;;
    1) SOURCE_MEASURE=$MEASURE ;;
  esac

  # A trailing slash would produce `//download/...`; harmless for GitHub but not for
  # every mirror, so it is stripped once, per source, as the list is parsed.
  qialike_parse_sources "$spec"
  SOURCE_INDEX=0
  BASE_URL=${SOURCE_BASES[0]}
  if (( ${#SOURCE_BASES[@]} < 2 )); then
    SOURCE_MEASURE=0
  fi
}
