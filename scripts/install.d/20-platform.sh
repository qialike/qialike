# Platform detection and asset naming.
#
# Only linux-x64 is published today (verified 2026-09-20: every other asset name
# 404s on the release), so every other platform is refused with a precise message
# instead of downloading a 404 body and failing later inside `tar`. Refusing
# BEFORE anything is written is the point: a half-installed platform is worse
# than an honest error.

# The platform this script would install for, as `<os>-<arch>`.
qialike_detect_target() {
  # Test-only override: the whole point is to exercise the refusal paths on a
  # linux-x64 host, which is otherwise impossible.
  if [[ -n "${QIALIKE_INSTALL_TARGET:-}" ]]; then
    printf '%s\n' "$QIALIKE_INSTALL_TARGET"
    return 0
  fi

  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *) die "unsupported operating system: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac

  printf '%s-%s\n' "$os" "$arch"
}

# The release asset for a target. Kept as a table (rather than a single string)
# because the naming already differs per platform family — linux ships a
# `.tar.gz`, the others a `.zip` — and `build.mjs --package` is the source of
# that convention.
qialike_asset_for() {
  case "$1" in
    linux-x64) printf '%s\n' 'qialike-linux-x64.tar.gz' ;;
    linux-arm64) printf '%s\n' 'qialike-linux-arm64.tar.gz' ;;
    darwin-x64|darwin-arm64) printf '%s\n' "qialike-$1.zip" ;;
    windows-x64|windows-arm64) printf '%s\n' "qialike-$1.zip" ;;
    *) return 1 ;;
  esac
}

# The executable's name INSIDE the archive: the archives carry the generic name
# (`build.mjs`: "the archive contains just the generic-named binary"), and on
# Windows that name carries the `.exe` suffix.
qialike_inner_binary() {
  case "$1" in
    windows-*) printf '%s\n' 'qialike.exe' ;;
    *) printf '%s\n' 'qialike' ;;
  esac
}

# Refuse anything that has no published build yet.
qialike_require_supported() {
  local target=$1

  if [[ "$target" == 'linux-x64' ]]; then
    return 0
  fi

  # Recognised, but not released: name the platform so the message is actionable.
  if qialike_asset_for "$target" >/dev/null 2>&1; then
    die "no published build for '$target' yet — only linux-x64 is released; build from source with 'pnpm build --package' instead"
  fi

  die "unsupported platform '$target' (expected one of: linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64, windows-arm64)"
}
