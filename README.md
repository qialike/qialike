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
dist/dsh-tui                              # continue the newest session in this directory, or start fresh
dist/dsh-tui --workspace ~/proj           # continue the newest session in ~/proj
dist/dsh-tui --resume <sessionId>         # resume a specific persisted session
dist/dsh-tui --model deepseek-v4-flash    # pick a model
dist/dsh-tui --help
```

On launch dsh-tui **auto-resumes the most recently used session in the same
directory** (last-activity first, `resume_last: true` in `~/.dsh/dsh-tui.json`,
the default), so a relaunch picks up where the last run left off — resuming a
session or messaging it marks it most-recently-used. The status line marks the
resume `(resumed)`. An explicit `--resume <sessionId>` always wins; set
`resume_last: false` (or `DSH_TUI_RESUME_LAST=0`) to always start fresh.

### Surface features

- **Slash command palette**: type `/` to autocomplete. Commands: `/help`, `/models`,
  `/compact`, `/clear`, `/new`, `/sessions`, `/exit`. Use `↑/↓` to move, `Enter` to run, `Esc` to dismiss.
- **`/compact`**: manually compact the current session's older history into a
  summary, via the same harness `compaction` seam the web surface uses. It takes
  no arguments (anything after the command is rejected with
  `Usage: /compact (no arguments)`). On success it reports
  `Compacted N history items (~X tokens).`, `No compactable history yet.` when
  there is nothing to compact, and the harness's classified failure text
  (busy / cancelled / changed / summary / commit / persistence) otherwise.
- **`/plan`**: enter or leave **plan mode** (the harness plan-mode state,
  guidance prompt section, and `exit_plan_mode` review tool come from the
  base bundle). `/plan` (or `/plan <objective>`, which also hands the message
  to the agent) enters plan mode — the agent then plans instead of executing
  until the plan is approved via `exit_plan_mode` or you run `/plan off` to
  leave. Outcomes mirror the harness command (`Plan mode on/off`, `already
  inactive`, `applies from the next step`).
- **`/goal`**: set or view one durable goal for the session, for long-running
  tasks. `/goal` shows the current goal; `/goal <objective>` creates one
  (arming the harness round driver, which then works toward it in automatic
  rounds); `/goal edit <objective>` changes it; `/goal pause`, `/goal resume`
  and `/goal clear` control it. The model marks the goal complete once the
  objective is achieved, which stops further rounds. The goal domain, model
  tools (`get_goal`/`create_goal`/`update_goal`), and round driver come from
  the harness base bundle — this command is the TUI's human command plane.
- **`/models`**: manage models and the API key, like the web Models page. It opens an
  opencode-style full-screen dialog with **two levels**: the first level groups
  providers (one row per provider with its key set, model count on the right —
  e.g. `OpenCode Zen · 63 models`; the current selection is shown on top);
  `↑/↓` moves, `Enter` drills into a provider's **model sub-list** (second
  level), `Esc` backs out. All three lists (level 1, level 2, Add provider)
  have **live type-to-filter** (a bordered `⌕ type to filter` box on top — type
  to narrow, e.g. `gpt` shows only the GPT family), `Backspace` removes a
  character, `Esc` clears the filter first then backs out; lists longer than a
  page support **`PgUp`/`PgDn` (page) and `Home`/`End` (first/last)**;
  picking a model and pressing `Enter` saves — switching the live session on
  the next request and persisting the default
  (`agentDefaultModel.saveSelection`). **Models that support reasoning effort**
  (the built-in DeepSeek V4 Flash / V4 Pro / Vision Exp) first open a third
  **Effort** picker instead: Off / Low / High / Max with a short description
  each (default High; `↑/↓` or a number selects, `Enter` confirms, `Esc` back
  to the model list) — the model choice completes only after an effort is
  confirmed. The chosen effort persists with the selection
  (`agent-default-model.reasoningEffort`) and rides on every request as
  `thinking`/`reasoning_effort` (Off = no thinking, Low/High/Max = increasing
  reasoning budget); the composer label and status line show it, e.g.
  `DeepSeek · DeepSeek V4 Flash · Max`. Providers without declared efforts
  (e.g. OpenCode Zen) skip the step. **Effort sets are fully model-declared and
  provider-specific**: DeepSeek offers Off/Low/High/Max while another gateway
  may declare low/medium/high/xhigh/max — the picker list, the default
  preselection, the Ctrl+T cycle, and the request all follow that model's own
  declaration (each level id rides verbatim as `reasoning_effort`; the
  no-thinking level is flagged in the declaration, with `off` as the
  conventional spelling). dsh-tui also bundles a models.dev-style **effort
  catalog snapshot** (`src/effort-catalog.ts`, vocabulary
  `none/minimal/low/medium/high/xhigh/max`) as a fallback data source: static
  declarations always win, and the catalog only fills in models whose route
  declares `effortWire: 'reasoning-effort'` (endpoint verified to accept the
  field; only the built-in DeepSeek route today) — the picker, cycling, and
  persistence need no changes. From the main window, press
  **`Ctrl+T`** (or **`Alt+T`** when the terminal takes Ctrl+T) to **cycle** the
  current model's reasoning effort through its declared levels (wrapping, e.g.
  Max→Off→Low→High→…; each press persists and applies to later requests);
  the composer's model label shows the effort as a warning-colored chip
  (`Model: DeepSeek · DeepSeek V4 Flash · Max`, like opencode's variant
  badge). The picker shows only providers whose
  API key is set; on the first level press **`Ctrl+D`** (or **`Alt+D`**) to
  deactivate the highlighted provider — it removes the provider's API key AND
  drops it from the /models list (the hidden list persists in `dsh-tui.json`
  `hidden_providers`; an environment-supplied key cannot be deleted, which is
  reported, and the hidden list keeps it off the picker anyway). To re-add,
  pick the provider in the "＋ Add provider" list and set its API key again —
  saving the key clears the hidden flag and the provider reappears. Hiding the
  provider that is currently in use switches the selection to another active
  provider, or shows `not set` when no active provider remains. An "＋ Add
  provider" entry lists **every known provider** —
  the self-hosted adapter's built-in templates plus the loadable gateway
  sub-plugins — 61 catalog entries (OpenAI,
  OpenRouter, Anthropic, Google Gemini, Groq, Mistral, xAI, Z.AI / Zhipu AI,
  OpenCode Zen / OpenCode Go, … — OpenAI-compatible except Anthropic/MiniMax's
  native Messages protocol, plus deployment-configured rows (Vertex AI,
  Databricks and Snowflake Cortex in the catalog; Azure and the Cloudflare rows
  are provided by loadable plugins) flagged `endpoint required`; **OpenCode Zen / Go are
  provided by the loadable `tui-opencode-gateways` sub-plugin** — set
  `dsh-tui-opencode: { enabled: false }` in the config to unload them entirely
  (templates AND already-configured routes leave the /models dialog and the
  adapter; enabled by default); **the China gateways Qiniu (`qiniu-ai`) and
  SiliconFlow (`siliconflow` / `siliconflow-cn`) are provided by the loadable
  `tui-china-gateways` sub-plugin** (`dsh-tui-china-gateways.enabled: false`
  unloads them); **the international model gateways / hosting platforms —
  OpenRouter, Vercel AI Gateway, Cloudflare (AI Gateway + Workers AI),
  Hugging Face, Baseten, Fireworks AI, Together AI, Nvidia, Groq, Cerebras —
  are provided by the loadable `tui-foreign-gateways` sub-plugin**
  (`dsh-tui-foreign-gateways.enabled: false` unloads them); the official DeepSeek
  endpoint is not in the catalog — the built-in `deepseek-official` default
  route serves it (3 models, ready out of the box); OpenCode Zen / Go are the
  opencode team's OpenAI-compatible model gateways — keys from opencode.ai/auth
  (Zen pay-per-use, Go US$10/mo), set a key to activate) — plus routes declared
  in the `dsh-tui-llm:` settings
  section — with its key status (`✓ key set` / `no key`).
  Configured OpenAI-compatible providers show the gateway's **live model list**
  in the picker: the adapter fetches `GET {baseURL}/models` (falling back to the
  template's static catalog on failure/timeout). **OpenCode Zen is a single
  entry listing all 63 models** (DeepSeek/GLM/Kimi/MiniMax/free + Claude/Qwen +
  GPT/Grok/Muse + Gemini); on send, the model's family is routed automatically
  to the right protocol endpoint — `claude-`/`qwen` → Anthropic messages
  (`x-api-key`), `gpt-`/`grok-`/`muse-` → OpenAI Responses (Bearer),
  `gemini-` → Google generateContent (`x-goog-api-key`), everything else →
  chat/completions (Bearer); all four authentications verified against the
  live gateway.
  Picking any one (already-configured included) opens a sub-dialog that sets or
  **replaces** its API key (the key dialog shows "replaces the current key" when
  a key exists); setting a key on a dormant template route activates it on the
  spot (writes the template's profile — endpoint and model catalog — into the
  `dsh-tui-llm` settings section and hot-registers the route, so its models
  appear in the picker). The list scrolls to keep the highlight in view.
  Color schemes (vim-style `:colorscheme`): bare `/theme` opens a theme
  **picker dialog** (opencode-style Themes list): ↑/↓ to move, type to filter,
  **live preview** while moving, `Enter` applies + persists, `Esc` cancels and
  restores. Fast paths remain: `/theme dark` (or a unique prefix), and
  `/theme <role> <hex>` overrides. **12 built-ins**: `dark`/`light` (opencode's
  official pair) plus 10 classic skins — catppuccin, dracula, everforest,
  gruvbox, jellybeans, kanagawa, monokai, nord, rosepine, solarized (9 resolved
  from opencode's bundled theme assets, jellybeans mapped from an MIT vim
  colorscheme; the whole classic set is MIT/permissive — see
  `classic-schemes.ts` and THIRD_PARTY_NOTICES.md) — plus user files in
  `~/.dsh/themes/*.json`; `dsh-tui-theme: { colorscheme: light }` persists the
  choice. The scheme's `bg` is painted full-screen and
  glyph cells are filled by the patched frame writer, so switching recolors the
  whole surface (background + text + borders), not just accents.
  The Add-provider list is sorted A–Z by display name, and the
  `＋ Add provider` entry shows the total number of providers available to add.
  "＋ Add a custom provider"
  opens a sequential form (steps labeled `[ 1 ]`, `[ 2 ]`, …)
  (a provider-template dropdown — any of the 61 catalog entries, or custom —
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
- **`/sessions` session manager**: the one session picker — an opencode-style full-screen dialog
   listing persisted sessions **of the current working directory only** (same-directory semantics as
   the auto-resume default)
   (title / id — no date/time, the day headers carry it) with **live type-to-filter**
   (title/id/cwd), `Enter` resumes the selection, `Ctrl+R` renames the highlighted
   session (local, persists across restarts), `Ctrl+F` pins/unpins it (pinned sessions
   sort to a `📌 Pinned` group on top, also persisted), `Ctrl+D` deletes it (two
   presses confirm; the live session is protected), `Esc` clears the filter then
   closes; lists longer than a page support `PgUp`/`PgDn`/`Home`/`End`, sorted
   **newest first** and grouped by creation day (`Today` / `Yesterday` / date headers). Each row leads with the session's **title — a summary of its first task**
   (e.g. `你是谁 · @9/1/2026, 5:47:18 PM · /home/pipo/temp`): the harness `session-title` service folds
   it from the session's first message (deterministic fallback, optionally polished by the LLM
   title provider), and it persists with the session — including sessions switched away by `/new`.
   The dialog lists historical session records only — starting a brand-new session is `/new`'s job.
   Content-level search is not available in the single-file process (the harness exposes
   session-content search only through its remote client layer, used by the web app).
 - **`/new` new session**: start a brand-new session in place (opencode's "New session" entry).
   The current turn is cancelled, a fresh agent is created, and the old agent is disposed — the
   harness persists every session durably, so the previous conversation stays reachable from
   `/sessions` / `--resume`. The current model selection and workspace carry over.
 - **`/export` session export**: bare `/export` opens an **export dialog** (format JSON/Markdown, editable file name, sanitize toggle; `↑/↓` move fields, `←/→` toggle, type the name, `Enter` export); with flags it exports directly: **JSON** (machine-readable, opencode `export` shape) or **Markdown** (human-readable replay): `/export` exports the current session, `/export <sessionId>` a given one, `--markdown` switches format, `--sanitize` redacts content (`[redacted:…]`), `--output <name>` sets a custom file name (extension added; may include subdirectories, e.g. `notes/summary`). Writes `export-<ts>-<id>.(json|md)` into the **workspace root** and shows the path in the status line.
- **OpenCode-style layout**: a conversation column plus an Activity panel (tool calls/results) and an
  input dock at the bottom.

## Plugin architecture ("everything is a plugin")

The surface is composed of Cordis plugins (like the harness): `tui-startup`
(CLI flags), `tui-llm` (self-hosted provider layer), `tui-models` (provider
enumeration / Add-provider writes), `tui-runtime` (the kernel: store, panel
registry, key dispatch, agent wiring), and feature plugins that register
against the `tui` service — `tui-panel-conversation` (main surface),
`tui-panel-approval`, `tui-panel-question`, `tui-panel-models` (`/models`
dialog), `tui-sessions` (`/sessions` dialog), `tui-export` (`/export` dialog),
`tui-new` (`/new` in-place session switch). Third-party plugins consume
`ctx.get('tui')` (`panels.register`, `commands.register`, `notify`) and
`ctx.get('tuiStore')`; see `packages/dsh-tui-app/src/panels/` for the plugin
contract and an example.

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
