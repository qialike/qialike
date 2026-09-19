# qialike — an Ink/React terminal surface for DeepSeek Harness

> **Document scope:** This document is a **user manual** and mainly describes **how to use qialike**.

`qialike` is a full-screen terminal TUI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
an interactive single-agent session with live token streaming, driven through the harness's own
Cordis plugin extension points. The DeepSeek Harness core is **not modified**; this repo is a new
bundle (`qialike-app`) plus a Bun-compiled single-file launcher.

## What it is

- A Cordis **bundle** (`@yourname/qialike-app`): a `cordis.patch.yml` layer over `dsh-base` plus a
  runtime glue plugin that creates one `Agent`, streams its `session/event`s into an Ink
  transcript, and drives user input back via `agent.followup()` / `agent.steer()`.
- A **single-file binary** (`dist/qialike`) produced by `bun build --compile`, which bundles the
  whole harness + the TUI bundle. Everything the composition references by name is resolved from
  bundled `lib/` outputs, so a single file boots the full tree with no runtime `node_modules`.

## Requirements

- Node.js `^22.19 || >=24` (for `pnpm` build tooling)
- bun (for `bun build --compile` in `pnpm build` and `bun test` in `pnpm test:unit`; version not pinned — install the latest, v1.3.14 is a verified reference)
- A DeepSeek Harness checkout (`DSH_HARNESS`, default `../deepseek-harness`; needed only for `pnpm build` — running the compiled `dist/qialike` needs no checkout)
- `DEEPSEEK_API_KEY` (via the environment, `~/.dsh` settings, or `.env`) when running a real session
- **Memory** (measured 2026-09-14 on `0.4.15-beta`; whole process tree, 12 s
  settle): the compiled single-file executable peaks at ~**250–290 MB** while
  starting the hero and ~**330–345 MB** while loading a very large session, then
  settles at ~**170 MB** (hero) to ~**225 MB** (a long conversation) resident.
  Opening a 30 MB-compressed transcript read-only peaks near **320 MB** and
  settles near **220 MB**. Recommend **≥1 GB** of RAM; 512 MB works but is tight (no swap
  headroom for a giant transcript), and below 512 MB is unsupported. The runtime
  is Bun/JSC, which does not return freed pages eagerly, so RSS creeps up with
  use and then plateaus — this is GC policy, not a leak (verified: with
  `BUN_JSC_collectContinuously=1` RSS goes *down* during the same workload). On a
  memory-constrained box that flag is the supported mitigation, at the cost of
  more frequent GC.
- **Linux sandbox**: the confined `bash` rung runs through the harness's `bwrap` → Landlock chain.
  qialike now carries **both** rungs. Linux first tries `bwrap` (**bubblewrap**) when the host has it;
  when it does not — or when it cannot create a namespace — the chain falls to **Landlock**, which
  qialike implements itself over `bun:ffi` and re-executes as a subcommand of this binary
  (`--ro` / `--rw` / `--probe`). Landlock needs no host install, no `setuid`, and no user namespace,
  only a kernel with the LSM enabled (≥5.13), so a Linux host normally gets a kernel-enforced write
  boundary out of the box. An older kernel ABI is reported honestly as partial enforcement rather
  than overstated. Only when neither rung can enforce does a `workspace-write` / `read-only` bash
  call fail closed (`SANDBOX_UNAVAILABLE`) and only `danger-full-access` run. macOS uses the built-in
  Seatbelt; Windows uses the harness's ACL restricted-token runner, bundled for real (see below).
- **Secrets read guard**: tool reads of `.env`-family files, `.git` internals, and the harness
  credential document are refused, in every sandbox mode. This is a confidentiality rule, not a
  file-effect boundary, so `danger-full-access` does not lift it and no `sandbox_permissions`
  escalation applies. `.env.example` stays readable. The guard fences the read **tools**; a shell
  command that names a secret file is not intercepted, because inferring paths from shell text is
  unsound — the same gap Gemini CLI has, and it is documented rather than approximated.
- **Windows shell sandbox**: `pwsh` runs under the harness's ACL **restricted-token** runner, which
  grants write access through a per-workspace capability SID and refuses everything else. It needs no
  elevation and no account provisioning; reads, network, and process visibility are unaffected, and
  the runner reports `partial` enforcement honestly. Two things had to be supplied for that rung to
  work from one file: its native `koffi` dependency (`apps/tui-bin/stub/koffi.js`) and **the runner
  process itself**, which the harness locates by module specifier — a call a compiled binary cannot
  answer — so qialike bundles the harness's own runner and serves as its launcher, exactly as it does
  for Landlock on Linux. A host whose executor still reports no confinement keeps the per-call shell
  **approval gate** as the fallback: the gate is driven by the mounted executor's own capability
  fact, and the prompt says plainly that the command has your full user authority.
- **Workspace `delete` and `move` tools**: the harness filesystem seam publishes only two
  mutations (`writeText`, `editText`), so qialike adds the two it lacks — deleting and renaming.
  They are fenced to the **workspace root alone** (not the harness's `writableRoots()` temp grants,
  which exist for mkstemp-style writes and have no matching delete need), they refuse the workspace
  root itself, both ends of a `move` are checked, `read-only` refuses, and `danger-full-access`
  delegates. They exist because the shell is a heavier or unavailable path on some hosts: Windows
  launches a confined process per call, and a Linux host with neither `bwrap` nor Landlock fails
  shell calls closed. `mkdir` needs no tool — `writeText` already creates parent directories.
- **`glob` and `grep` work**: both search through the packaged ripgrep, which the harness reaches by
  module specifier (`@vscode/ripgrep-<platform>-<arch>/bin/rg`) — a lookup a single-file build bundles
  the JavaScript for but not the 5 MB executable, so every call used to fail at launch with
  `ripgrep launch failed`. The artifact now **carries its own ripgrep** for the platform it was built
  for: the build embeds the executable and points the tool's lookup at it, materializing the bytes on
  first search (see `packages/qialike-app/src/ripgrep-shim.ts`).

### Terminal colour depth

qialike paints hex colours through Ink/chalk, and chalk decides how many colours
your terminal can show from the environment. **GNOME Terminal/VTE on Ubuntu 24.04
is 24-bit capable but exports no `COLORTERM`**, so chalk falls back to 256 colours;
qialike therefore maps the palette itself at that depth (keeping the page, the
raised panels and the composer card on distinct colours — without that mapping,
five of the built-in schemes painted the card the same colour as the page). If
your terminal really is 24-bit and you want the exact hexes:

```sh
export COLORTERM=truecolor      # the standard signal, understood by every tool
# or, per run:
QIALIKE_COLOR=24bit qialike
```

`QIALIKE_COLOR` also accepts `256` and `16` (useful to preview how a
lower-colour terminal renders a scheme). At **16 colours** the card and the page
are both black on a dark scheme — the palette has no second near-black to offer,
so that mode is degraded by design; see
`qialike-color-depth-fix-design.md` in the workspace for the measurements.

### Frame repaints (cursor + synchronized output)

Every frame **hides the hardware cursor for the paint** and ends with a suffix that
restores the caret's shape and position, so the cursor is never dragged (visible)
across the rows a repaint touches. Each frame is also bracketed by the terminal's
**synchronized output** mode (`ESC[?2026h` … `ESC[?2026l`). A frame is a full-width
repaint — opening the command palette measures ~5.5 KB at 120×30 and ~7.4 KB at
240×30 — and a pty hands writes larger than its ~4095-byte line-discipline buffer
to the terminal in instalments, so without the mode a half-painted frame is
briefly visible (the composer card's chrome showing through the popup). Terminals
that do not know the mode ignore it; if one mishandles it, `QIALIKE_NO_SYNC=1`
writes plain frames.

## Build

```sh
pnpm install
pnpm build        # dist/qialike  (single-file executable)
pnpm test         # boots the composed tree and parses the TUI command (keyless smoke)
pnpm typecheck
```

`build.mjs` reads `DSH_HARNESS` (defaults to `../deepseek-harness`), copies the built `lib/` of
every referenced `@deepseek-ai/*` package into `apps/tui-bin/x/`, inlines the handful of
`createRequire(import.meta.url)("../package.json")` version reads and Ink's `yoga.wasm`, mirrors
third-party deps from the harness pnpm store, then `bun build --compile`s `apps/tui-bin/src/bin.ts`.

## Run

```sh
dist/qialike                              # start a NEW session on the hero screen (never auto-resumes)
dist/qialike resume                       # continue the newest session in this directory
dist/qialike --workspace ~/proj           # operate in ~/proj (its own sessions)
dist/qialike --resume <sessionId>         # resume a specific persisted session
dist/qialike --model deepseek-flash       # pick a model (DeepSeek V4.1 Flash)
dist/qialike --help
```

A bare `qialike` starts a **new session** and shows the hero screen — it never
auto-resumes. `qialike resume` continues the most recently used session **in the
same directory** (last-activity first) and lands directly in the conversation
view; when no session in that directory has content yet it still opens the session
view rather than the hero. Resuming a session or messaging it marks it
most-recently-used, and the status line marks the resume `(resumed)`. An explicit
`--resume <sessionId>` always wins. Auto-resume on **every** launch is opt-in: set
`resume_last: true` in `~/.dsh/qialike.json` (or `QIALIKE_RESUME_LAST=1`) — the
default is `false`, i.e. every launch starts fresh.

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
- **`/models`**: manage models and the API key, like the web Models page. It opens a
  full-screen dialog with **two levels**: the first level groups
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
  conventional spelling). qialike also bundles a models.dev-style **effort
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
  (`Model: DeepSeek · DeepSeek V4 Flash · Max`). The picker shows only providers whose
  API key is set; on the first level press **`Ctrl+D`** (or **`Alt+D`**) to
  deactivate the highlighted provider — it removes the provider's API key AND
  drops it from the /models list (the hidden list persists in `qialike.json`
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
  `qialike-opencode: { enabled: false }` in the config to unload them entirely
  (templates AND already-configured routes leave the /models dialog and the
  adapter; enabled by default); **the China gateways Qiniu (`qiniu-ai`) and
  SiliconFlow (`siliconflow` / `siliconflow-cn`) are provided by the loadable
  `tui-china-gateways` sub-plugin** (`qialike-china-gateways.enabled: false`
  unloads them); **the international model gateways / hosting platforms —
  OpenRouter, Vercel AI Gateway, Cloudflare (AI Gateway + Workers AI),
  Hugging Face, Baseten, Fireworks AI, Together AI, Nvidia, Groq, Cerebras —
  are provided by the loadable `tui-foreign-gateways` sub-plugin**
  (`qialike-foreign-gateways.enabled: false` unloads them); the official DeepSeek
  endpoint is not in the catalog — the built-in `deepseek-official` default
  route serves it (3 models, ready out of the box); OpenCode Zen / Go are the
  opencode team's OpenAI-compatible model gateways — keys from opencode.ai/auth
  (Zen pay-per-use, Go US$10/mo), set a key to activate) — plus routes declared
  in the `qialike-llm:` settings
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
  `qialike-llm` settings section and hot-registers the route, so its models
  appear in the picker). The list scrolls to keep the highlight in view.
  Color schemes (vim-style `:colorscheme`): bare `/theme` opens a theme
  **picker dialog**: ↑/↓ to move, type to filter,
  **live preview** while moving, `Enter` applies + persists, `Esc` cancels and
  restores. Fast paths remain: `/theme dark` (or a unique prefix), and
  `/theme <role> <hex>` overrides. **16 built-ins**: `dark` — the DeepSeek
  Harness web dark design tokens (MIT repo `deepseek-harness`,
  `design-platform.css` `body[data-ds-dark-theme]` alias block) — and
  `light` (Atom's One Light, GitHub
  Inc. MIT — the former `one-light` optional skin, promoted to the default
  light), plus the optional skin `one-dark` (Atom, GitHub Inc. MIT), and 13
  classic skins — catppuccin,
  dracula, everforest, falcon, flexoki, gruvbox, jellybeans, kanagawa,
  nord, panda, rosepine, solarized, solarized-light (12 resolved
  from the upstream projects' official repos — solarized-light is the
  official light side of the same altercation/solarized repo; jellybeans
  mapped from an MIT vim colorscheme;
  the whole set is MIT/permissive — see
  `classic-schemes.ts` and THIRD_PARTY_NOTICES.md) —
  plus user files in `~/.dsh/themes/*.json`; `qialike-theme: { colorscheme:
  light }` persists the
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
  OpenAI-compatible provider into the `qialike-llm` settings section and its key
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
- **`/sessions` session manager**: the one session picker — a full-screen dialog
   listing persisted sessions **of the current working directory only** (same-directory semantics as
   `resume`)
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
 - **`/new` new session**: start a brand-new session in place.
   The current turn is cancelled, a fresh agent is created, and the old agent is disposed — the
   harness persists every session durably, so the previous conversation stays reachable from
   `/sessions` / `--resume`. The current model selection and workspace carry over.
 - **`/export` session export**: bare `/export` opens an **export dialog** (format JSON/Markdown, editable file name, sanitize toggle; `↑/↓` move fields, `←/→` toggle, type the name, `Enter` export); with flags it exports directly: **JSON** (machine-readable) or **Markdown** (human-readable replay): `/export` exports the current session, `/export <sessionId>` a given one, `--markdown` switches format, `--sanitize` redacts content (`[redacted:…]`), `--output <name>` sets a custom file name (extension added; may include subdirectories, e.g. `notes/summary`). Writes `export-<ts>-<id>.(json|md)` into the **workspace root** and shows the path in the status line.
- **`/sidebar` right-panel toggle**: the right-hand **Steps** panel (session id, `Steps X/Y`
  progress and the step checklist, `no plan yet` when the model did not use `todo_write`) shows
  automatically when the terminal is wide enough (≥110 columns). `/sidebar` toggles it — bare
  `/sidebar` cycles `auto → on → off`, `/sidebar on|off|auto` sets a mode directly — and so does a
  **left-click on the Steps title bar**. `auto` follows the width, `on` forces it visible (even in
  narrow windows), `off` hides it (the message column and input box widen as in a narrow window).
  The choice persists in `~/.dsh/qialike.json` (`sidebar_mode`, default `auto`); every geometry —
  message-column/composer width, wrapping, caret cell, mouse clicks, selection guards — follows the
  same visibility rule, so layout and caret never misalign when the panel is shown or hidden.
- **Layout**: a conversation column (transcript + bottom input dock) with the Steps
  panel to its right when visible (auto at ≥110 columns, or forced with `/sidebar`); the old
  Activity panel and `/activity` command were removed long ago.
- **Live run status — the screen never *looks* frozen while the agent works**: while a run is in
  progress the bottom status bar keeps changing — phase and elapsed seconds (`⠙ thinking · 12s · Esc to pause`),
  `answering · Ns` while text streams, the current **tool name** (parallel calls collapse to `name ×n`),
  and `Ns since last event` once the agent stays silent ≥4s. If the render loop itself ever stalls
  (the agent keeps working in the background), a built-in watchdog force-repaints at two levels and
  logs a `[watchdog]` line to `~/.dsh/qialike.log`; pressing any key revives the screen immediately.
  A single message whose rendering throws degrades only that row to a `⚠ row dropped` warning
  (`[row]` log) instead of freezing the whole UI. Settled tool rows are now collapsed **summary cards** (per-tool summaries derived from the
  arguments — `✓ bash · ls -la …`, `✓ todo_write · 3/5` — with ok/error coloring and a `…`
  expand marker): **click the row** or run **`/think`** to
  expand/collapse the detail under these rows together — every Think (reasoning) body plus every
  tool output
  (bounded; the full text stays in the session log, matching the web ToolRow summary+expand
  semantics), and when a model output hits its length ceiling with no body text, the transcript
  explains the stall instead of dropping silently to Idle — send any message to continue, or
  lower the reasoning effort with Ctrl+T to burn less of the per-request budget.
- **User-question dialog (`ask_user_question`) — one card, floating, with tabs**: a single ask
  carrying several questions is answered inside **one card** that pages through them — title
  `Ask question k/N`, one clickable **tab** per question (short header/number; answered `✓`,
  active `[n]`); answering auto-advances, `←/→` (or Tab) revisits, the whole batch submits once
  every question is answered, and Esc cancels the whole ask. When the tabs do not fit the dock
  they **page** (`…` markers + `←/→`). Choosing **Other…** opens an **inline editor directly
  under the option list** (no second dialog); the dialog itself is a **floating window** that
  overlays the message area without compressing the transcript. Questions and options always wrap
  in full — never truncated — and the body scrolls when it overflows.
- **Running tool rows stay alive**: while Bash/Read/Write … is executing, its row animates — a
  spinner glyph and a live `· Ns` elapsed tail (the terminal equivalent of the web running
  sweep); once settled it returns to the static icon row (click to expand the result).

## Plugin architecture ("everything is a plugin")

### Extending it without a rebuild

Two channels take plain data files — no build step, no install step:

- **Skills** — drop a skill bundle at `$DSH_HOME/skills/<name>/SKILL.md` (or a
  project's `.dsh/skills/`, or `~/.agents/skills/`). The harness's filesystem
  provider discovers them; there is nothing to enable.
- **MCP servers** — this build bundles the MCP client rowless, so you mount your
  own servers from a personal overlay at
  `$DSH_HOME/profiles/tui/cordis.patch.yml`:

  ```yaml
  - insert:
      - id: mcp-github
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          serverName: github
          transport: stdio
          command: npx
          args: ['-y', '@modelcontextprotocol/server-github']
  ```

  Once mounted, the server's tools reach the model as `mcp__github__<tool>`.

`qialike plugin` drives those files for you:

```sh
qialike plugin list [--available]   # layers + rows; --available lists every bundled plugin
qialike plugin add-mcp <name> <command> [args...] [--project]
qialike plugin remove-mcp <name> [--project]
```

`--project` targets the repository overlay (`<repo>/.dsh/tui.cordis.patch.yml`)
instead of the personal one. Enabling/disabling needs no command: a row without
`insert` that says `disabled: true` re-configures a built-in row by id.

**The repository overlay is applied automatically at boot, so it has a policy of
its own.** A repository is not you: `git clone <repo> && qialike` must not be able
to run a process or lift your sandbox in silence. Two consequences:

- **Rows that spawn a process need a per-repository decision.** An MCP server row
  starts its `command` when qialike boots, so it is honoured only when that exact
  file is trusted — `qialike plugin trust-overlay` (inside the repository),
  recorded in `<profile>/overlays.trust.json` with its content hash and harness
  version. Any edit to the file re-asks, and `qialike plugin list` shows the
  state. Untrusted, the launch **refuses** and names the fix.
- **Safety-critical rows are refused outright.** Rows that change `sandbox`,
  `sandbox-policy`, `fs-sandbox`, `bash-sandbox`, `pwsh-sandbox`, `approval`,
  `permission` or `fs-observation-policy` (or disable them) belong in *your*
  overlay; a repository never decides your file-effect boundary, and trust does
  not buy them.

When a repository overlay is in play the hero says so (`⚠ repo overlay applied:
…`), and `--no-project-overlay` (or `QIALIKE_NO_PROJECT_OVERLAY=1`) ignores the
layer for one run. `qialike plugin list` prints the layer, the rows that run
processes and the trust state.

The overlays can only mount plugins **bundled** into this binary. To run your own
plugin, install it as an ordinary package inside the profile and trust it:

```sh
# 1. put it where the loader looks (`npm install`/`pnpm` work; a symlink is fine)
#    ~/.dsh/profiles/tui/node_modules/my-plugin/{package.json,index.cjs}
#    module.exports = { name: 'my-plugin', inject: [], apply(ctx) { … } }
# 2. name it from an overlay:  - insert: [{ id: my-plugin, name: 'my-plugin' }]
# 3. review it, then record the decision (hash + harness version)
qialike plugin trust my-plugin
```

The loader enforces three things: the plugin must live **inside**
`<profile>/node_modules` (symlinks are realpath-checked), it must be trusted for
the harness version this binary embeds (an upgrade re-asks), and the plugin's
**own** files must not change afterwards — every edit to them invalidates the
trust. Its `node_modules/` and `.git/` are deliberately outside that hash
(reinstalling a dependency is not tampering), so the hash covers the code you
reviewed, not the dependency tree it pulls in. A local plugin runs
**in this process with full privileges**, which is why trust is explicit,
per-plugin and revocable (`qialike plugin untrust <name>`).

Your overlay is applied **last**, so a row *without* `insert` can also
re-configure a built-in row by its `id` (change a persona, disable a tool). Two
mistakes are rejected with a message — the plugin loader itself ignores both in
silence: an `insert` naming a plugin this build does not bundle, and a row `id`
that matches no built-in row. `qialike --dump-config` prints the composed layers
and which layer contributed each plugin.

The surface is composed of Cordis plugins (like the harness): `tui-startup`
(CLI flags), `tui-llm` (self-hosted provider layer), `tui-models` (provider
enumeration / Add-provider writes), `tui-runtime` (the kernel: store, panel
registry, key dispatch, agent wiring), and feature plugins that register
against the `tui` service — `tui-panel-conversation` (main surface),
`tui-panel-approval`, `tui-panel-question`, `tui-panel-models` (`/models`
dialog), `tui-sessions` (`/sessions` dialog), `tui-export` (`/export` dialog),
`tui-new` (`/new` in-place session switch). Third-party plugins consume
`ctx.get('tui')` (`panels.register`, `commands.register`, `notify`) and
`ctx.get('tuiStore')`; see `packages/qialike-app/src/panels/` for the plugin
contract and an example.

## Install as a command

```sh
bash scripts/install      # copy dist/qialike into ~/.dsh/bin and put ~/.dsh/bin on PATH
# (equivalent: pnpm install:local; from the workspace root: bash qialike/scripts/install)
qialike                  # now runnable from any directory
qialike --help
qialike uninstall        # uninstall from inside the binary: clears the whole harness
                         #   home ($DSH_HOME, default ~/.dsh — config, logs, themes,
                         #   settings.yaml, sessions, profiles, storages, attachments,
                         #   exports, and any local ~/.dsh/bin copy) and removes the
                         #   ~/.local/bin/qialike dev symlink and the PATH export line
                         #   the install script added to ~/.bashrc/~/.zshrc
qialike web [flags]      # serve the DeepSeek Harness browser UI (alias of the installed
                         #   `dsh web` CLI, so the Web surface stays the harness's own):
                         #   needs `dsh` on PATH (`npm install -g @deepseek-ai/dsh`) or
                         #   $QIALIKE_DSH; web flags (--port/--no-open/...) pass through
                         #   (--host 0.0.0.0 is refused by the web profile)
pnpm uninstall:local     # (legacy) remove the ~/.local/bin/qialike symlink of older
                         #   dev installs created by the removed scripts/install.sh
```

The binary embeds DeepSeek Harness at build time, so `qialike` needs no harness checkout, no
`pnpm`, and no `node_modules` at runtime — only an API key for the provider in use
(env / `~/.dsh` settings / `.env`) and a workspace (default `cwd`, or `--workspace`). Session
state, settings, and credentials live under `~/.dsh`.

`qialike web` runs the installed `dsh` CLI, which should be at least the harness version
embedded in this qialike build: both sides write and read the same `~/.dsh/sessions` logs,
and an older `dsh` reader rejects the newer range-compressed `sourceEventSeqs` as corrupt
history (`SessionPersistenceCorruptionError`). It preflights `dsh` first: when the CLI is
missing, or its version differs from the one embedded in this qialike build, a warning prints
the matching install command and (on a version mismatch) the command exits instead of starting
the web server.

`dsh web` binds to `127.0.0.1:3080`, prints one URL carrying a per-run auth token
(`http://127.0.0.1:3080/?token=…`) and opens it in the default browser. Open **that** URL:
without the token the server answers `401 dsh web authentication required; reopen the URL
printed by dsh web.`, and the auth cookie is valid only for the exact authority it was issued
for (`127.0.0.1:3080` and `localhost:3080` are different authorities), so pick one hostname and
stay on it. `--port <n>` moves the port; if the port is already taken, the second server exits
with `EADDRINUSE` while your browser keeps talking to the older one, whose token you do not have.

### Serving the web UI to another machine (headless / remote)

Keep the default loopback binding and tunnel from the machine that has the browser. `--host
0.0.0.0` is **not** available — the web profile refuses it outright (`error: --host 0.0.0.0 is
intentionally not supported yet for safety: it would expose remote code execution to the
network; use 127.0.0.1 instead`):

```sh
# on the headless / terminal-only host (no local browser, so no --open)
qialike web --no-open                  # copy the printed http://127.0.0.1:3080/?token=… URL

# from the machine with the browser
ssh -L 3080:localhost:3080 user@headless-host
# then open the printed URL (`http://127.0.0.1:3080/?token=…`) in the local browser
```

Use `--port <n>` on both sides if 3080 is taken, and only do this on a trusted network / VPN.

### Upgrading from `dsh-tui`

The command was renamed: `dsh-tui` no longer exists — the checkout is `qialike/` and the binary
is `dist/qialike`. Saved state, settings and environment variables are migrated automatically,
but the command NAME is not: a shell profile or script that still says `dsh-tui` fails with
`dsh-tui: command not found`, and a PATH entry pointing at the old checkout resolves nowhere.
`bash scripts/install` warns when it finds a live pre-rename PATH entry and names the file and
line to fix; `grep -n 'dsh-tui' ~/.bashrc ~/.zshrc` finds the rest. Then open a **new**
terminal — `export PATH=…` only reaches shells that read the profile again, so an existing one
keeps the old PATH.

## Install as a plugin bundle

Once the harness is released, `@yourname/qialike-app` can be added to a profile as an out-of-tree
bundle:

```sh
dsh plugin --profile tui add @yourname/qialike-app
dsh --profile tui --workspace ~/proj
```

`dsh plugin add` resolves `@deepseek-ai/*` peer dependencies from the installation's
`profiles/node_modules` fallback; the pre-release harness must be published first.

## Layout

```
packages/qialike-app/   the bundle: cordis.patch.yml + startup/index/invariant plugins
apps/tui-bin/           src/bin.ts (SEA/bun launcher) + build.mjs
examples/cordis.yml     a deploy overlay pinning model + workspace
tests/smoke.mjs          keyless REAL-composition boot smoke
```

`cordis.patch.yml` rides over `dsh-base`; the OS-level sandbox rows are enabled on every platform —
bash runs via `ctx.sandbox.confine()` (bwrap, or qialike's own embedded Landlock launcher, on Linux;
Seatbelt on macOS) and `pwsh` runs via the ACL restricted-token runner on Windows, with
`danger-full-access` executing unconfined. Nothing in that set is stubbed any more: the Windows rung
was blocked by two native-shaped pieces, both now supplied — `koffi`, replaced by the bundled
`bun:ffi` shim, and the runner process, which qialike carries and launches itself (see
`apps/tui-bin/src/windows-acl-shim.ts`). The `permission` presets row is therefore enabled everywhere
too (it refuses to mount over an unconfined executor). The pure-JS `fs-sandbox` fence, the secrets
read guard, and — on a host whose executor applies no kernel confinement — a per-call shell approval
gate are the remaining boundaries.
