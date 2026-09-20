# Option parsing.
#
# An UNKNOWN option is an error, not a warning (opencode's installer warns and
# carries on). This script edits the user's shell profile, so a typo such as
# `--no-modify-pth` would otherwise silently do the one thing the user asked it
# not to do.
#
# Environment inputs (read here so `--version` and the upgrade path agree):
#   QIALIKE_VERSION          version to install; the automatic updater passes it
#   QIALIKE_INSTALL_BASE_URL releases-directory override (mirrors, tests)
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
        --base-url <url>    use a different releases directory (mirrors, tests)
        --dry-run           print what would be done, then change nothing

Examples:
    curl -fsSL https://qialike.com/install | bash
    curl -fsSL https://qialike.com/install | bash -s -- --version 0.6.0
    bash scripts/install --dry-run
EOF
}

parse_args() {
  REQUESTED_VERSION=${QIALIKE_VERSION:-}
  NO_MODIFY_PATH=false
  DRY_RUN=false
  BASE_URL=${QIALIKE_INSTALL_BASE_URL:-$DEFAULT_BASE_URL}
  # A trailing slash would produce `//download/...`; harmless for GitHub but not
  # for every mirror, so normalise once here.
  BASE_URL=${BASE_URL%/}

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
      --base-url)
        if [[ -z "${2:-}" ]]; then
          die "--base-url requires a URL argument"
        fi
        BASE_URL=${2%/}
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
}
