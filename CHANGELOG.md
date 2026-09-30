# Changelog

Notable changes to qialike, newest first. This file starts at **0.6.0**.

Versioning is [SemVer](https://semver.org/). While the embedded DeepSeek Harness is a developer
preview, a minor bump may carry a breaking change — those are marked `!`.

## [0.8.3] - 2026-09-28

### Changed

- **`qialike uninstall` says each thing once — and never contradicts itself.** The kept install
  directory and the exact command that deletes it are reported when that directory is found, so the
  closing line is now just `uninstalled — user state cleared` instead of restating both. And a home
  holding nothing but `bin/` no longer ends with `nothing to remove …` one line after reporting what
  it kept — the shape a Windows install has when `qialike.exe` was placed but never run.
- **The npm package page can no longer go stale.** `packages/npm/qialike-cli/README.md` ships verbatim
  as the page for `@qialike/cli`, and its "reinstall the platform package" example carried a
  hardcoded version — which is why the first publish (0.8.1) went out telling users
  `npm i -g @qialike/cli-win32-arm64@0.8.2`. The example now carries the same `0.0.0-template`
  placeholder as the manifests, and `scripts/release/publish-npm.sh` rewrites it in the copy it
  uploads. The script refuses to publish when the README pins a real version or has lost the
  placeholder, and verifies on the staged copy that no placeholder survives. The install docs (both
  READMEs and the package page) also now state the prerequisite that was missing: the npm route needs
  Node.js ≥ 18 installed first, with the terminal reopened so PATH picks it up. They also recommend
  running qialike **inside the Windows Terminal app** rather than the legacy console window that
  `cmd.exe` / `powershell.exe` open on their own — the surface needs 24-bit colour, `▀▄█` half-block
  art, emoji, a flat cursor and mouse input, which Windows Terminal provides and the old console host
  does not (`winget install Microsoft.WindowsTerminal`; Windows 11 ships it). The shell inside stays
  the user's choice.
- **The READMEs gained an "Uninstall" section.** Removal was documented only in scattered prose, and
  only the npm route had an explicit recipe, so a reader had to reconstruct the procedure. It is one
  procedure with two steps — `qialike uninstall` clears the state on every route, then you delete the
  program — differing only in step two, which the run prints for you. The new section tables all four
  routes (shell installer, Windows manual zip, Windows npm, source build), and records the ordering
  trap: removing the program first leaves `~/.dsh` — credentials included — on disk with no command
  left to clear it.
- **The "Updates" chapter is organised by install route too.** The npm route was mentioned only as a
  trailing clause of the Windows paragraph, so the answer to "how do I update an npm install?" was
  buried. A table now covers all four routes — shell installer (automatic; `qialike upgrade` by hand),
  Windows npm (`npm i -g @qialike/cli@latest`, quit qialike first), Windows manual zip
  (`upgrade --check`, then swap the `.exe`), and a source build (`git pull`, rebuild) — followed by why
  Windows has no automatic update and the `qialike-update.auto` switches.
- **`qialike upgrade` recognises an npm install.** On Windows it printed "download the release and
  replace the file by hand" with two `.zip` links for every copy — including one npm had installed,
  whose layout (`%APPDATA%\npm\node_modules\@qialike\…`) has no release `.zip` in it to swap, and
  whose actual route (`npm i -g @qialike/cli@latest`) went unmentioned. Both `upgrade` and
  `upgrade --check` now use the same probe as `uninstall` — the launcher's `QIALIKE_INSTALLED_VIA`, or
  the executable's own `node_modules/@qialike/…` path — and name the install command for that copy
  while leaving the download links for the hand-unpacked ones.
- **The npm install updates itself on Windows.** Windows was detect-only for every layout, because the
  shell installer is bash and a running `.exe` cannot be replaced — which left the npm channel's users
  (Windows is the only platform it serves) unable to ever be updated automatically. An npm copy is
  npm's own to replace, so it now takes the usual rule there: a **patch is installed silently** by
  `npm install -g @qialike/cli@<exact version>`, while a minor or major release is announced, exactly as
  on Linux and macOS. The running session keeps the old build and the new one takes effect on the next
  launch. `qialike-update.auto` still governs it (`"notify"` makes even patches announce-only), a
  hand-unpacked copy on the same platform is unaffected, and an npm that refuses (locked payload,
  read-only prefix) is reported with npm's own words instead of being swallowed. The install method
  gained a third value — `curl` / `npm` / `unknown` — because that, not the platform, is what decides.
- **`qialike uninstall` also names the npm removal command.** The Windows npm channel puts the program
  *outside* the harness home (npm's global prefix), so `uninstall` cannot remove it — yet the run used
  to clear the state and stop, looking finished while ~130 MB and a `qialike.cmd` shim stayed behind.
  It now reports the layout and prints `npm uninstall -g @qialike/cli`, detected either from the npm
  launcher (which sets `QIALIKE_INSTALLED_VIA` when it spawns the binary) or from the executable's own
  `node_modules/@qialike/…` path when the nested binary is run directly. `uninstall --help` documents
  the two-step removal too.

## [0.8.2] - 2026-09-27

### Changed

- **`qialike uninstall` keeps the install directory.** It clears the rest of the harness home
  (`$DSH_HOME`, default `~/.dsh`) and leaves `<home>/bin` in place, because that is where the program
  itself lives — and on Windows a running executable cannot be deleted. To remove qialike completely,
  delete that directory by hand: every run prints the exact command for your platform (`rm -rf …` on
  Unix, `Remove-Item -Recurse -Force …` on Windows). The PATH line it added is still removed.
- **The pre-rename `dsh-tui` compatibility layer was removed.** State files, settings namespaces,
  `DSH_TUI_*` environment variables and old plugin specifiers are no longer migrated or read.

## [0.8.1] - 2026-09-26

### Changed

- **A Windows npm channel: `npm i -g @qialike/cli`.** Windows Terminal has no `bash`, so the
  `curl … | bash` installer cannot run there and installing meant downloading a zip, unpacking it into
  `%USERPROFILE%\.dsh\bin\`, editing PATH and reopening the terminal. The channel is three packages:
  `@qialike/cli` (a few KB — the `bin` launcher plus one `optionalDependencies` entry per Windows
  target) and `@qialike/cli-win32-x64` / `@qialike/cli-win32-arm64` (one `qialike.exe` each, gated by
  `os`/`cpu` so npm fetches only the payload matching the machine, never both). **Windows only, by
  design** — Linux and macOS keep the shell installer. First published **2026-09-30**; the binaries
  inside are the released `qialike-windows-*.zip` assets byte for byte. Republishing is
  `scripts/release/publish-npm.sh`, or `.github/workflows/publish-npm.yml` once every package has a
  trusted publisher registered (OIDC — no long-lived token).
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

- **Two hosts can no longer append one session log at once.** The build replaced the harness's file
  lock (`@deepseek-ai/node-addon-system/flock`) with a no-op stub, copying the harness's
  single-process browser worker — but a qialike host shares `~/.dsh/sessions` with `dsh web` and with
  a second qialike, so the write lease excluded nobody. Two hosts could hold write handles on one
  session and interleave appends, leaving duplicate/rewound `seq` numbers and torn zstd frames — a
  session that then refused to open (`seq gap … released v2 row …`). The stub is now a real
  non-blocking `flock(2)` (via `bun:ffi`, falling back to the harness's native addon) with the
  harness's exact contract. Readers were never blocked and still are not.
- **Deleting a session another process is writing is refused.** `/sessions` probes the lease
  read-only first and reports "being written by another process (the web UI or another qialike)"
  instead of removing a directory a live writer keeps appending to.
- **"Already owned" now reads as an instruction.** Resume and the status bar say the session is open
  for writing elsewhere and to close that holder, instead of echoing the raw harness error.
- **`qialike web` refuses a session store a newer harness has migrated.** Each format generation is a
  new immutable `session.vN` file and the old one is never deleted, so the check names the offending
  file up front rather than failing every history read.
- **The first publish of a release no longer deadlocks.** `push-qialike-release.sh` decided "release
  exists" from a non-empty response body, so a `404 Not Found` body read as "already there" and the
  upload never started; it now decides by HTTP status and checks the token and repository first.
  (Committed after `v0.7.1`, so it first ships here.)

### Changed

- **The sidebar footer no longer prints the embedded harness version.** It shows just
  `qialike: <version>` and the workspace path, in the same two bottom rows as before (the harness
  version still gates plugin trust and stays in the notices/docs). The reserved footer rows shrank
  from three to two, so the sidebar also draws in a terminal one row shorter.
- **A default all-target build is testable again.** `tests/smoke.mjs` hardcoded `dist/qialike`, which
  `BUILD_TARGETS=ALL` never creates (it writes `dist/<os>-<arch>/qialike`), so the boot smoke failed on
  every release build; it now resolves `$QIALIKE_BIN`, then `dist/qialike`, then the host target.
- **Release testing is split in two, and both halves are scripted.** What must run before a release now
  lives in the repository (`scripts/release/test-required.sh`: preconditions, `tsc`, `bun test`, version
  identity, boot smoke); the real-machine/PTY suite stays outside it (`~/deepseek/test/full-suite.sh`,
  optional, ~11 min, zero tokens). The interactive release menu moved to the workbench root
  (`~/deepseek/release-menu.sh`) and follows the release order in the notes.

## [0.7.1] - 2026-09-23

### Added

- **The installer verifies what it downloads.** Every release now ships a `sha256sums.txt` beside
  the six binaries, and `curl … | bash` checks the archive against it. A digest that does not match
  is refused outright; a host that cannot produce a usable manifest is passed over for the next
  one, and when none can, the install stops and says so rather than unpacking unverified bytes.

### Fixed

- **The check was written but never ran.** A missing `sha256sums.txt`, and a manifest that did not
  list the asset, were both treated as "nothing to verify" — which is why it went unnoticed: no
  release had ever published one. Releases older than this version have no manifest, so installing
  from one is now refused; `QIALIKE_ALLOW_UNVERIFIED=1` overrides that on purpose.

### Changed

- The release scripts now live in this repository under `scripts/release/` — including a new
  `push-qialike-release.sh` that uploads a release to both hosts and syncs the tag it points at —
  so what an official release does can be read rather than guessed. A release build packages all
  six targets by default and writes `dist/sha256sums.txt` for that script to upload.

## [0.7.0] - 2026-09-23

### Changed

- **Rebuilt on DeepSeek Harness `0.1.7-alpha.2`**, up from `0.1.5-rc.2` — 3,148 upstream commits. The
  embedded version is what the sidebar reports, so you can always see which harness a binary carries.
- **Settings moved into `qialike.json`.** Harness 0.1.7 removed runtime settings namespaces, so
  qialike's own sections (providers, theme, update, …) had to move somewhere. A one-time migration
  runs at startup: it reads the old spellings, **never overwrites a value you already have**, and
  writes its marker only after it succeeds — a missing or malformed file leaves your data alone and
  is retried next launch. The file is written `0600`.

### Fixed

- **The plugin trust gate is fatal again.** 0.1.7 downgraded the failure of *optional* startup entries
  to a warning, which quietly turned the trust check into advisory: a plugin whose trust was rejected
  no longer stopped the process. Every plugin referenced by your overlays is now re-checked before
  boot, and a rejection fails loudly with the reason.
- **An unreadable, unrelated session log no longer kills a resume.** Resuming session *A* used to be
  aborted when some other session's log could not be read. qialike now recognises that case, keeps
  the read-only view, names the file it could not read, and leaves the session you asked for intact.
  The log you actually asked to resume is still fatal to open — that distinction is deliberate.
- Recovered and torn session files are tolerated the way 0.1.7 tolerates them, instead of aborting
  startup.

## [0.6.4] - 2026-09-23

### Added

- **Drag to select and copy text inside dialogs** — the question box (which also carries plan review),
  the approval box, the command palette and the `@file` completion popup. Drag selects, releasing
  copies. Clicking behaves exactly as before. The selection is taken from the **frame buffer**, so
  what lands on your clipboard is the text inside the box and never the conversation rendered behind
  it. The three *full-screen* panels (`/models`, `/theme`, `/sessions`) deliberately do not do this —
  they are opaque, there is nothing behind them to mis-copy.

### Fixed

- **Copying dropped every line drawn in reverse video** — selected rows in a dialog, the hovered tool
  row, highlighted palette entries. Taking the text and applying the highlight are now decided
  separately, so the text comes through and only the styling is conditional.

## [0.6.3] - 2026-09-22

### Changed

- The line under the brand mark on the hero screen now reads `Ver: <version> <channel> . URL:
  <site>`, so a binary states its own version and build channel (`beta` / `dev`; omitted for a
  production build) without you having to run `--version`.

### Fixed

- **`curl … | bash` aborted on macOS.** macOS ships bash 3.2, where an empty array expanded as
  `"${arr[@]}"` is treated as an unbound variable under `set -u` — and the array in question is empty
  precisely on the *success* path, so the installer failed when everything worked. Every array
  expansion in the shipped script is now guarded, with a static check that fails if a bare one
  reappears.

### Documentation

- Both READMEs were rewritten around what a user actually does, and a matching `CONTRIBUTING` was
  added in both languages.

## [0.6.2] - 2026-09-21

### Added

- **Windows: detect-only update notices.** Windows cannot replace a running `.exe` and has no bash
  for the installer, so self-update is not implemented there — instead of failing silently it now
  says so: an update notice appears in the hero or the status bar, and `/upgrade` prints both
  download links. The verified Linux and macOS paths are untouched.
- **The installer picks a release source by measuring it.** Reachability and throughput are not the
  same thing: GitHub answers a redirect from one host while the body comes from a CDN that may be
  throttled, so a "reachable" source can still crawl. With more than one source the installer now
  samples the real asset and downloads from the fastest. `--source github|gitcode|auto` pins the
  choice.
- **Source choice is four cases, in order**: only GitHub reachable → GitHub; only gitcode reachable →
  gitcode; both reachable → measure; neither → stop and **keep the installed version** (exit code 3,
  not an error). A source that answers but has not published the asset is still a failure — that is
  not a network problem and is not reported as one.

### Fixed

- **An older tag is never treated as an update.** Only `installed == latest` used to short-circuit;
  anything else was classified by major/minor alone, so a source reporting an *older* version could
  silently overwrite a newer install. Mirrors lag by nature, which makes that pairing routine — this
  guard is what makes the mirror safe rather than an optional extra.
- **Windows picked the mirror even when GitHub worked.** The probe used `-o /dev/null`, which
  Windows' curl does not map to a null device (it exits 23 trying to create `D:\dev\null`), so the
  GitHub result was discarded every time.

## [0.6.1] - 2026-09-21

### Added

- **Mirror fallback: gitcode is used when GitHub is unreachable.** A single source meant "GitHub is
  blocked" equalled "cannot install", which is the first failure a lot of users hit. The installer
  and the updater now walk a source list, first one to answer wins, and the version and the download
  come from the same host. Blocking is not the only failure mode covered: a host that connects but
  transfers nothing is given up on too, because reachability alone would never trigger the fallback
  in the exact case it exists for.
- **End-to-end tests for the installer and the upgrade chain**, driven against a real local release
  host, so the paths users depend on are exercised rather than assumed.

### Fixed

- **The updater's version lookup ignored its injected environment**, so a caller that pointed it at
  one release host got the answer from another.
- Pinning a source with `--base-url` / `QIALIKE_INSTALL_BASE_URL` stays a single source with no
  fallback, so a private mirror or a test fixture is never silently papered over by a public one.

## [0.6.0] - 2026-09-20

### Changed

- **The installer became a networked downloader**: `curl -fsSL https://qialike.com/install | bash`
  fetches the released binary for your platform instead of placing a local build, and installs to
  `~/.dsh/bin`.
- **Six published targets** — Linux, macOS and Windows, x64 and arm64 each. Windows installs as
  `qialike.exe`; the archive is a `.zip` there and on macOS, and needs `unzip`.
- A minor bump on purpose: this is the release that changed how qialike is delivered.

### Added

- **Automatic updates.** `qialike upgrade` updates from the command line and `/upgrade` from inside
  the TUI, with a background check shortly after launch. A minor release only announces itself;
  patches install silently. `QIALIKE_DISABLE_AUTOUPDATE=1` turns the whole thing off, and a failed
  automatic update never interrupts your session.
