# Contributing

English | [中文](CONTRIBUTING.zh.md)

This repository is a TUI bundle over [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
released under the [MIT](LICENSE) license. **Users do not need to build** — install the released
binary as described in [README.md](README.md) under "Install as a command".

## Build

Prerequisites:

- Node.js `^22.19 || >=24`, plus bun (for the `bun build --compile` package and `pnpm test:unit`)
- A **DeepSeek Harness checkout that is itself built** (run `pnpm install && pnpm build` inside it first)
  — the qialike build reads each package’s built `lib/` and fails without it
- That checkout must fall within `0.1.0-rc.7 .. 0.1.5-rc.2` (the build script reads the git tag and
  rejects anything outside it); point `DSH_HARNESS` at it, default `../deepseek-harness`

```sh
pnpm install
pnpm build        # dist/qialike (single-file executable)
```

## Tests and checks

| Command | What it does |
| --- | --- |
| `pnpm test` | Smoke: boots the real `dsh-base` + `qialike-app` composition tree and parses the TUI command surface — **no API key needed** |
| `pnpm test:unit` | Unit tests (`bun test tests/`) |
| `pnpm typecheck` | Type check |

Interactive token streaming needs a TTY and a provider key, so the smoke test stops at `--help`.
`pnpm typecheck` reports **3 pre-existing** `wrap-ansi` TS7016 errors (missing type declarations); a
non-zero exit is the baseline — only new errors matter.

## Repository layout

```
packages/qialike-app/   the bundle: cordis.patch.yml + startup/index/invariant plugins
apps/tui-bin/           src/bin.ts (SEA/bun launcher) + build.mjs
examples/cordis.yml     a deploy overlay pinning model + workspace
tests/smoke.mjs          keyless REAL-composition boot smoke
```

`cordis.patch.yml` rides over `dsh-base`, and the OS-level sandbox rows are enabled on every platform —
bash runs via `ctx.sandbox.confine()` (bwrap, or qialike's own embedded Landlock launcher, on Linux;
Seatbelt on macOS) and `pwsh` runs via the ACL restricted-token runner on Windows, with
`danger-full-access` executing unconfined. Two native-shaped pieces have to be supplied for the
Windows rung to work inside the single file: its `koffi` dependency (replaced by the bundled
`bun:ffi` shim) and the **runner process itself** — the harness locates it by module specifier, which
a compiled binary cannot answer, so qialike carries the harness's own runner and launches it (see
`apps/tui-bin/src/windows-acl-shim.ts`). The `permission` presets row is therefore enabled
everywhere. User-visible security behavior lives in the README's "安全边界" section.

## Distributing as a plugin bundle

`@yourname/qialike-app` is an out-of-tree Cordis bundle; once published it can be added to a
profile:

```sh
dsh plugin --profile tui add <scope>/qialike-app
dsh --profile tui --workspace ~/proj
```

`dsh plugin add` resolves the `@deepseek-ai/*` peer dependencies through the installation's
`profiles/node_modules` fallback, so the consumer runs against the **installed harness**, not this
checkout.

Three things must be true before a release — **none hold today, and the command 404s**:

- **The package is not published**: `npm view @yourname/qialike-app` returns 404. `@yourname/` is a
  placeholder scope (it also appears in `package.json` as `@yourname/qialike-root` and in
  `LICENSE`), and must be replaced with a real scope before publishing.
- **The peer range excludes prereleases**: every peer dependency declares `^0.1.1`, and under npm's
  semver `^0.1.1` does **not** accept a prerelease — the published harness is `0.1.5-rc.2`, and
  `semver.satisfies("0.1.5-rc.2", "^0.1.1")` is `false`. Either widen the range or wait for a
  non-prerelease harness.
- **The harness itself is already published** (`@deepseek-ai/dsh`, `latest` = `0.1.5-rc.2`), so that
  is no longer a blocker.

## Writing your own plugin

The overlays can only mount plugins **bundled** into this binary. To run your own plugin, install it
as an ordinary package inside the profile and trust it:

```sh
# 1. put it where the loader looks (`npm install`/`pnpm` work; a symlink is fine)
#    ~/.dsh/profiles/tui/node_modules/my-plugin/{package.json,index.cjs}
#    module.exports = { name: 'my-plugin', inject: [], apply(ctx) { … } }
# 2. name it from an overlay:  - insert: [{ id: my-plugin, name: 'my-plugin' }]
# 3. review it, then record the decision (hash + harness version)
qialike plugin trust my-plugin
```

The loader enforces three things: the plugin must live **inside** `<profile>/node_modules` (symlinks
are realpath-checked), it must be trusted for the harness version this binary embeds (an upgrade
re-asks), and the plugin's **own** files must not change afterwards — every edit to them invalidates
the trust. Its `node_modules/` and `.git/` are deliberately outside that hash (reinstalling a
dependency is not tampering), so the hash covers the code you reviewed, not the dependency tree it
pulls in. A local plugin runs **in this process with full privileges**, which is why trust is
explicit, per-plugin and revocable (`qialike plugin untrust <name>`).

Your overlay is applied **last**, so a row *without* `insert` can also re-configure a built-in row by
its `id` (change a persona, disable a tool). Two mistakes are rejected with a message — the plugin
loader itself ignores both in silence: an `insert` naming a plugin this build does not bundle, and a
row `id` that matches no built-in row.

The surface is composed of Cordis plugins (like the harness): `tui-startup` (CLI flags), `tui-llm`
(self-hosted provider layer), `tui-models` (provider enumeration / Add-provider writes), `tui-runtime`
(the kernel: store, panel registry, key dispatch, agent wiring), and feature plugins that register
against the `tui` service — `tui-panel-conversation` (main surface), `tui-panel-approval`,
`tui-panel-question`, `tui-panel-models` (`/models` dialog), `tui-sessions` (`/sessions` dialog),
`tui-export` (`/export` dialog), `tui-new` (`/new` in-place session switch). Third-party plugins plug
in through `ctx.get('tui')` (`panels.register` / `commands.register` / `notify`) and
`ctx.get('tuiStore')`; the plugin contract and examples live in `packages/qialike-app/src/panels/`.

## Commit messages

Conventional Commits: `type(scope): subject`, with `!` after the type or scope for a breaking change (e.g.
`refactor!: rename dsh-tui to qialike`). The repository uses `fix`, `feat` and `chore` most often.
