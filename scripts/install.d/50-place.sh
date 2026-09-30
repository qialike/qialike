# Place the binary at $INSTALL_DIR/$BIN.
#
# mv, never cp. `cp` onto a path that is currently executing fails with
# ETXTBSY ("Text file busy"), which is exactly the automatic-upgrade case: the
# running qialike is replacing itself. rename(2) swaps the directory entry
# atomically and the running process keeps the old inode, so the upgrade works.
# The previous installer used `cp` and therefore could not upgrade a running
# binary at all; `tests/install-bundle.test.ts` pins this so it cannot come back.
#
# The copy-to-staging step is still a `cp` — but into a fresh name that nothing
# is executing, which is safe, and it keeps a failed download from leaving a
# truncated binary where a working one used to be.

qialike_place() {
  # $1 = path to the extracted binary. Echoes the installed path.
  local src=$1 dest="$INSTALL_DIR/$BIN" staged

  mkdir -p "$INSTALL_DIR" || die "could not create $INSTALL_DIR"

  staged="$INSTALL_DIR/.$BIN.new.$$"
  if ! cp "$src" "$staged"; then
    rm -f "$staged"
    die "could not stage the new binary at $staged"
  fi
  if ! chmod 755 "$staged"; then
    rm -f "$staged"
    die "could not make $staged executable"
  fi
  if ! mv -f "$staged" "$dest"; then
    rm -f "$staged"
    die "could not replace $dest"
  fi

  printf '%s\n' "$dest"
}
