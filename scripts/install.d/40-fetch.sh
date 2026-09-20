# Download and unpack.
#
# Progress: curl's own bar when stderr is a terminal, silent otherwise (a pipe
# or a log would otherwise fill with carriage returns). NO_COLOR also selects the
# quiet form — the bar is the only coloured thing this script would otherwise
# print, and a caller that asked for no colour has no use for it.
#
# Checksums: `sha256sums.txt` is not published yet, so an absent manifest is a
# normal outcome and NOT an error — but when one IS published it is enforced.
# Until then the only trust anchors are HTTPS and GitHub itself.

qialike_fetch_archive() {
  # $1 = asset name, $2 = tag, $3 = destination directory. Echoes the archive path.
  local asset=$1 tag=$2 dest=$3 url out

  if ! command -v curl >/dev/null 2>&1; then
    die "'curl' is required but not installed"
  fi

  url="$BASE_URL/download/$tag/$asset"
  out="$dest/$asset"

  if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
    if ! curl -fL -# -o "$out" "$url"; then
      die "download failed: $url — the release may not carry $asset for this platform"
    fi
  else
    if ! curl -fsSL -o "$out" "$url"; then
      die "download failed: $url — the release may not carry $asset for this platform"
    fi
  fi

  qialike_verify_checksum "$tag" "$asset" "$out"
  printf '%s\n' "$out"
}

# Verify against the release's `sha256sums.txt` when that file exists.
qialike_verify_checksum() {
  local tag=$1 asset=$2 file=$3 sums expected actual

  sums=$(curl -fsSL "$BASE_URL/download/$tag/sha256sums.txt" 2>/dev/null || true)
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
