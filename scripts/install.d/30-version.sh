# Version resolution.
#
# The newest tag is read from the redirect the releases server issues for
# `<BASE_URL>/latest/download/<asset>`, NOT from the GitHub API: the
# unauthenticated API allows only 60 requests/hour, while the redirect is
# unlimited and needs no JSON parsing.
#
# Note the two tag spellings in play. Local git tags are annotated and carry a
# `v` (`v0.6.0`), but the GitHub RELEASE tag does not (`0.6.0`) — the download
# URL only works with the bare form (verified: `…/download/v0.5.4/…` 404s while
# `…/download/0.5.4/…` redirects). So a user-supplied `v0.6.0` is normalised
# here, and the version string that goes into the URL and the installer
# environment is always the bare one.

qialike_normalize_version() {
  printf '%s\n' "${1#v}"
}

# Echo the tag to install. `$1` is the asset name, needed to build the URL the
# redirect is read from.
qialike_resolve_version() {
  local asset=$1 url tag

  if [[ -n "${REQUESTED_VERSION:-}" ]]; then
    qialike_normalize_version "$REQUESTED_VERSION"
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    die "'curl' is required but not installed"
  fi

  url=$(curl -fsS -o /dev/null -w '%{redirect_url}' "$BASE_URL/latest/download/$asset" 2>/dev/null || true)
  if [[ -z "$url" ]]; then
    die "could not resolve the latest version from $BASE_URL/latest/download/$asset"
  fi

  # Works for GitHub and for a mirror that keeps the same path shape.
  tag=$(printf '%s\n' "$url" | sed -n 's#.*/download/\([^/]*\)/[^/]*$#\1#p')
  if [[ -z "$tag" ]]; then
    die "could not read a version out of '$url'"
  fi

  printf '%s\n' "$tag"
}
