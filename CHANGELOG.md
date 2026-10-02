# Changelog

Notable changes to qialike, newest first. This file starts at **0.6.0**.

Versioning is [SemVer](https://semver.org/). While the embedded DeepSeek Harness is a developer
preview, a minor bump may carry a breaking change — those are marked `!`.

## [0.9.2] - 2026-10-02

### Changed

- Version bump to 0.9.2; no user-visible changes to the TUI or the harness.

### Fixed

- **A release already live on npm is no longer reported as a failure** — the post-publish wait is 900 s, up from 30.
- **CI verifies the binary it actually built** — the step no longer assumes `dist/qialike`.
- **Ctrl+U works with the @file popup open** — a draft ending in an unfinished `@token` made every control chord type its own letter instead of reaching the composer.

## [0.9.1] - 2026-10-01

### Changed

- **Release pages now carry this changelog** — GitHub, GitCode and each tag's own annotation are generated from it.
- **The shell works on Windows outside the build tree** — the `koffi` FFI binding is compiled in instead of resolved at runtime.
- Version bump to 0.9.1.

### Fixed

- **The telemetry off switch works** — `DSH_TELEMETRY_DISABLED` was never read on the boot path.
- **`pnpm typecheck` no longer fails on the known baseline** — CI and the release gate share one policy.
- **A paste can no longer kill the keyboard, and it no longer parks the cursor outside the input box.**

## [0.9.0] - 2026-10-01

### Changed

- **Rebuilt on DeepSeek Harness `0.2.0-rc.2`** (up from `0.1.7-rc.2`); plugin specifiers 124 → 125.
- **Both telemetry rows stay enabled** — the new `otel` row is load-bearing, so disabling it alone would stop telemetry *silently*.
- **Telemetry now defaults to `https://dsh-otel-collector.deepseeksvc.com/v1/logs`** (was `harness-telemetry.deepseeksvc.com`).

## [0.8.3] - 2026-09-28

### Changed

- **`qialike uninstall` no longer repeats or contradicts itself.**
- **The npm package page can no longer go stale** — its version example is the placeholder the publish script rewrites.
- **The install docs gained the npm route's missing prerequisite** (Node.js ≥ 18, reopen the terminal).
- **The READMEs gained an "Uninstall" section** covering all four install routes.
- **The "Updates" chapter is organised by install route.**
- **`qialike upgrade` recognises an npm install** and names the npm command instead of a release `.zip`.
- **The npm install updates itself on Windows.**
- **`qialike uninstall` also names the npm removal command.**

## [0.8.2] - 2026-09-27

### Changed

- **`qialike uninstall` keeps the install directory** and prints the platform command that removes it.
- **The pre-rename `dsh-tui` compatibility layer was removed.**

## [0.8.1] - 2026-09-26

### Changed

- **A Windows npm channel: `npm i -g @qialike/cli`** — a few-KB launcher plus one `os`/`cpu`-gated package per architecture.
- Version bump to 0.8.1; no user-visible changes to the TUI or the harness.

## [0.8.0] - 2026-09-26

### Changed

- **Rebuilt on DeepSeek Harness `0.1.7-rc.2`** (up from `0.1.7-alpha.2`); plugin specifiers 123 → 124.
- **`llm-deepseek-account` is disabled in the TUI composition** — the new account-token route has no terminal sign-in surface.

## [0.7.2] - 2026-09-25

### Fixed

- **Two hosts can no longer append one session log at once** — the file lock is a real `flock(2)` again.
- **Deleting a session another process is writing is refused**, naming the holder.
- **"Already owned" now reads as an instruction** instead of the raw harness error.
- **`qialike web` refuses a session store a newer harness has migrated**, naming the file.
- **The first publish of a release no longer deadlocks** — it decides by HTTP status.

### Changed

- **The sidebar footer no longer prints the embedded harness version**, shrinking it from three rows to two.
- **A default all-target build is testable again** — `tests/smoke.mjs` no longer hardcodes `dist/qialike`.
- **Release testing is split in two** — the required steps in the repository, the real-machine suite outside it.

## [0.7.1] - 2026-09-23

### Added

- **The installer verifies what it downloads** — every release ships `dist/sha256sums.txt` beside the six binaries.

### Fixed

- **The check was written but never ran** — a missing manifest read as "nothing to verify"; older releases need `QIALIKE_ALLOW_UNVERIFIED=1`.

### Changed

- The release scripts now live in this repository under `scripts/release/`.

## [0.7.0] - 2026-09-23

### Changed

- **Rebuilt on DeepSeek Harness `0.1.7-alpha.2`** (up from `0.1.5-rc.2`, 3,148 upstream commits).
- **Settings moved into `qialike.json`**; the one-time migration never overwrites a value you already have.

### Fixed

- **The plugin trust gate is fatal again** — 0.1.7 had made it advisory.
- **An unreadable, unrelated session log no longer kills a resume.**
- Recovered and torn session files are tolerated instead of aborting startup.

## [0.6.4] - 2026-09-23

### Added

- **Drag to select and copy text inside dialogs** — the selection comes from the frame buffer, so what is behind the box is never copied.

### Fixed

- **Copying dropped every line drawn in reverse video.**

## [0.6.3] - 2026-09-22

### Changed

- The hero screen now reads `Ver: <version> <channel> . URL: <site>`.

### Fixed

- **`curl … | bash` aborted on macOS** — bash 3.2 treats an empty array under `set -u` as unbound.

### Documentation

- Both READMEs were rewritten around what a user actually does, with a matching `CONTRIBUTING`.

## [0.6.2] - 2026-09-21

### Added

- **Windows: detect-only update notices** — it cannot replace a running `.exe`, so it says so instead of failing silently.
- **The installer picks a release source by measuring it**; `--source github|gitcode|auto` pins the choice.
- **Source choice is four cases, in order**: one reachable → use it; both → measure; neither → stop and keep the installed version.

### Fixed

- **An older tag is never treated as an update.**
- **Windows picked the mirror even when GitHub worked**, because the probe used `-o /dev/null`.

## [0.6.1] - 2026-09-21

### Added

- **Mirror fallback: gitcode is used when GitHub is unreachable** — a host that connects but transfers nothing is given up on too.
- **End-to-end tests for the installer and the upgrade chain.**

### Fixed

- **The updater's version lookup ignored its injected environment.**
- Pinning a source with `--base-url` / `QIALIKE_INSTALL_BASE_URL` stays a single source with no fallback.

## [0.6.0] - 2026-09-20

### Changed

- **The installer became a networked downloader** — `curl -fsSL https://qialike.com/install | bash` installs the released binary to `~/.dsh/bin`.
- **Six published targets** — Linux, macOS and Windows, x64 and arm64 each.
- A minor bump on purpose: this is the release that changed how qialike is delivered.

### Added

- **Automatic updates** — `qialike upgrade` and `/upgrade`; patches install silently, minors announce; `QIALIKE_DISABLE_AUTOUPDATE=1` turns it off.
