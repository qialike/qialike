# Contributing

English | [中文](CONTRIBUTING.zh.md)

This repository is a TUI bundle over [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
released under the [MIT](LICENSE) license. **Users do not need to build** — install the released
binary as described in [README.md](README.md) under "Install as a command".

## Build

Prerequisites:

- Node.js `^22.19 || >=24`, plus bun **`>= 1.4.2`** (for the `bun build --compile` package and
  `pnpm test:unit`). The bun floor is not cosmetic: `--compile` bakes the BUILD HOST's bun runtime
  into every target, and a 1.3.x build produces a Windows binary that ends every turn before the
  first model call — so the build refuses an older bun.
- A **DeepSeek Harness checkout that is itself built** (run `pnpm install && pnpm build` inside it first)
  — the qialike build reads each package’s built `lib/` and fails without it. Point `DSH_HARNESS` at
  it; the default is `../deepseek-harness`.
- That checkout must fall inside the version range the build enforces. **The range's single source of
  truth is `apps/tui-bin/build.mjs`** (`HARNESS_VERSION_MIN` / `HARNESS_VERSION_MAX`) — read it
  there rather than trusting a number written in a document, including this one. CI pins the same
  release in `HARNESS_REF`; when you raise the ceiling, validate against the new release and move
  both together.

### Install and build DeepSeek Harness

```sh
cd yourpath
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout dsh-v0.1.7-rc.2   # the tag must be the version qialike supports
pnpm install
pnpm run build
```

### Install and build qialike

```sh
cd yourpath
git clone https://github.com/qialike/qialike.git
cd qialike
pnpm install
pnpm build        # dist/qialike (single-file executable)
```

> The two checkouts must sit in the **same parent directory** for the default `../deepseek-harness` to
> resolve; otherwise point `DSH_HARNESS` at your harness checkout.

`pnpm build` also creates the resolution farm (`node_modules/@deepseek-ai/*`, plus this repo's own
scope) that the unit suite imports through at runtime. **Run it before `pnpm test:unit`**, or the
tests that import a harness package fail to resolve — not because your change broke them.

## Tests and checks

| Command | What it does |
| --- | --- |
| `pnpm test` | Smoke: boots the real `dsh-base` + `qialike-app` composition tree inside the packaged binary and parses the TUI command surface — **no API key needed**; needs `pnpm build` first |
| `pnpm test:unit` | Unit tests (`bun test tests/`); needs `pnpm build` first (see above) |
| `pnpm typecheck` | Type check |

Interactive token streaming needs a TTY and a provider key, so the smoke test stops at `--help`.
`pnpm typecheck` reports **3 pre-existing** `wrap-ansi` TS7016 errors (missing type declarations); a
non-zero exit is the baseline — only new errors matter.

**CI covers the commands above and nothing more.** The release gate used for official builds also
runs a real-machine pty suite (52 scenarios, ~17 minutes each, driving the packaged binary in a real
terminal against a seeded `$HOME`) plus a documentation audit. **That suite is not part of this
repository today** — it lives in the maintainers' release workspace — so CI cannot run it for you and
a green CI run is not by itself a statement that a release is shippable. Treat the absence of that
suite here as a known gap, not as an invitation to trust CI further than it goes. The pty suite is
also why its absence is not a blocker for your change: nothing in CI depends on it.

The **release scripts are in this repository**, under `scripts/release/` — `build-qialike.sh`
(version bump, build, optional tag and archive), `tag-qialike.sh` (commit and annotated tag),
`release-archive.sh` (source `.tar.gz` / `.zip`) and `push-qialike-release.sh` (upload the six
binaries plus `sha256sums.txt` to the two release hosts). They are what an official release actually
runs, so you can read exactly what a release does and reproduce the packaging. What you cannot
reproduce is the pty suite they gate on.

`push-qialike-release.sh` carries **no credentials** — it reads `GITHUB_TOKEN` / `GITCODE_TOKEN`
from the environment — which is why it is safe to keep here with the rest. Running it is the only
step that needs those tokens, and it is never triggered by a plain build.

## Contributions

- **Licence**: contributions are accepted under the [MIT](LICENSE) licence that covers this
  repository (inbound = outbound). By opening a pull request you confirm you have the right to
  submit the work under those terms; there is no separate CLA to sign.
- **Security**: do **not** open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).
- **Commits**: Conventional Commits (below). Keep a change reviewable on its own; the repository
  history is squashed by topic, not by author.

## Repository layout

```
packages/qialike-app/   the bundle: cordis.patch.yml + startup/index/invariant plugins
apps/tui-bin/           src/bin.ts (SEA/bun launcher) + build.mjs
scripts/release/        the release scripts CI does not run (see "Tests and checks")
packages/qialike-app/repro-*.mjs
                        headless render harnesses for real rendering defects
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

**This repository does not distribute through npm today** — the binary comes from the `curl | bash`
installer and the GitHub/gitcode releases, and never needs npm. The path below is therefore
**not available today**; it is kept to describe the capability the architecture has, and what
enabling it would still take. It is the ecosystem's main discovery channel (plugin markets, the
`awesome-*` catalogues, `dsh plugin add`), so closing it is a distribution decision, not a detail.

`@qialike/qialike-app` is an out-of-tree Cordis bundle; its packages now carry the `@qialike` scope,
so this is what it would look like:

```sh
dsh plugin --profile tui add @qialike/qialike-app
dsh --profile tui --workspace ~/proj
```

`dsh plugin add` resolves the `@deepseek-ai/*` peer dependencies through the installation's
`profiles/node_modules` fallback, so the consumer runs against the **installed harness**, not this
checkout.

What still stands between the tree and that command (a record of the current state, not a to-do
list):

- **The scope must actually be controlled on the registry.** The three `package.json` names are
  `@qialike/qialike-root`, `@qialike/qialike-app` and `@qialike/qialike-bin`; publishing only works
  if the `@qialike` npm scope is owned by this project, and `npm view @qialike/qialike-app` must
  stop returning 404.
- **The root package is `private: true`**, so `npm publish` refuses outright at the root. That is
  correct — only `packages/qialike-app` is a publishable bundle — but it means the publish must run
  from that directory (or with a `--filter`), never from the root.
- **Every peer dependency declares `^0.1.1`, and under npm's semver `^0.1.1` does NOT accept a
  prerelease.** The harness the build targets is a prerelease, so `semver.satisfies(<that
  version>, "^0.1.1")` is `false`; a consumer installing the bundle would have its peers reported as
  unsatisfied. Fixing this means either widening the declared ranges to the actual prerelease
  versions or moving to caret ranges over released versions once the harness leaves prerelease.
- The harness itself **is already on npm** (`@deepseek-ai/dsh`) — not an obstacle.

> **Do not confuse this with the binary npm channel.** The list above is about publishing the
> **TUI bundle as a dsh plugin** (`@qialike/qialike-app`, consumed with `dsh plugin add`). A
> separate, unrelated channel ships the **Windows binary** to npm so Windows users — who have no
> `bash` and therefore cannot run the `curl | bash` installer — can `npm i -g qialike`. Its
> packages are `qialike` (a few kB of launcher) plus `qialike-win32-x64` / `qialike-win32-arm64`
> (one `qialike.exe` each); the templates live in `packages/npm/` and the publish script is
> `scripts/release/publish-npm.sh`. Both channels follow the same `package.json` version, and
> neither depends on the other to publish.

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
