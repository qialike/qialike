# Changelog

Notable changes to qialike, newest first. This file starts at **0.6.0**.

Versioning is [SemVer](https://semver.org/). While the embedded DeepSeek Harness is a developer
preview, a minor bump may carry a breaking change — those are marked `!`.

## [0.11.2] - 2026-10-20

### Added

- **`moss` is now a built-in scheme and the default** — qialike's own dark-forest palette lived in `~/.dsh/themes/`, so only machines that had it showed it.

## [0.11.1] - 2026-10-19

### Added

- **The API-key dialog says where to get a key** — each of the 62 routes maps to its provider's console, and an unknown route says so rather than guessing a URL.
- **`scripts/release/audit-gateway-endpoints.py` checks every route without a key** — it separates a 404 (wrong path) from a 401 (right path, missing credential).

### Fixed

- **`fireworks` and `vercel-ai-gateway` were missing a version segment** — both 404'd on every request, probe and chat alike, so neither provider worked at all.
- **The `/models` probe now sends the configured key** — the 40 routes that answer 401 anonymously show their live catalogue instead of a stale snapshot.
- **Gateway snapshots refreshed from the endpoints themselves** — 314 models added across six tables, and `scripts/release/refresh-gateway-models.py` keeps them current.
- **A gateway model no longer resolves without limits** — the live probe returned ids only, so a model absent from the static snapshot streamed with no context window or output ceiling.
- **Limits come from the serving endpoint** — the probe reads `context_length`, `top_provider.max_completion_tokens` and `architecture.input_modalities`, falling back per field.
- **An unreachable gateway no longer adds latency per request** — a failed probe is remembered for 30 s instead of paying the 4 s timeout on every `resolveModel` call.

## [0.11.0] - 2026-10-18

### Fixed

- **Five provider rows had no endpoint** — an empty `baseURL` made every request die as `request to /chat/completions failed`; they now name their endpoints.
- **Templates are validated on load** — an empty `baseURL`, a non-absolute URL, or an `anthropic-messages` row repeating the `/v1` the protocol appends now fails loudly.
- **Four rows pointed at the wrong depth** — `minimax`/`minimax-cn` ended in `/anthropic/v1` (protocol adds `/v1/messages`), `perplexity` had a stray `/v1`, `kimi-coding` lacked one.

### Changed

- **Rebuilt on DeepSeek Harness `0.2.1-rc.2`** (up from `0.2.1-alpha.2`) — every anchored build patch still applies; the supported range moves with it.

- **`/.bun-cache/` is ignored** — cross-compiling downloads ~391 MB of runtimes there, and the release scripts stage whatever is not ignored.

## [0.10.1] - 2026-10-14

### Fixed

- **Windows builds need no elevated shell** — the farm's links needed a privilege a normal token lacks and the build died on the first with `EPERM: … symlink`; junctions need none.
- **The first `pwsh` command no longer freezes the UI** — the write ACE inherited across the tree in one call (188 s on 350k objects); the grant now runs in a child process at launch.

## [0.10.0] - 2026-10-12

### Added

- **The model can change the session's directory** — the harness mounts a `working_directory` tool, so a `cd` persists for the session.

### Changed

- **QiaLike Bee ships off, behind a switch** — its gateway is not serving yet, so the row is offered only with `bee: { "enabled": true }` in `qialike.json` or `QIALIKE_BEE=1` for one run.
- **Rebuilt on DeepSeek Harness `0.2.1-alpha.2`** (up from `0.2.0-rc.2`) — no anchored build patch moved.

### Fixed

- **`delete` and `move` follow that directory** — they used the session header's original path, so after a `cd` they named a different file than `write` did.
- **`DSH_TOOLS_MODE=both` no longer takes the tools row down** — the mode was removed upstream, so the value is normalized instead of rejected.
- **A repository overlay cannot unwire `working-directory`** — that row decides the base every filesystem tool resolves against.
- **A stale `node_modules` no longer fails the build** — `existsSync` reads a dangling link as absent, so the build reported `File not found` instead of repairing it.

## [0.9.3] - 2026-10-02

### Added

- **QiaLike Bee, qialike's own API route, joins `/models`** — always listed, never removable, and it asks for the key before it shows a model.

### Changed

- Version bump to 0.9.3.

### Fixed

- **`web_fetch` works again** — Bun resolved the web stack's bare `undici` import to its own stub, whose client had no `close()` and silently dropped the fetch pin and the proxy dispatcher.
- **Table cells wrap instead of losing their tail** — a narrow pane ellipsized every overflowing cell, so an answer living in a table's second column ended at an `…`.
- **`/upgrade` updates an npm install on Windows** — the gate asked the platform, not who owns the copy.

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
