# Changelog

Notable changes to qialike, newest first. This file starts at **0.6.0**.

Versioning is [SemVer](https://semver.org/). While the embedded DeepSeek Harness is a developer
preview, a minor bump may carry a breaking change — those are marked `!`.

## [0.9.0] - 2026-10-01

### Changed

- **Rebuilt on DeepSeek Harness `0.2.0-rc.2`** (up from `0.1.7-rc.2`). No patch anchor had to be
  moved and no source file changed; the plugin-specifier manifest grew 124 → 125.
- **The new `otel` row is load-bearing, so both telemetry rows stay enabled.**
  `session-telemetry-otel` now injects `otel`, and disabling that row alone would stop telemetry
  **silently** — no error, no warning, no visible symptom.
- **Telemetry now defaults to `https://dsh-otel-collector.deepseeksvc.com/v1/logs`** (was
  `harness-telemetry.deepseeksvc.com`), and the row gained a `maxRequestBytes` bound. Both READMEs
  name the new endpoint.

## [0.8.3] - 2026-09-28

### Changed

- **`qialike uninstall` no longer repeats or contradicts itself.** The kept install directory and its
  removal command are reported once, and a home holding only `bin/` no longer claims there is nothing
  to remove right after listing what it kept.
- **The npm package page can no longer go stale.** Its "reinstall the platform package" example is
  back to the `0.0.0-template` placeholder that `scripts/release/publish-npm.sh` rewrites, and that
  script refuses to publish a README which pins a real version or has lost the placeholder. The
  install docs also gained the route's missing prerequisite (Node.js ≥ 18, terminal reopened) and the
  recommendation to run inside Windows Terminal rather than the legacy console host.
- **The READMEs gained an "Uninstall" section**: one two-step procedure across all four install routes,
  including the ordering trap — deleting the program first leaves `~/.dsh`, credentials included, with
  no command left to clear it.
- **The "Updates" chapter is organised by install route**, so "how do I update an npm install?" is
  answered by a table instead of a trailing clause of the Windows paragraph.
- **`qialike upgrade` recognises an npm install.** It used to name a release `.zip` to swap even for a
  copy npm had placed, and never mention `npm i -g @qialike/cli@latest`; `upgrade` and
  `upgrade --check` now use the same probe as `uninstall` and name the right command.
- **The npm install updates itself on Windows.** A patch installs silently through
  `npm install -g @qialike/cli@<exact version>` and a minor or major release is announced, governed by
  `qialike-update.auto` as on every other platform; every layout was detect-only until now.
- **`qialike uninstall` also names the npm removal command** — `npm uninstall -g @qialike/cli` — so a run
  no longer looks finished while the program stays behind in npm's global prefix.

## [0.8.2] - 2026-09-27

### Changed

- **`qialike uninstall` keeps the install directory.** It clears the rest of the harness home
  (`$DSH_HOME`, default `~/.dsh`) and leaves `<home>/bin`, which is where the program itself lives —
  and on Windows a running executable cannot be deleted. Every run prints the platform command that
  removes it completely.
- **The pre-rename `dsh-tui` compatibility layer was removed.** State files, settings namespaces,
  `DSH_TUI_*` environment variables and old plugin specifiers are no longer migrated or read.

## [0.8.1] - 2026-09-26

### Changed

- **A Windows npm channel: `npm i -g @qialike/cli`.** Windows Terminal has no `bash`, so the shell
  installer cannot run there; the channel is three packages — a few-KB launcher with one
  `optionalDependencies` entry per architecture (`@qialike/cli-win32-x64`, `@qialike/cli-win32-arm64`),
  whose `os`/`cpu` fields make npm fetch only the payload matching the machine. **Windows only, by
  design**: Linux and macOS keep the shell installer. First published 2026-09-30.
- Version bump to 0.8.1. No user-visible changes to the TUI or the harness.

## [0.8.0] - 2026-09-26

### Changed

- **Rebuilt on DeepSeek Harness `0.1.7-rc.2`** (up from `0.1.7-alpha.2`). No patch anchor had to be
  moved; the plugin-specifier manifest grew 123 → 124.
- **`llm-deepseek-account` is disabled in the TUI composition.** Upstream split the DeepSeek provider
  plugin in two, and the new account-token route has no sign-in surface in the terminal client —
  disabling it keeps the model picker exactly as it was.

## [0.7.2] - 2026-09-25

### Fixed

- **Two hosts can no longer append one session log at once.** The build had replaced the harness's
  file lock with a no-op stub, copying a single-process browser worker — but a qialike host shares
  `~/.dsh/sessions` with `dsh web` and with a second qialike, so the write lease excluded nobody and
  two hosts could interleave appends until the session refused to open. The stub is now a real
  non-blocking `flock(2)` with the harness's exact contract; readers were never blocked.
- **Deleting a session another process is writing is refused.** `/sessions` probes the lease read-only
  first and names the holder instead of removing a directory a live writer keeps appending to.
- **"Already owned" now reads as an instruction** rather than echoing the raw harness error.
- **`qialike web` refuses a session store a newer harness has migrated.** Each format generation is a new
  immutable `session.vN` file and the old one is never deleted, so the check names the offending file up
  front instead of failing every history read.
- **The first publish of a release no longer deadlocks.** A `404 Not Found` body read as "release
  already exists", so the upload never started; it now decides by HTTP status.

### Changed

- **The sidebar footer no longer prints the embedded harness version**, which shrank the reserved
  footer rows from three to two.
- **A default all-target build is testable again**: `tests/smoke.mjs` hardcoded `dist/qialike`, which
  `BUILD_TARGETS=ALL` never creates, so the boot smoke failed on every release build; it now resolves
  `$QIALIKE_BIN`, then `dist/qialike`, then the host target.
- **Release testing is split in two.** What must run before a release lives in the repository
  (`scripts/release/test-required.sh`); the real-machine/PTY suite stays outside it
  (`~/deepseek/cli-test/full-suite.sh`, optional).

## [0.7.1] - 2026-09-23

### Added

- **The installer verifies what it downloads.** Every release ships a `dist/sha256sums.txt` beside the six
  binaries and the installer checks the archive against it, refusing a mismatch and moving to the next
  source when one has no usable manifest.

### Fixed

- **The check was written but never ran.** A missing manifest and one that omitted the asset were both
  treated as "nothing to verify". Releases older than this version have none, so installing from one
  is refused; `QIALIKE_ALLOW_UNVERIFIED=1` overrides that on purpose.

### Changed

- The release scripts now live in this repository under `scripts/release/`, so what an official release
  does can be read rather than guessed.

## [0.7.0] - 2026-09-23

### Changed

- **Rebuilt on DeepSeek Harness `0.1.7-alpha.2`** (up from `0.1.5-rc.2`, 3,148 upstream commits). The
  embedded version is what the sidebar reports.
- **Settings moved into `qialike.json`**, because harness 0.1.7 removed runtime settings namespaces. A
  one-time startup migration reads the old spellings, **never overwrites a value you already have**,
  and writes its marker only after it succeeds. The file is written `0600`.

### Fixed

- **The plugin trust gate is fatal again.** 0.1.7 downgraded the failure of *optional* startup entries
  to a warning, quietly making the trust check advisory; every plugin a user overlay references is now
  re-checked before boot, and a rejection fails loudly with the reason.
- **An unreadable, unrelated session log no longer kills a resume.** qialike names the file it could
  not read and leaves the session you asked for intact. The log you did ask to resume is still fatal —
  that distinction is deliberate.
- Recovered and torn session files are tolerated instead of aborting startup.

## [0.6.4] - 2026-09-23

### Added

- **Drag to select and copy text inside dialogs** — the question box, the approval box, the command
  palette and the `@file` completion popup. The selection is taken from the **frame buffer**, so what
  lands on your clipboard is the text inside the box, never the conversation rendered behind it. The
  three full-screen panels (`/models`, `/theme`, `/sessions`) deliberately do not do this: they are
  opaque.

### Fixed

- **Copying dropped every line drawn in reverse video** — selected rows, the hovered tool row,
  highlighted palette entries. Taking the text and applying the highlight are now decided separately.

## [0.6.3] - 2026-09-22

### Changed

- The hero screen's line under the brand mark now reads `Ver: <version> <channel> . URL: <site>`, so a
  binary states its own version and build channel without running `--version`.

### Fixed

- **`curl … | bash` aborted on macOS.** bash 3.2 treats an empty array under `set -u` as an unbound
  variable, and the array in question is empty precisely on the success path. Every array expansion is
  now guarded, with a static check that fails if a bare one reappears.

### Documentation

- Both READMEs were rewritten around what a user actually does, with a matching `CONTRIBUTING` in both
  languages.

## [0.6.2] - 2026-09-21

### Added

- **Windows: detect-only update notices.** Windows cannot replace a running `.exe` and has no `bash`,
  so self-update is not implemented there — it now says so instead of failing silently.
- **The installer picks a release source by measuring it.** GitHub answers a redirect from one host
  while the body comes from a CDN that may be throttled, so with more than one source it samples the
  real asset and downloads from the fastest (`--source github|gitcode|auto` pins the choice).
- **Source choice is four cases, in order**: only GitHub → GitHub; only gitcode → gitcode; both →
  measure; neither → stop and **keep the installed version** (exit code 3, not an error).

### Fixed

- **An older tag is never treated as an update.** Anything but `installed == latest` was classified by
  major/minor alone, so a lagging mirror reporting an older version could overwrite a newer install.
- **Windows picked the mirror even when GitHub worked**, because the probe used `-o /dev/null`, which
  Windows' curl does not map to a null device.

## [0.6.1] - 2026-09-21

### Added

- **Mirror fallback: gitcode is used when GitHub is unreachable**, so "GitHub is blocked" no longer
  means "cannot install". A host that connects but transfers nothing is given up on too.
- **End-to-end tests for the installer and the upgrade chain**, driven against a real local release
  host.

### Fixed

- **The updater's version lookup ignored its injected environment**, so a caller that pointed it at one
  release host got the answer from another.
- Pinning a source with `--base-url` / `QIALIKE_INSTALL_BASE_URL` stays a single source with no
  fallback, so a private mirror is never papered over by a public one.

## [0.6.0] - 2026-09-20

### Changed

- **The installer became a networked downloader**: `curl -fsSL https://qialike.com/install | bash`
  fetches the released binary for your platform instead of placing a local build, and installs to
  `~/.dsh/bin`.
- **Six published targets** — Linux, macOS and Windows, x64 and arm64 each. Windows installs as
  `qialike.exe`; the archive is a `.zip` there and on macOS, so it needs `unzip`.
- A minor bump on purpose: this is the release that changed how qialike is delivered.

### Added

- **Automatic updates.** `qialike upgrade` from the command line and `/upgrade` inside the TUI, with a
  background check shortly after launch. A minor release only announces itself; patches install
  silently; `QIALIKE_DISABLE_AUTOUPDATE=1` turns it off.
