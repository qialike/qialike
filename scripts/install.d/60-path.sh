# Put $INSTALL_DIR on PATH for future shells.
#
# Every UNCOMMENTED PATH export in one profile, as `lineno:line`. The `-n` is
# kept so a warning can name the exact line the user has to edit, and the
# `^[[:space:]]*export` anchor is what keeps `# export PATH=…` out.
qialike_live_path_lines() {
  grep -nE '^[[:space:]]*export[[:space:]]+PATH=' "$1" 2>/dev/null || true
}

qialike_ensure_path() {
  if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
    say "$INSTALL_DIR is already on PATH"
    return 0
  fi

  # Profiles this run actually wrote, so the closing hint names a file that
  # exists: a fresh HOME has neither `.bashrc` nor `.zshrc`, and telling the user
  # to `source ~/.bashrc` there is advice they cannot follow.
  local appended_rcs=() rc entry configured

  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [[ -f "$rc" ]] || continue

    # "Configured" means an UNCOMMENTED export already names ~/.dsh/bin. A plain
    # `grep -F "$PATH_LINE"` also matched a commented-out copy of the very same
    # text — the state a profile ends up in when the line was disabled by hand —
    # so the installer called the line configured, appended nothing, and closed by
    # telling the user to `source ~/.bashrc`: `qialike: command not found`
    # survived the install that claimed to fix it.
    #
    # Matching on `.dsh/bin` rather than the whole line is deliberate too: it
    # accepts equivalent spellings (an absolute path, different quoting), where
    # opencode's exact-line `grep -Fxq` would append a duplicate.
    configured=0
    while IFS= read -r entry; do
      [[ -n "$entry" ]] || continue
      if [[ "${entry#*:}" == *'.dsh/bin'* ]]; then
        configured=1
      fi
    done < <(qialike_live_path_lines "$rc")

    if (( configured )); then
      say "$rc already exports $INSTALL_DIR on PATH"
      continue
    fi

    if [[ ! -w "$rc" ]]; then
      warn "$rc is not writable — add this line to it yourself:"
      printf '            %s\n' "$PATH_LINE" >&2
      continue
    fi

    # The marker line and the exact PATH_LINE text are what `qialike uninstall`
    # looks for when it takes the line back out.
    printf '\n%s\n%s\n' "$MARKER" "$PATH_LINE" >> "$rc"
    appended_rcs+=("$rc")
    say "appended to $rc: $PATH_LINE"
  done

  say "$INSTALL_DIR is not on PATH in this shell; run one of the following now,"
  say "or open a new terminal:"
  # Guarded: on bash 3.2 (macOS `/bin/bash`) `"${arr[@]}"` on an EMPTY array
  # trips `set -u` as an unbound variable, which would abort the install at its
  # last step.
  if (( ${#appended_rcs[@]} > 0 )); then
    for rc in "${appended_rcs[@]}"; do
      printf '            source %s\n' "$rc"
    done
  fi
  printf '            %s\n' "$PATH_LINE"
}
