# Changelog

Notable changes to qialike, newest first. This file starts at **0.6.0**.

Versioning is [SemVer](https://semver.org/). While the embedded DeepSeek Harness is a developer
preview, a minor bump may carry a breaking change — those are marked `!`.

## [0.9.0] - 2026-10-01

### Changed

- **Rebuilt on DeepSeek Harness `0.2.0-rc.2`** (up from `0.1.7-rc.2`); no patch anchor moved, no source changed, plugin specifiers 124 → 125.
- **The new `otel` row is load-bearing, so both telemetry rows stay enabled** — `session-telemetry-otel` now injects it, and disabling that row alone would stop telemetry *silently*.
- **Telemetry now defaults to `https://dsh-otel-collector.deepseeksvc.com/v1/logs`** (was `harness-telemetry.deepseeksvc.com`), and the row gained a `maxRequestBytes` bound.

## [0.8.3] - 2026-09-28

### Changed

- **`qialike uninstall` no longer repeats or contradicts itself** — the kept install directory and its removal command are reported once, and a home holding only `bin/` no longer claims there is nothing to remove.
- **The npm package page can no longer go stale** — its version example is back to the `0.0.0-template` placeholder that `scripts/release/publish-npm.sh` rewrites, and that script refuses to publish a pinned or placeholder-less README.
- **The install docs gained the npm route's missing prerequisite** (Node.js ≥ 18, terminal reopened) and the recommendation to run inside Windows Terminal rather than the legacy console host.
- **The READMEs gained an "Uninstall" section** — one two-step procedure across all four install routes, including the ordering trap that leaves `~/.dsh` behind with no command to clear it.
- **The "Updates" chapter is organised by install route**, so "how do I update an npm install?" is answered by a table.
- **`qialike upgrade` recognises an npm install** and now names `npm i -g @qialike/cli@latest` instead of a release `.zip` that such a copy has none of.
- **The npm install updates itself on Windows** — a patch installs silently through `npm install -g @qialike/cli@<exact version>`, a minor or major release is announced, and `qialike-update.auto` still governs it.
- **`qialike uninstall` also names the npm removal command** — `npm uninstall -g @qialike/cli`.

## [0.8.2] - 2026-09-27

### Changed

- **`qialike uninstall` keeps the install directory** — it clears the rest of the harness home (`$DSH_HOME`, default `~/.dsh`) and leaves `<home>/bin`, printing the platform command that removes it completely.
- **The pre-rename `dsh-tui` compatibility layer was removed** — state files, settings namespaces, `DSH_TUI_*` environment variables and old plugin specifiers are no longer migrated or read.

## [0.8.1] - 2026-09-26

### Changed

- **A Windows npm channel: `npm i -g @qialike/cli`** (Windows Terminal has no `bash`, so the shell installer cannot run there) — a few-KB launcher plus one `os`/`cpu`-gated `optionalDependencies` package per architecture (`@qialike/cli-win32-x64`, `@qialike/cli-win32-arm64`); **Windows only, by design**.
- Version bump to 0.8.1. No user-visible changes to the TUI or the harness.

## [0.8.0] - 2026-09-26

### Changed

- **Rebuilt on DeepSeek Harness `0.1.7-rc.2`** (up from `0.1.7-alpha.2`); no patch anchor moved, plugin specifiers 123 → 124.
- **`llm-deepseek-account` is disabled in the TUI composition** — upstream split the DeepSeek provider in two, and the new account-token route has no sign-in surface in a terminal client.

## [0.7.2] - 2026-09-25

### Fixed

- **Two hosts can no longer append one session log at once** — the harness's file lock had been replaced by a no-op stub, so a qialike host sharing `~/.dsh/sessions` with `dsh web` or a second qialike could interleave appends until the session refused to open; the stub is now a real non-blocking `flock(2)`.
- **Deleting a session another process is writing is refused** — `/sessions` probes the lease read-only first and names the holder.
- **"Already owned" now reads as an instruction** rather than echoing the raw harness error.
- **`qialike web` refuses a session store a newer harness has migrated** and names the offending `session.vN` file up front.
- **The first publish of a release no longer deadlocks** — it now decides by HTTP status instead of reading a `404 Not Found` body as "already exists".

### Changed

- **The sidebar footer no longer prints the embedded harness version**, shrinking the reserved footer rows from three to two.
- **A default all-target build is testable again** — `tests/smoke.mjs` hardcoded `dist/qialike`, which `BUILD_TARGETS=ALL` never creates; it now resolves `$QIALIKE_BIN`, then `dist/qialike`, then the host target.
- **Release testing is split in two** — `scripts/release/test-required.sh` in the repository, the real-machine/PTY suite (`~/deepseek/cli-test/full-suite.sh`) optional and outside it.

## [0.7.1] - 2026-09-23

### Added

- **The installer verifies what it downloads** — every release ships a `dist/sha256sums.txt` beside the six binaries, and a mismatch is refused rather than unpacked.

### Fixed

- **The check was written but never ran** — a missing manifest and one that omitted the asset were both treated as "nothing to verify"; releases older than this one have none, so installing from them is refused unless `QIALIKE_ALLOW_UNVERIFIED=1`.

### Changed

- The release scripts now live in this repository under `scripts/release/`, so what an official release does can be read rather than guessed.

## [0.7.0] - 2026-09-23

### Changed

- **Rebuilt on DeepSeek Harness `0.1.7-alpha.2`** (up from `0.1.5-rc.2`, 3,148 upstream commits).
- **Settings moved into `qialike.json`** because harness 0.1.7 removed runtime settings namespaces; a one-time migration **never overwrites a value you already have**, and the file is written `0600`.

### Fixed

- **The plugin trust gate is fatal again** — 0.1.7 had downgraded the failure of *optional* startup entries to a warning, quietly making the check advisory.
- **An unreadable, unrelated session log no longer kills a resume** — qialike names that file and leaves your session intact; the log you did ask to resume is still fatal.
- Recovered and torn session files are tolerated instead of aborting startup.

## [0.6.4] - 2026-09-23

### Added

- **Drag to select and copy text inside dialogs** — the question box, the approval box, the command palette and the `@file` popup; the selection comes from the **frame buffer**, so the conversation behind the box is never copied. The full-screen panels (`/models`, `/theme`, `/sessions`) deliberately do not do this.

### Fixed

- **Copying dropped every line drawn in reverse video** — taking the text and applying the highlight are now decided separately.

## [0.6.3] - 2026-09-22

### Changed

- The hero screen now reads `Ver: <version> <channel> . URL: <site>`, so a binary states its own version and build channel without `--version`.

### Fixed

- **`curl … | bash` aborted on macOS** — bash 3.2 treats an empty array under `set -u` as unbound, and that array is empty precisely on the success path; every expansion is guarded now.

### Documentation

- Both READMEs were rewritten around what a user actually does, with a matching `CONTRIBUTING` in both languages.

## [0.6.2] - 2026-09-21

### Added

- **Windows: detect-only update notices** — it cannot replace a running `.exe` and has no `bash`, so it now says so instead of failing silently.
- **The installer picks a release source by measuring it**, because a "reachable" host can still crawl; `--source github|gitcode|auto` pins the choice.
- **Source choice is four cases, in order**: only GitHub → GitHub; only gitcode → gitcode; both → measure; neither → stop and keep the installed version (exit code 3, not an error).

### Fixed

- **An older tag is never treated as an update** — a lagging mirror reporting an older version could otherwise overwrite a newer install.
- **Windows picked the mirror even when GitHub worked**, because the probe used `-o /dev/null`, which Windows' curl does not map to a null device.

## [0.6.1] - 2026-09-21

### Added

- **Mirror fallback: gitcode is used when GitHub is unreachable** — a host that connects but transfers nothing is given up on too.
- **End-to-end tests for the installer and the upgrade chain**, driven against a real local release host.

### Fixed

- **The updater's version lookup ignored its injected environment**, so a caller pointing it at one release host got another's answer.
- Pinning a source with `--base-url` / `QIALIKE_INSTALL_BASE_URL` stays a single source with no fallback.

## [0.6.0] - 2026-09-20

### Changed

- **The installer became a networked downloader** — `curl -fsSL https://qialike.com/install | bash` fetches the released binary instead of placing a local build, and installs to `~/.dsh/bin`.
- **Six published targets** — Linux, macOS and Windows, x64 and arm64 each; Windows installs as `qialike.exe` and the `.zip` archives need `unzip`.
- A minor bump on purpose: this is the release that changed how qialike is delivered.

### Added

- **Automatic updates** — `qialike upgrade` and `/upgrade`, with a background check after launch; patches install silently, minors only announce, and `QIALIKE_DISABLE_AUTOUPDATE=1` turns it off.
