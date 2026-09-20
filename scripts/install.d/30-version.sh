# Version resolution, and the connectivity probe.
#
# The newest tag is read from whichever source ANSWERS FIRST, and that same source
# is then used for the download. The probe and the resolution are the same
# operation on purpose: "what is your newest release?" is exactly the question a
# blackholed host cannot answer, so a separate liveness check would only add a
# round trip that can disagree with this one.
#
# GitHub answers with a redirect and is read WITHOUT the API: the unauthenticated
# API allows only 60 requests/hour, while the redirect is unlimited. gitcode has no
# such redirect (its `/latest/download/...` is an HTML page), so it is read through
# its v5 releases API, which does answer unauthenticated. See `DEFAULT_SOURCES` in
# 00-common.sh for both shapes.
#
# Note the two tag spellings in play. Local git tags are annotated and carry a `v`
# (`v0.6.0`), but the RELEASE tag does not (`0.6.0`) — the download URL only works
# with the bare form (verified on GitHub: `…/download/v0.5.4/…` 404s while
# `…/download/0.5.4/…` redirects). So a user-supplied `v0.6.0` is normalised here,
# and the version string that goes into the URL and the installer environment is
# always the bare one.

qialike_normalize_version() {
  printf '%s\n' "${1#v}"
}

# Ask one source for its newest tag. Echoes the tag, or nothing when this source
# cannot be reached or cannot answer. `$2` is its API URL, empty for a host that
# needs none.
qialike_source_tag() {
  local base=$1 api=$2 asset=$3 url tag
  local budget=(--connect-timeout "$CONNECT_TIMEOUT" --max-time "$PROBE_TIMEOUT")

  url=$(curl -fsS "${budget[@]}" -o /dev/null -w '%{redirect_url}' "$base/latest/download/$asset" 2>/dev/null || true)
  if [[ -n "$url" ]]; then
    tag=$(printf '%s\n' "$url" | sed -n 's#.*/download/\([^/]*\)/[^/]*$#\1#p')
    if [[ -n "$tag" ]]; then
      printf '%s\n' "$tag"
      return 0
    fi
  fi

  if [[ -n "$api" ]]; then
    # `head -n1` and the anchored sed: the answer is one line of JSON, and the FIRST
    # `tag_name` is the release's own. The asset entries carry `browser_download_url`
    # and `name`, never a `tag_name`, so nothing later in the body can be mistaken
    # for it.
    tag=$(curl -fsS "${budget[@]}" "$api" 2>/dev/null \
      | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | head -n 1 \
      | sed 's/.*"\([^"]*\)"$/\1/' || true)
    if [[ -n "$tag" ]]; then
      printf '%s\n' "$tag"
      return 0
    fi
  fi

  return 1
}

# Resolve the tag to install, and leave `RESOLVED_TAG`/`BASE_URL`/`SOURCE_INDEX` on
# the source that answered. `$1` is the asset name, needed to build the URL the
# redirect is read from.
#
# Sets GLOBALS rather than echoing, and that is not a style choice: the obvious
# `tag=$(qialike_resolve_version …)` runs in a SUBSHELL, so `SOURCE_INDEX`/`BASE_URL`
# set in here would be discarded and the download would go back to the source that
# just failed. `qialike_resolve_version` below keeps the echoing form for callers
# that only want the tag.
qialike_resolve_into_globals() {
  local asset=$1 i tag

  if [[ -n "${REQUESTED_VERSION:-}" ]]; then
    RESOLVED_TAG=$(qialike_normalize_version "$REQUESTED_VERSION")
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    die "'curl' is required but not installed"
  fi

  for i in "${!SOURCE_BASES[@]}"; do
    tag=$(qialike_source_tag "${SOURCE_BASES[$i]}" "${SOURCE_APIS[$i]}" "$asset" || true)
    if [[ -n "$tag" ]]; then
      SOURCE_INDEX=$i
      BASE_URL=${SOURCE_BASES[$i]}
      RESOLVED_TAG=$tag
      if (( i > 0 )); then
        # stderr, and a warning rather than a note: the user needs to know, because
        # the mirror can lag behind GitHub and this install may land on an older tag.
        warn "${SOURCE_BASES[0]} did not answer — using $BASE_URL, which can lag behind"
      fi
      return 0
    fi
  done

  die "could not resolve the latest version from any source (tried: $(qialike_source_list)) — check your network, or none of them publishes $asset"
}

# Echo just the tag. The source it came from is NOT visible to the caller here — a
# command substitution is a subshell — so anything that needs to download from that
# same source must use `qialike_resolve_into_globals` instead.
qialike_resolve_version() {
  qialike_resolve_into_globals "$1"
  printf '%s\n' "$RESOLVED_TAG"
}
