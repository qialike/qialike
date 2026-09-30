# Confirm the installed binary runs and reports the version we asked for.
#
# opencode's installer only reads `--version` back; comparing it catches the
# failure that is otherwise invisible until much later — a release whose asset
# does not match its tag. A mismatch is reported but not fatal: the binary was
# installed and works, and failing here would leave the user with a working
# command and a non-zero exit code.
#
# `--version` prints `qialike <version>`, so the version is the last word.

qialike_verify() {
  local expected=$1 out actual

  out=$("$INSTALL_DIR/$BIN" --version 2>/dev/null || true)
  if [[ -z "$out" ]]; then
    die "the installed binary did not run: $INSTALL_DIR/$BIN --version produced no output"
  fi

  actual=${out##* }
  if [[ "$actual" != "$expected" ]]; then
    warn "installed binary reports '$out' but $expected was expected — the release asset and its tag disagree"
    return 0
  fi

  say "installed  $INSTALL_DIR/$BIN ($out)"
}
