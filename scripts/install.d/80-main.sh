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

  local target asset tag archive inner i
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
    # The whole list, in the order it would be tried, without probing any of them:
    # a dry run that hit the network could not be run offline, and the point here is
    # to show the plan, not to test the links.
    for (( i = 0; i < ${#SOURCE_BASES[@]}; i += 1 )); do
      if (( i == 0 )); then
        say "          releases  ${SOURCE_BASES[$i]}"
      else
        say "          fallback  ${SOURCE_BASES[$i]}"
      fi
    done
    if (( SOURCE_MEASURE == 1 )); then
      say "          policy    github.com, else gitcode.com, else the faster of the two (sampled, up to ${MEASURE_BYTES} B); neither reachable = stop, keep what is installed"
    fi
    say "          install   $INSTALL_DIR/$BIN"
    if [[ "$NO_MODIFY_PATH" == true ]]; then
      say "          PATH      left alone (--no-modify-path)"
    else
      say "          PATH      $PATH_LINE"
    fi
    return 0
  fi

  # NOT `tag=$(…)`: the decision records which source answered in globals, and a
  # command substitution would throw that away (see 30-version.sh). It also applies
  # the four-case source policy — including case 4, which exits here with nothing
  # downloaded and nothing written — and, in case 3, samples the sources and moves
  # the download to the faster one. The tag is fixed before that sampling, so the
  # comparison can only reorder the download, never change the version installed.
  qialike_decide_source "$asset"
  tag=$RESOLVED_TAG

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
