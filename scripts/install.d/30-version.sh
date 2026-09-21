# Version resolution, connectivity, and the four-case source decision.
#
# The decision has four cases, and they are checked in this order:
#
#   1. only the mirror answers            -> the mirror
#   2. only the primary answers           -> the primary
#   3. both answer                        -> sample both, keep the faster
#   4. neither answers                    -> STOP: nothing is downloaded, nothing is
#                                            written, an installed copy keeps working
#
# Reachability is asked FIRST, and throughput only in case 3. The two questions are
# different on purpose: a host can answer "what is your newest release" and then crawl
# on the 55 MB body (GitHub answers the small redirect from `github.com` and serves
# the body from `release-assets.githubusercontent.com`), so case 3 has to measure —
# while cases 1 and 2 must NOT measure, because sampling a host already known to be
# dead only buys a timeout, and sampling the only live host cannot change the answer.
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

  url=$(curl -fsS ${budget[@]+"${budget[@]}"} -o "$(qialike_null_device)" -w '%{redirect_url}' "$base/latest/download/$asset" 2>/dev/null || true)
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
    tag=$(curl -fsS ${budget[@]+"${budget[@]}"} "$api" 2>/dev/null \
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

# Did this host answer AT ALL?
#
# Any status counts: the question is whether the host replied, not whether it liked
# the path, so a 404 from a live host is reachable while a refused or blackholed
# connection is not. `-f` is deliberately absent (it would turn a 404 into a failure)
# and `%{http_code}` is read instead — curl prints `000` when no response arrived,
# which is exactly the signal wanted.
#
# `-I` (HEAD), not a plain GET: the releases page is ~234 KB on GitHub (measured) and
# nothing in it is wanted, only the answer. Measured on both hosts: HEAD answers `200`
# with `size_download=0` in 0.23 s (GitHub) / 0.39 s (gitcode), so the cheap form is
# also a supported one.
qialike_source_reachable() {
  local base=$1 code

  code=$(curl -sS -I -o "$(qialike_null_device)" -w '%{http_code}' \
    --connect-timeout "$CONNECT_TIMEOUT" --max-time "$PROBE_TIMEOUT" "$base" 2>/dev/null || true)
  code=$(printf '%s' "$code" | tr -d '\r')
  # Only a definite `000` — curl's code for "no response arrived" — counts as
  # unreachable. An empty answer means the probe itself said nothing, and guessing
  # "down" there would stop an update that might have worked; guessing "up" only costs
  # a download attempt whose own error names the host.
  [[ "$code" != 000 ]]
}

# Ask every configured source whether it is there, and what it would install.
#
# The tag read doubles as the connectivity test whenever it SUCCEEDS — one request
# answers both questions — so `qialike_source_reachable` is asked only about a source
# whose tag read failed, and only there do "down" and "up, but no such asset" need
# telling apart. That distinction is what keeps case 4 (nothing reachable => stop)
# from swallowing a real failure such as an unpublished platform or a pulled release,
# which is a source that IS reachable and simply has nothing for this asset.
#
# A pinned version needs no tag at all, only the host, so it asks the cheap question
# directly. The version was decided by the caller; what is being decided here is
# where it comes from.
qialike_probe_sources() {
  local asset=$1 i tag

  PROBE_INDEXES=()
  PROBE_TAGS=()
  PROBE_UNREACHABLE=()

  for i in "${!SOURCE_BASES[@]}"; do
    if [[ -n "${REQUESTED_VERSION:-}" ]]; then
      # A pinned version already answers "which release" — the only open question is
      # WHERE it comes from, so the host is asked directly. The tag cannot stand in for
      # that answer here: it is known before any host is contacted.
      if ! qialike_source_reachable "${SOURCE_BASES[$i]}"; then
        PROBE_UNREACHABLE+=("$i")
        continue
      fi
      PROBE_INDEXES+=("$i")
      PROBE_TAGS+=("$(qialike_normalize_version "$REQUESTED_VERSION")")
      continue
    fi

    tag=$(qialike_source_tag "${SOURCE_BASES[$i]}" "${SOURCE_APIS[$i]}" "$asset" || true)
    # A tag that came back is proof the host answered; only an empty one leaves the
    # question open, and only then is the host asked the cheaper way.
    if [[ -z "$tag" ]] && ! qialike_source_reachable "${SOURCE_BASES[$i]}"; then
      PROBE_UNREACHABLE+=("$i")
      continue
    fi
    PROBE_INDEXES+=("$i")
    PROBE_TAGS+=("$tag")
  done
}

# The four cases, applied. Sets `SOURCE_INDEX`/`BASE_URL`/`RESOLVED_TAG`, says which
# case applied, and stops the run entirely in case 4.
#
# The TAG comes from the first REACHABLE source that named one, in configured order,
# so a reachable GitHub still decides the version even when the mirror is faster: a
# source that lags must not be able to move anyone backwards. `RESOLVED_TAG` is fixed
# before any measurement, so case 3 can only reorder the DOWNLOAD.
qialike_decide_source() {
  local asset=$1 i first='' unreachable='' base

  if ! command -v curl >/dev/null 2>&1; then
    die "'curl' is required but not installed"
  fi

  qialike_probe_sources "$asset"

  # Case 4 first: with nothing reachable there is nothing to compare, nothing to fall
  # back to — and no reason to create a temp dir or touch a shell profile. Everything
  # the installer would have done is skipped by construction, which is what makes
  # "the installed version is untouched" true rather than merely likely.
  if (( ${#PROBE_INDEXES[@]} == 0 )); then
    qialike_stop_no_source
  fi

  for i in "${!PROBE_INDEXES[@]}"; do
    if [[ -n "${PROBE_TAGS[$i]}" ]]; then
      first=$i
      break
    fi
  done
  if [[ -z "$first" ]]; then
    # Reachable, but not one of them publishes this asset: a real failure, not case 4.
    # Reporting this as "no source is reachable" would send the user after a network
    # problem that does not exist.
    die "could not resolve the latest version from any source (tried: $(qialike_source_list)) — check your network, or none of them publishes $asset"
  fi

  SOURCE_INDEX=${PROBE_INDEXES[$first]}
  BASE_URL=${SOURCE_BASES[$SOURCE_INDEX]}
  RESOLVED_TAG=${PROBE_TAGS[$first]}

  # `+`-guarded, and not for style: on bash < 4.4 — macOS `/bin/bash` is still 3.2.57 —
  # an EMPTY array expanded as `"${arr[@]}"` counts as an unbound variable under
  # `set -u`, and `set -euo pipefail` is line 11 of this script. This loop's array is
  # empty exactly when EVERY source answered, so the abort landed on the HAPPY path of
  # a real macOS install (`PROBE_UNREACHABLE[@]: unbound variable`). The PATH step
  # guards the same hazard on `appended_rcs` (60-path.sh); this instance was missed.
  # `${arr[@]:-}` is NOT a substitute: it yields one empty word, so the body would run
  # once with an empty index.
  for i in ${PROBE_UNREACHABLE[@]+"${PROBE_UNREACHABLE[@]}"}; do
    base=${SOURCE_BASES[$i]}
    unreachable="${unreachable:+$unreachable, }$(qialike_host_of "$base")"
  done

  if (( ${#PROBE_INDEXES[@]} == 1 )); then
    if (( SOURCE_INDEX > 0 )); then
      # Case 1. stderr, and a warning rather than a note: the user needs to know,
      # because the mirror can lag behind GitHub and this install may land on an older
      # tag.
      warn "${SOURCE_BASES[0]} did not answer — using $BASE_URL, which can lag behind"
    elif [[ -n "$unreachable" ]]; then
      # Case 2. A note, not a warning: the canonical host answered, so this is the
      # ordinary install — but naming the dead host keeps a silent half-outage from
      # looking like everything is well. Nothing is sampled here: there is one
      # candidate, so a comparison could not change anything.
      say "source $(qialike_host_of "$BASE_URL") — $unreachable not reachable"
    fi
    return 0
  fi

  # Case 3. Both answered, so the body decides (`qialike_choose_source`).
  qialike_choose_source "$RESOLVED_TAG" "$asset"
}

# The historical name for the decision; the two are one implementation, not two paths.
qialike_resolve_into_globals() {
  qialike_decide_source "$1"
}

# Echo just the tag. The source it came from is NOT visible to the caller here — a
# command substitution is a subshell — so anything that needs to download from that
# same source must use `qialike_resolve_into_globals` instead.
#
# A pinned version is pure arithmetic and stays OFFLINE: this form exists for callers
# that only want the string, and reaching for the network to answer a question the
# caller already answered would make it fail on a host with no route out.
qialike_resolve_version() {
  if [[ -n "${REQUESTED_VERSION:-}" ]]; then
    qialike_normalize_version "$REQUESTED_VERSION"
    return 0
  fi
  qialike_resolve_into_globals "$1"
  printf '%s\n' "$RESOLVED_TAG"
}
