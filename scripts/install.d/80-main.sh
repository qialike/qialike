# The install sequence.
#
# Guarded at the bottom so the assembled bundle can be sourced with
# QIALIKE_INSTALL_LIB_ONLY=1 (tests do this); individual modules have no side
# effects at all, so sourcing one of those needs no guard.

QIALIKE_TMP=''

qialike_cleanup() {
  if [[ -n "$QIALIKE_TMP" ]]; then
    rm -rf "$QIALIKE_TMP"
    QIALIKE_TMP=''
  fi
}

main() {
  parse_args "$@"

  local target asset tag archive inner
  target=$(qialike_detect_target)
  qialike_require_supported "$target"
  # Windows installs as `qialike.exe`; everything else as `qialike`. Set before
  # any path is built from $BIN.
  qialike_set_binary_name "$target"
  asset=$(qialike_asset_for "$target")

  if [[ "$DRY_RUN" == true ]]; then
    say "dry run — nothing will be written"
    say "          platform  $target"
    say "          asset     $asset"
    say "          releases  $BASE_URL"
    say "          install   $INSTALL_DIR/$BIN"
    if [[ "$NO_MODIFY_PATH" == true ]]; then
      say "          PATH      left alone (--no-modify-path)"
    else
      say "          PATH      $PATH_LINE"
    fi
    return 0
  fi

  tag=$(qialike_resolve_version "$asset")

  QIALIKE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/qialike-install.XXXXXX") || die "could not create a temporary directory"
  # `qialike_cleanup` reads a global rather than a local: the trap fires after
  # main's frame is gone, where a `local` would be unbound under `set -u`.
  trap qialike_cleanup EXIT INT TERM

  say "installing qialike $tag for $target"
  archive=$(qialike_fetch_archive "$asset" "$tag" "$QIALIKE_TMP")
  inner=$(qialike_extract "$archive" "$target" "$QIALIKE_TMP")
  qialike_place "$inner" >/dev/null

  if [[ "$NO_MODIFY_PATH" == true ]]; then
    say "PATH left alone (--no-modify-path)"
  else
    qialike_ensure_path
  fi

  qialike_verify "$tag"
  say "installed. Run 'qialike' (or 'qialike uninstall')."
}

if [[ "${QIALIKE_INSTALL_LIB_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
