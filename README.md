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

- **Slash command palette**: type `/` to autocomplete. Commands: `/help`, `/models`,
  `/compact`, `/clear`, `/resume`, `/exit`. Use `↑/↓` to move, `Enter` to run, `Esc` to dismiss.
- **`/models`**: manage models and the API key, like the web Models page. It opens an
  opencode-style full-screen dialog: pick the model (`↑/↓`; DeepSeek V4 Flash / V4 Pro /
  V4 Flash Vision Exp) and enter the API key (masked; `Enter` saves, `Esc` cancels). Saving
  switches the live session to the new model on the next request and persists the default
  (`agentDefaultModel.saveSelection`); the picker shows only providers whose
  API key is set; an "＋ Add provider" entry lists **every known provider** —
  the self-hosted adapter's built-in templates (DeepSeek, OpenAI, OpenRouter,
  Anthropic, Groq, Mistral, Together, Fireworks, xAI, Cerebras — OpenAI-compatible
  except Anthropic's native Messages protocol) plus routes declared in the
  `dsh-tui-llm:` settings section — with its key status (`✓ key set` / `no key`).
  Picking any one (already-configured included) opens a sub-dialog that sets or
  **replaces** its API key (the key dialog shows "replaces the current key" when
  a key exists); setting a key on a dormant template route activates it on the
  spot (writes the template's profile — endpoint and model catalog — into the
  `dsh-tui-llm` settings section and hot-registers the route, so its models
  appear in the picker). The list scrolls to keep the highlight in view.
  "＋ Add a custom provider"
  opens a sequential form
  (a provider-template dropdown — DeepSeek, OpenAI, OpenRouter, Groq, … or custom —
  pre-filling route/display name/base URL; then route id / display name / base URL /
  API key / model ids) that writes an
  OpenAI-compatible provider into the `dsh-tui-llm` settings section and its key
  into the credentials store, hot-registered by the adapter; keys are stored under
  their provider's reference in `~/.dsh/.credentials.yaml` and resolved per
  request. The key never reaches the transcript/model. (If a key is already in
  the environment it shadows the store and wins.) Models declaring image input
  (e.g. DeepSeek V4 Flash Vision Exp, GPT-4o, Claude) accept images attached to
  the conversation; the adapter encodes them as `image_url` parts (OpenAI) or
  base64 source blocks (Anthropic).
- **Approval dialog**: when a tool requests approval, an in-band prompt appears with the tool name
  and reason. `y`/`a` allow the call once, `n`/`Esc` reject. (Under the no-sandbox profile no tool
  currently asks, so the dialog stays dormant — wired for when a tool requests approval.)
- **`--resume` / `/resume` session picker**: lists persisted sessions and resumes the selected one.
- **OpenCode-style layout**: a conversation column plus an Activity panel (tool calls/results) and an
  input dock at the bottom.

## Install as a command

```sh
bash scripts/install      # copy dist/dsh-tui into ~/.dsh/bin and put ~/.dsh/bin on PATH
# (equivalent: pnpm install:local; from the workspace root: bash dsh-tui/scripts/install)
dsh-tui                  # now runnable from any directory
dsh-tui --help
dsh-tui uninstall        # uninstall the production install from inside the binary:
                         #   removes ~/.dsh/dsh-tui.{log,json} and the PATH entry
                         #   added to ~/.bashrc/~/.zshrc; prompts for manual removal
                         #   of the running ~/.dsh/bin/dsh-tui copy
pnpm uninstall:local     # (legacy) remove the ~/.local/bin/dsh-tui symlink of older
                         #   dev installs created by the removed scripts/install.sh
```

The binary embeds DeepSeek Harness at build time, so `dsh-tui` needs no harness checkout, no
`pnpm`, and no `node_modules` at runtime — only an API key for the provider in use
(env / `~/.dsh` settings / `.env`) and a workspace (default `cwd`, or `--workspace`). Session
state, settings, and credentials live under `~/.dsh`.

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
