# Download and unpack.
#
# Progress: curl's own bar when stderr is a terminal, silent otherwise (a pipe
# or a log would otherwise fill with carriage returns). NO_COLOR also selects the
# quiet form — the bar is the only coloured thing this script would otherwise
# print, and a caller that asked for no colour has no use for it.
#
# Two guards on the transfer, and both exist because of the mirror fallback:
# `--connect-timeout` so a blackholed host is abandoned quickly rather than at
# curl's default, and `--speed-limit/--speed-time` so a host that connects and then
# stalls is abandoned too. That second shape is the one a throttled GitHub actually
# takes, and without it the fallback would never trigger — the connect succeeds and
# curl waits forever on a body that never arrives.
#
# Checksums: `sha256sums.txt` is not published on either source yet, so an absent
# manifest is a normal outcome and NOT an error — but when one IS published it is
# enforced, against the source the archive came from.
#
# Fallback: the source the decision chose is tried first, then the other REACHABLE
# ones (case 3's order). A host can answer the small "what is newest" request and
# still fail a 55 MB body, and that is exactly the case this second attempt exists
# for. A source that failed the connectivity probe is NOT retried here: it was
# already pronounced unreachable, and dialling it again would spend a connect timeout
# to learn the same thing.

# Comparing sources by throughput.
#
# This runs in case 3 only — both sources answered — because reachability answers "can
# this host name the newest release", which is a different question from "can it move
# 55 MB": GitHub answers the small redirect from `github.com` and serves the body from
# `release-assets.githubusercontent.com`, so a GitHub whose CDN is throttled is
# reachable and slow. Sampling the real asset is what tells those apart — which is why
# the measurement decides rather than a guess at geography. Cases 1 and 2 skip it:
# there is one candidate, so nothing could change.

# Echo how fast one source delivers this asset, in bytes per second, or nothing when
# it cannot serve it at all.
qialike_measure_speed() {
  # $1 = base, $2 = tag, $3 = asset
  local base=$1 tag=$2 asset=$3 out speed

  # The exit status is deliberately IGNORED: the source that needs measuring most is
  # the one that will hit `--max-time`, and curl still prints `%{speed_download}`
  # when it aborts (measured: a trickling source answers `200 131072 16380`, exit
  # 28). Only "not a single byte" means "not a candidate" — a dead host, or a mirror
  # that has not caught up to this tag and 404s.
  out=$(curl -fsSL -r "0-$((MEASURE_BYTES - 1))" \
    --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MEASURE_TIMEOUT" \
    -o "$(qialike_null_device)" -w '%{speed_download}' \
    "$base/download/$tag/$asset" 2>/dev/null || true)

  speed=$(printf '%s' "$out" | tr -d '\r' | sed -n 's/^\([0-9][0-9]*\).*$/\1/p')
  if [[ -z "$speed" ]] || (( speed <= 0 )); then
    return 1
  fi
  printf '%s\n' "$speed"
}

# A rate a person can read.
qialike_human_speed() {
  local speed=$1

  if (( speed >= 1048576 )); then
    printf '%s MB/s' "$(( speed / 1048576 ))"
  elif (( speed >= 1024 )); then
    printf '%s KB/s' "$(( speed / 1024 ))"
  else
    printf '%s B/s' "$speed"
  fi
}

# Point `SOURCE_INDEX`/`BASE_URL` at the fastest REACHABLE source that can actually
# serve this asset, and say what each one measured.
#
# Only sources the connectivity probe reached are sampled (case 3 by definition: two
# or more answered). Ties and unmeasurable sources keep the earlier index: the first
# source that wins strictly is the one chosen, so an inconclusive comparison leaves
# the decision's order exactly as it was. A source that 404s this tag is reported as
# unavailable and can never be chosen — a mirror lagging behind the tag must not turn
# into a failed download followed by a retry.
qialike_choose_source() {
  # $1 = tag, $2 = asset
  local tag=$1 asset=$2 pos i base speed report='' best=-1 best_index=$SOURCE_INDEX

  if (( SOURCE_MEASURE == 0 )) || (( ${#PROBE_INDEXES[@]} < 2 )); then
    return 0
  fi

  for pos in "${!PROBE_INDEXES[@]}"; do
    i=${PROBE_INDEXES[$pos]}
    base=${SOURCE_BASES[$i]}
    speed=$(qialike_measure_speed "$base" "$tag" "$asset" || true)
    if [[ -z "$speed" ]]; then
      report="${report:+$report, }$(qialike_host_of "$base") unavailable"
      continue
    fi
    report="${report:+$report, }$(qialike_host_of "$base") $(qialike_human_speed "$speed")"
    if (( speed > best )); then
      best=$speed
      best_index=$i
    fi
  done

  if (( best < 0 )); then
    # Nothing could be measured — every reachable source 404s this asset. Leave the
    # choice to the download step, whose own error names the asset and the hosts.
    return 0
  fi

  say "source speeds — $report"
  SOURCE_INDEX=$best_index
  BASE_URL=${SOURCE_BASES[$best_index]}
  say "downloading from $(qialike_host_of "$BASE_URL")"
}

# One attempt against one source. 0 on success.
qialike_try_download() {
  # $1 = base, $2 = tag, $3 = asset, $4 = output path
  local base=$1 tag=$2 asset=$3 out=$4 url
  local guards=(--connect-timeout "$CONNECT_TIMEOUT" --speed-limit "$SPEED_LIMIT" --speed-time "$SPEED_TIME")

  url="$base/download/$tag/$asset"
  if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
    curl -fL ${guards[@]+"${guards[@]}"} -# -o "$out" "$url"
  else
    curl -fsSL ${guards[@]+"${guards[@]}"} -o "$out" "$url"
  fi
}

qialike_fetch_archive() {
  # $1 = asset name, $2 = tag, $3 = destination directory. Echoes the archive path.
  local asset=$1 tag=$2 dest=$3 attempt pos i base out tried=''
  local order=() count start=0

  if ! command -v curl >/dev/null 2>&1; then
    die "'curl' is required but not installed"
  fi

  # The candidates are the sources that ANSWERED, in configured order, walked from the
  # one the decision chose. Empty means nobody probed first (a direct call from a test,
  # or a caller that only wants the download), in which case every configured source is
  # still a candidate — the decision is an optimisation, not a prerequisite.
  for i in "${!PROBE_INDEXES[@]}"; do
    order+=("${PROBE_INDEXES[$i]}")
  done
  if (( ${#order[@]} == 0 )); then
    for i in "${!SOURCE_BASES[@]}"; do
      order+=("$i")
    done
  fi
  count=${#order[@]}
  for ((pos = 0; pos < count; pos += 1)); do
    if (( order[pos] == SOURCE_INDEX )); then
      start=$pos
      break
    fi
  done
  # The chosen source leads the list, so the `tried:` report below reads in the order
  # the sources were actually tried.
  local rotated=()
  for ((pos = 0; pos < count; pos += 1)); do
    rotated+=("${order[$(( (start + pos) % count ))]}")
  done
  for ((pos = 0; pos < count; pos += 1)); do
    tried="${tried:+$tried, }${SOURCE_BASES[${rotated[$pos]}]}"
  done

  out="$dest/$asset"
  for ((attempt = 0; attempt < count; attempt += 1)); do
    i=${rotated[$attempt]}
    base=${SOURCE_BASES[$i]}

    if qialike_try_download "$base" "$tag" "$asset" "$out"; then
      qialike_verify_checksum "$base" "$tag" "$asset" "$out"
      printf '%s\n' "$out"
      return 0
    fi

    rm -f "$out"
    if (( attempt + 1 < count )); then
      warn "download from $base failed — trying the next source"
    fi
  done

  die "download failed: $asset (tag $tag) — no source could provide it (tried: $tried)"
}

# Verify against the release's `sha256sums.txt` when that file exists, on the source
# the archive came from: a mirror that has the asset but not the manifest is a
# missing manifest, not a reason to trust a different host's numbers.
qialike_verify_checksum() {
  local base=$1 tag=$2 asset=$3 file=$4 sums expected actual

  sums=$(curl -fsSL "$base/download/$tag/sha256sums.txt" 2>/dev/null || true)
  if [[ -z "$sums" ]]; then
    return 0
  fi

  expected=$(printf '%s\n' "$sums" | awk -v a="$asset" '$2 == a || $2 == "*" a { print $1; exit }')
  if [[ -z "$expected" ]]; then
    return 0
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$file" | cut -d' ' -f1)
  else
    actual=$(shasum -a 256 "$file" | cut -d' ' -f1)
  fi

  if [[ "$expected" != "$actual" ]]; then
    die "SHA256 mismatch for $asset (expected $expected, got $actual)"
  fi
}

# Unpack the archive. Echoes the path of the binary inside it.
#
# Two formats, matching what `build.mjs --package` produces: `.tar.gz` on linux
# and `.zip` elsewhere. The extractor is chosen from the file name rather than
# from the target, so the two cannot disagree about which tool is needed; the
# member that must come out is still resolved from the target.
qialike_extract() {
  # $1 = archive path, $2 = target, $3 = destination directory
  local archive=$1 target=$2 dest=$3 inner

  case "$archive" in
    *.zip)
      if ! command -v unzip >/dev/null 2>&1; then
        die "'unzip' is required to extract $archive"
      fi
      if ! unzip -q -o "$archive" -d "$dest"; then
        die "could not extract $archive"
      fi
      ;;
    *.tar.gz)
      if ! command -v tar >/dev/null 2>&1; then
        die "'tar' is required to extract $archive"
      fi
      if ! tar -xzf "$archive" -C "$dest"; then
        die "could not extract $archive"
      fi
      ;;
    *)
      die "don't know how to extract $archive"
      ;;
  esac

  inner="$dest/$(qialike_inner_binary "$target")"
  if [[ ! -f "$inner" ]]; then
    die "$archive did not contain $(qialike_inner_binary "$target")"
  fi

  printf '%s\n' "$inner"
}
