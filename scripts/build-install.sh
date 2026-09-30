#!/usr/bin/env bash
# Assemble `scripts/install` from `scripts/install.d/*.sh`.
#
# The modules are CONCATENATED, not sourced at runtime, because the documented
# entry point is `curl -fsSL https://qialike.com/install | bash`: the script
# arrives on stdin, so there is no sibling directory to source from and no
# $BASH_SOURCE to resolve. Splitting them this way keeps each concern testable on
# its own while still shipping one self-contained file.
#
# The output is deterministic (module order is lexical, no timestamps), and it is
# committed: a clean checkout and the source tarball must both be able to run
# `bash scripts/install` with no build step. `tests/install-bundle.test.ts` fails
# if the committed file and a fresh assembly disagree, which is what keeps the
# two from drifting.
#
# Usage: bash scripts/build-install.sh [output-path]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/install}"

if [[ ! -d "$HERE/install.d" ]]; then
  echo "build-install: no $HERE/install.d directory" >&2
  exit 1
fi

tmp="$OUT.tmp.$$"
{
  printf '#!/usr/bin/env bash\n'
  printf '# GENERATED FILE — do not edit by hand.\n'
  printf '#\n'
  printf '# Assembled from `scripts/install.d/*.sh` by `scripts/build-install.sh`, in lexical\n'
  printf '# order. Edit the modules, then re-run the builder; `tests/install-bundle.test.ts`\n'
  printf '# fails when this file and a fresh assembly disagree.\n'
  printf '#\n'
  printf '# The modules are concatenated rather than sourced because the entry point is\n'
  printf '# `curl -fsSL https://qialike.com/install | bash`: a script arriving on stdin has no\n'
  printf '# siblings to source and no $BASH_SOURCE to resolve.\n'
  printf 'set -euo pipefail\n'

  for module in "$HERE"/install.d/*.sh; do
    printf '\n# ─────────────────────────────────────────────────────────────────────────────\n'
    printf '# %s\n' "$(basename "$module")"
    printf '# ─────────────────────────────────────────────────────────────────────────────\n'
    cat "$module"
  done
} > "$tmp"

# Same-directory rename, so a reader never sees a half-written installer.
mv -f "$tmp" "$OUT"
echo "build-install: wrote $OUT"
