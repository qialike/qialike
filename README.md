# dsh-tui — an Ink/React terminal surface for DeepSeek Harness

`dsh-tui` is a full-screen terminal TUI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
an interactive single-agent session with live token streaming, driven through the harness's own
Cordis plugin extension points. The DeepSeek Harness core is **not modified**; this repo is a new
bundle (`dsh-tui-app`) plus a Bun-compiled single-file launcher.

## What it is

- A Cordis **bundle** (`@yourname/dsh-tui-app`): a `cordis.patch.yml` layer over `dsh-base` plus a
  runtime glue plugin that creates one `Agent`, streams its `session/event`s into an Ink
  transcript, and drives user input back via `agent.followup()` / `agent.steer()`.
- A **single-file binary** (`dist/dsh-tui`) produced by `bun build --compile`, which bundles the
  whole harness + the TUI bundle. Everything the composition references by name is resolved from
  bundled `lib/` outputs, so a single file boots the full tree with no runtime `node_modules`.

## Requirements

- Node.js `^22.19 || >=24` (for `pnpm` build tooling)
- A DeepSeek Harness checkout (`DSH_HARNESS`, default `../deepseek-harness`)
- `DEEPSEEK_API_KEY` (via the environment, `~/.dsh` settings, or `.env`) when running a real session

## Build

```sh
pnpm install
pnpm build        # dist/dsh-tui  (single-file executable)
pnpm test         # boots the composed tree and parses the TUI command (keyless smoke)
pnpm typecheck
```

`build.mjs` reads `DSH_HARNESS` (defaults to `../deepseek-harness`), copies the built `lib/` of
every referenced `@deepseek-ai/*` package into `apps/tui-bin/x/`, inlines the handful of
`createRequire(import.meta.url)("../package.json")` version reads and Ink's `yoga.wasm`, mirrors
third-party deps from the harness pnpm store, then `bun build --compile`s `apps/tui-bin/src/bin.ts`.

## Run

```sh
dist/dsh-tui                              # fresh session in the current directory
dist/dsh-tui --workspace ~/proj           # operate in ~/proj
dist/dsh-tui --resume <sessionId>         # resume a persisted session
dist/dsh-tui --model deepseek-v4-flash    # pick a model
dist/dsh-tui --help
```

### Surface features

- **Slash command palette**: type `/` to autocomplete. Commands: `/help`, `/connect`, `/model`,
  `/compact`, `/clear`, `/resume`, `/exit`. Use `↑/↓` to move, `Enter` to run, `Esc` to dismiss.
- **`/connect`**: set the DeepSeek API key after launch, exactly like the web Models page. It opens
  a masked prompt (paste a single line key + `Enter`), stores it under the `DEEPSEEK_API_KEY`
  reference in `~/.dsh/.credentials.yaml` via the credentials service, and the next model turn picks
  it up (the key is resolved per request). The key never reaches the transcript/model. (If
  `DEEPSEEK_API_KEY` is already in the environment it shadows the store and wins.)
- **Approval dialog**: when a tool requests approval, an in-band prompt appears with the tool name
  and reason. `y`/`a` allow the call once, `n`/`Esc` reject. (Under the no-sandbox profile no tool
  currently asks, so the dialog stays dormant — wired for when a tool requests approval.)
- **`--resume` / `/resume` session picker**: lists persisted sessions and resumes the selected one.
- **OpenCode-style layout**: a conversation column plus an Activity panel (tool calls/results) and an
  input dock at the bottom.

## Install as a command

```sh
pnpm install:local       # builds dist/dsh-tui and symlinks it into ~/.local/bin
# (if `~/.local/bin` is not on PATH, the installer prints the export line; it is
#  appended to ~/.bashrc automatically when you run `pnpm install:local`)
dsh-tui                  # now runnable from any directory
dsh-tui --help
pnpm uninstall:local     # remove the ~/.local/bin/dsh-tui symlink
```

The binary embeds DeepSeek Harness at build time, so `dsh-tui` needs no harness checkout, no
`pnpm`, and no `node_modules` at runtime — only `DEEPSEEK_API_KEY` (env / `~/.dsh` settings /
`.env`) and a workspace (default `cwd`, or `--workspace`). Session state, settings, and credentials
live under `~/.dsh`.

## Install as a plugin bundle

Once the harness is released, `@yourname/dsh-tui-app` can be added to a profile as an out-of-tree
bundle:

```sh
dsh plugin --profile tui add @yourname/dsh-tui-app
dsh --profile tui --workspace ~/proj
```

`dsh plugin add` resolves `@deepseek-ai/*` peer dependencies from the installation's
`profiles/node_modules` fallback; the pre-release harness must be published first.

## Layout

```
packages/dsh-tui-app/   the bundle: cordis.patch.yml + startup/index/invariant plugins
apps/tui-bin/           src/bin.ts (SEA/bun launcher) + build.mjs
examples/cordis.yml     a deploy overlay pinning model + workspace
tests/smoke.mjs          keyless REAL-composition boot smoke
```

`cordis.patch.yml` rides over `dsh-base` and disables the OS sandbox rows (the single file carries
no native addon), keeping the `workspace-write + ask` approval boundary and the local
`bash`/`fs` providers.
