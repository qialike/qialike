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
# Fallback: the source that resolved the version is tried first, then the rest. A
# host can answer the small "what is newest" request and still fail a 55 MB body,
# and that is exactly the case this second attempt exists for. A tag the mirror has
# not caught up to simply 404s there, which is reported rather than hidden.

# One attempt against one source. 0 on success.
qialike_try_download() {
  # $1 = base, $2 = tag, $3 = asset, $4 = output path
  local base=$1 tag=$2 asset=$3 out=$4 url
  local guards=(--connect-timeout "$CONNECT_TIMEOUT" --speed-limit "$SPEED_LIMIT" --speed-time "$SPEED_TIME")

  url="$base/download/$tag/$asset"
  if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
    curl -fL "${guards[@]}" -# -o "$out" "$url"
  else
    curl -fsSL "${guards[@]}" -o "$out" "$url"
  fi
}

qialike_fetch_archive() {
  # $1 = asset name, $2 = tag, $3 = destination directory. Echoes the archive path.
  local asset=$1 tag=$2 dest=$3 attempt i base out
  local count=${#SOURCE_BASES[@]}

  if ! command -v curl >/dev/null 2>&1; then
    die "'curl' is required but not installed"
  fi

  out="$dest/$asset"
  for ((attempt = 0; attempt < count; attempt += 1)); do
    i=$(( (SOURCE_INDEX + attempt) % count ))
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

  die "download failed: $asset (tag $tag) — no source could provide it (tried: $(qialike_source_list))"
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
