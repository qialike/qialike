/**
 * The ripgrep binary qialike carries for its `glob` / `grep` tools.
 *
 * The harness's `@deepseek-ai/dsh-tool-fs-search` reaches ripgrep through the
 * `@vscode/ripgrep` module, which resolves its platform binary with
 * `createRequire(import.meta.url).resolve('@vscode/ripgrep-<platform>-<arch>/bin/rg')`.
 * Inside a `bun build --compile` single file that resolution cannot succeed: the
 * module's own JavaScript is bundled, but its optional platform package and the
 * 5 MB binary are not, so `require.resolve` throws and every `glob` / `grep` call
 * fails at launch (`ripgrep launch failed`, `SEARCH_FAILED`).
 *
 * qialike therefore embeds the binary for each build target and patches the
 * tool's ripgrep lookup to use it first: the embedder is
 * `embedRipgrepBinaries` in `apps/tui-bin/build.mjs`, the resolver the patch
 * injects is `ripgrepPath()` in `packages/qialike-app/src/ripgrep-shim.ts`, and
 * this module holds the one value they share.
 *
 * @module @qialike/qialike-app/ripgrep-mode
 */

/** The directory under the OS temp dir holding the materialized ripgrep binary. */
export const RIPGREP_TEMP_DIR = 'qialike-ripgrep'
