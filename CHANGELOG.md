# Changelog

Notable changes to qialike, newest first. This file starts at **0.6.0**; the releases before it
(0.1.0 through 0.5.4, 52 versions) are listed on
[GitHub Releases](https://github.com/qialike/qialike/releases) with their tags, and every one of them
is tagged in this repository.

Versioning is [SemVer](https://semver.org/). While the embedded DeepSeek Harness is a developer
preview, a minor bump may carry a breaking change — those are marked `!`.

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
