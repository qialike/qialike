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
everywhere. User-visible security behavior lives in the README's "Security boundaries" section.

## Distributing as a plugin bundle

**This repository does not distribute through npm** — the binary comes from the `curl | bash`
installer and the GitHub/gitcode releases, and never needs npm. The path below is therefore
**not available today**; it is kept only to describe the capability the architecture has, and what
enabling it would take.

`@yourname/qialike-app` is an out-of-tree Cordis bundle; given a registry and scope we control, it
could be added to a profile like this:

```sh
dsh plugin --profile tui add <scope>/qialike-app
dsh --profile tui --workspace ~/proj
```

`dsh plugin add` resolves the `@deepseek-ai/*` peer dependencies through the installation's
`profiles/node_modules` fallback, so the consumer runs against the **installed harness**, not this
checkout.

Enabling that path would first require three things (a record of the current state, not a
to-do list):

- The root package is `private: true`, so `npm publish` refuses outright; all three `package.json` names
  use the `@yourname/` **placeholder scope, which this project does not own** (`@yourname/qialike-root`,
  `@yourname/qialike-app`, `@yourname/qialike-bin`); and `npm view @yourname/qialike-app` returns 404.
- Every peer dependency declares `^0.1.1`, and under npm's semver `^0.1.1` does **not** accept a
  prerelease — the published harness is `0.1.5-rc.2`, and `semver.satisfies("0.1.5-rc.2", "^0.1.1")` is
  `false`.
- The harness itself **is already on npm** (`@deepseek-ai/dsh`, `latest` = `0.1.5-rc.2`) — not an
  obstacle.

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
