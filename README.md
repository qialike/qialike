# qialike — an AI coding agent TUI built on DeepSeek Harness

[中文](README.zh.md) | English

```
########  ##    ######  ##        ##  ##    ##  ########
##    ##  ##        ##  ##        ##  ##  ##    ##    ##
##    ##  ##  ########  ##        ##  ####      ########
##    ##  ##  ##    ##  ##        ##  ##  ##    ##
########  ##  ########  ########  ##  ##    ##  ########
      ##
```

> **Document scope:** This document is a **user manual** and mainly describes **how to use
> qialike**.

`qialike` is a coding-agent terminal TUI built on
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Platforms: Linux, macOS, Windows.
Full-screen, session resume, sandboxed execution, single-file binary, any model, plugin-based
design.

## Contents

- [What it is](#what-it-is)
- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Security boundaries](#security-boundaries)
- [Data and responsibility](#data-and-responsibility)
- [Building from source](#building-from-source)
- [Install as a command](#install-as-a-command)
- [Updates](#updates)
- [Running](#running)
- [Plugin architecture ("everything is a plugin")](#plugin-architecture-everything-is-a-plugin)
- [Where files live](#where-files-live)
- [Troubleshooting](#troubleshooting)
- [Issues and contributing](#issues-and-contributing)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## What it is

qialike is a full-screen AI coding agent that runs in your terminal: you launch it inside a project
directory, say what you want in plain language, and it reads code, edits files and runs commands
itself — showing every step and the model's streamed output on one screen.

- **Pick up where you left off**: sessions persist automatically — `qialike resume` continues the
  newest session in this directory, and `/sessions` lists past ones (searchable, renameable,
  pinnable, deletable).
- **Pick your own model**: the built-in DeepSeek official endpoint works with `DEEPSEEK_API_KEY`;
  `/models` → `＋ Add provider` lists **62 providers** — internationally OpenAI, Anthropic, Google
  Gemini, xAI, Mistral, OpenRouter, Groq, Hugging Face; in China Qwen, Zhipu GLM, Kimi, MiniMax,
  Volcengine, SiliconFlow. Selecting one is all it takes (mostly OpenAI-compatible; Anthropic and
  MiniMax speak their native Messages protocol), and `Ctrl+T` cycles the reasoning effort.
- **Everything under `/`**: typing `/` opens the completion palette — `/models`, `/sessions`,
  `/theme`, `/export`, `/plan`, `/goal`, `/compact`, `/sidebar` and more; `↑/↓` to move, `Enter` to run.
- **Also opens in a browser**: `qialike web` starts the Web UI DeepSeek Harness ships — it forwards
  the whole invocation to the installed `dsh` CLI (`dsh web`, the official alias of `dsh --profile
  web`). That surface is the harness's own; qialike does not reimplement it, and the `dsh`
  prerequisite is in "Requirements". Both sides **share one session store**: in the same workspace a
  session opened in the browser continues with `qialike resume`, and qialike's sessions show up in
  the web UI (attached to the matching workspace at launch so they group correctly).
- **Acts within boundaries**: bash / pwsh run inside an OS-level sandbox; `.env`, `.git` internals
  and credential files are never read; where the executor has no kernel confinement, every shell
  call is approved one at a time.
- **Runs once installed**: one single-file executable per platform (Linux / macOS / Windows) — no
  `node_modules` and no harness checkout at runtime.
- **Extends without a rebuild**: drop in a skills directory or mount an MCP server and it takes
  effect — no build, no install.

## Quick start

Three steps. Only the shortest path is here; each step links to its chapter for the full story.

### 1. Install

```sh
curl -fsSL https://qialike.com/install | bash
```

Works on **Linux, macOS, WSL, and Windows through Git Bash / MSYS2 / Cygwin** — x64 and arm64 each,
six published targets in all. It needs `bash` and `curl`; Linux extracts with the system `tar`,
while macOS and Windows use a `.zip` and need `unzip`.

A native Windows terminal (Windows Terminal / PowerShell / cmd) has no bash, so the **install
command** above does not work there — download and unpack by hand and set the environment variable
yourself: see [Windows Terminal](#windows-terminal-powershell--cmd). Note this **affects
installation only**: once installed, `qialike.exe` is a native program and runs in Windows Terminal
or PowerShell as usual.

It installs to `~/.dsh/bin`. The installer appends that directory to your shell profile, but
**this shell has not read it yet** — do what the installer prints (`source ~/.bashrc`, or
`~/.zshrc` on zsh) or simply **open a new terminal**; `qialike` then runs from any directory, and
`qialike --version` confirms it. For flags (pin a version, leave the profile alone, print the plan
only) see "Install as a command".

### 2. Launch qialike

Run it inside your workspace.

```sh
qialike
```

The first launch shows the hero screen; with no model configured yet it prints
`No provider yet — use /models to add one` and the model label reads `not set`. To configure one:

- **Add a provider** (62 of them): type `/models` after launch, pick one under `＋ Add provider`
  and set its API key (configured OpenAI-compatible providers show the gateway's live model list);
  or fill in a custom endpoint under `＋ Add a custom provider`. **You obtain the key from the
  provider itself** (its website or console) — qialike neither requests one for you nor ships any.

Details in "Surface features" and "Provider catalogue and reasoning-effort declarations".

### 3. Start a session

Once a model is configured there is **no need to restart** — type your request in the current
screen and press Enter; the hero gives way to the conversation view and the session begins.

Type `/` at any point to open the command palette (`/models`, `/sessions`, `/theme`, `/export`, …)
and `/exit` to quit. Sessions persist automatically; later, pick a past session with `/sessions` or
continue from the shell with `qialike resume`. See "Running".

## Requirements

- **Platforms**: Linux (including WSL), macOS, Windows; x64 and arm64 each, six published targets.
  **Running** needs only the matching native executable (`qialike.exe` on Windows); only the `curl |
  bash` **install command** needs bash, which on Windows means Git Bash / MSYS2 / Cygwin or WSL.
  Other platforms are unsupported; see "Install as a command".
- **Terminal**: a real TTY — the full-screen surface, streaming output and mouse interaction all
  assume an interactive terminal.
- **No runtime to pre-install**: the artifact is a single executable, so it needs no Node.js, bun,
  `pnpm`, `node_modules`, or a harness checkout.
- **API key**: a real session needs at least one provider's key — the built-in DeepSeek endpoint
  uses `DEEPSEEK_API_KEY` (environment, `~/.dsh` settings or `.env`), and any other provider is set
  in `/models`. Every key is **issued by that provider** (apply on its website or console);
  qialike neither requests one for you nor ships any.
- **Workspace**: the current directory by default (`cwd`), or `--workspace`; session state,
  settings and credentials live in `~/.dsh`.
- **Disk**: the download archive is roughly 45–58 MB (varies by platform) and unpacks to a single
  file of about 96 MB.
- **`qialike web` additionally needs**: a `dsh` CLI on the system (on PATH, or pointed at by
  `$QIALIKE_DSH`) at a version no older than the harness embedded in this build — on a mismatch it
  warns and prints the install command, and on a version difference it does not start the web
  server (see "Browser UI and headless / remote access").
- **Memory**: **≥1 GB** recommended; 512 MB works but is tight (no swap headroom for a giant
  transcript) and below 512 MB is unsupported. RSS creeping up is GC policy rather than a leak;
  `BUN_JSC_collectContinuously=1` is the mitigation when memory is tight.

### Terminal color depth

qialike works this out itself, so there is normally nothing to set. The exception is a **terminal
that is 24-bit capable but does not say so** — Ubuntu 24.04's GNOME Terminal/VTE is a known case (it
exports no `COLORTERM`), so output drops to 256 colors and on a dark scheme the composer card's fill
can merge into the page. At that depth qialike maps the palette itself to keep page, panels and card
distinguishable, but it cannot reach the theme's original hexes. If your terminal really is 24-bit,
two ways to say so:

```sh
export COLORTERM=truecolor      # the standard signal, understood by every tool
# or, for this run only:
QIALIKE_COLOR=24bit qialike
```

`COLORTERM` accepts exactly one value, `truecolor` — writing `24bit` there does nothing (that is
`QIALIKE_COLOR`'s spelling). `QIALIKE_COLOR` also takes `256` and `16`, handy for previewing how a
low-color terminal renders a scheme. At **16 colors** the card and the page are both black on a dark
scheme — the palette has no second near-black to offer, so that mode is **degraded by design**.

## Security boundaries

- **Writes confined, reads open**: the confined `bash` (or `pwsh` on Windows) runs inside an
  OS-level sandbox that constrains **writes only** to the workspace — reads, network and process
  visibility are unaffected. All three platforms get it out of the box: Linux prefers the host's
  bubblewrap and falls back to qialike's own Landlock (requires the LSM enabled in the kernel,
  ≥5.13), macOS uses the system Seatbelt, and Windows uses the harness's ACL
  restricted-token runner.
  `read-only` bash fails closed with `SANDBOX_UNAVAILABLE` (only `danger-full-access` runs);
  where the executor offers no kernel confinement, **per-call shell approval** takes over, and the
  prompt states that the command has your full user authority.
- **Secrets are unreadable**: `.env`-family files, `.git` internals and harness credential
  documents are refused outright (`.env.example` excepted). This holds in every sandbox mode and
  `danger-full-access` does not lift it. **It fences the read tools only**: a shell command that
  names those files still reads them — a gap recorded honestly here, and one Gemini CLI shares.

**A repository overlay is applied automatically at startup, so it gets its own policy.** A
repository is not you: `git clone <repo> && qialike` must not quietly start a process or quietly
loosen your sandbox. Two consequences:

- **Rows that spawn a process need one per-repo decision**: an MCP server row runs its `command` at
  startup, so it takes effect only once **that file** is explicitly trusted — run `qialike plugin
  trust-overlay` inside the repository to record the content hash and harness version in
  `<profile>/overlays.trust.json`; any edit to the file asks again, and `qialike plugin list` shows
  the state. Untrusted, startup **refuses outright** and prints the fix.
- **Security rows are always refused**: rows that change (or disable) `sandbox` / `sandbox-policy` /
  `fs-sandbox` / `bash-sandbox` / `pwsh-sandbox` / `approval` / `permission` /
  `fs-observation-policy` can only be written in **your own** overlay; a repository has no say over
  your file-effect boundary, and trust cannot buy one.

When a repository overlay is active the hero says so (`⚠ repo overlay applied: …`);
`--no-project-overlay` (or `QIALIKE_NO_PROJECT_OVERLAY=1`) ignores that layer for one run; and
`qialike plugin list` prints the layer, the rows that run processes, and the trust state.

## Data and responsibility

What follows are the data flows qialike cannot decide for you but that you should know about.

- **What goes to the model provider you pick**: every request sends the conversation to the provider
  selected in `/models` — your messages, the agent's tool calls, and the **tool results** (the file
  contents the agent read are in there). Since qialike lets you choose among 62 providers, **which
  privacy and retention policy applies depends on who you chose**; qialike cannot make promises on
  their behalf — check the provider you selected.
- **The harness's feedback-gated telemetry**: the composed profile mounts `session-telemetry-otel`
  by default, in `FEEDBACK_ONLY` mode, against
  `https://harness-telemetry.deepseeksvc.com/v1/logs`. Nothing is uploaded by default — only **new
  explicit feedback** releases a bounded session prefix up to that event (which may contain message
  text, tool arguments and results, and workspace paths); ordinary requests, lifecycle events and
  stored feedback trigger nothing. Release is **per provider**: even on a third-party provider, the
  feedback still goes to the DeepSeek endpoint above. To disable:
  `DSH_TELEMETRY_MODE=DISABLED`, or set `DSH_TELEMETRY_DISABLED` to any non-empty value (including
  `0`). qialike's TUI **does not wire up `/feedback`** (the command registers against the harness's
  commands service, which this surface does not consume), so there is currently no UI entry point
  that triggers it.
- **qialike itself**: no analytics or telemetry of its own. It makes three kinds of outbound request
  — to **the provider you configured** (model listing and conversation requests), to GitHub /
  gitcode / qialike.com when **you run `/upgrade`** (version check and download), and **one
  automatic update check about a second after launch** (disable with
  `QIALIKE_DISABLE_AUTOUPDATE=1`; see "Updates"). The API key never enters the transcript and is
  never sent to a model.

## Building from source

**Users do not need to build** — install the released binary instead (see "Install as a command").
The full build procedure, including the toolchain, the harness checkout and its version
requirements, is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Install as a command

```sh
curl -fsSL https://qialike.com/install | bash      # released binary -> ~/.dsh/bin
# flags (both invocation forms):
#   bash -s -- --version 0.6.0    install a specific version (v-prefix accepted)
#               --no-modify-path  don't touch ~/.bashrc / ~/.zshrc
#               --dry-run         print the plan, change nothing
qialike                  # runnable from any directory from here on
qialike --help
qialike uninstall        # uninstall from inside the binary: clears the whole qialike home
                         #   (shared with dsh; $DSH_HOME, default ~/.dsh — config, logs,
                         #   themes, settings.yaml, sessions, profiles, storages,
                         #   attachments, exports, the .credentials.yaml credentials and
                         #   the binary under ~/.dsh/bin), removes the PATH export line the
                         #   installer added to ~/.bashrc/~/.zshrc, and the legacy
                         #   ~/.local/bin/qialike dev symlink; credentials are not
                         #   restored automatically, so re-enter the API keys.
qialike web [flags]      # open the DeepSeek Harness browser UI (forwards the installed
                         #   `dsh web` CLI; the Web surface stays the harness's own):
                         #   needs `dsh` on PATH (`npm install -g @deepseek-ai/dsh`) or
                         #   $QIALIKE_DSH; web flags (--port/--no-open/...) pass through
                         #   (--host 0.0.0.0 is refused by the web profile)
```

The install directory is fixed at `~/.dsh/bin` and **deliberately does not follow `$DSH_HOME`**:
`qialike uninstall` scans only `$HOME/.dsh/bin` and `$HOME/.local/bin`. Six published targets —
`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`, `windows-arm64` — and the
archive name decides the extractor (`tar.gz` on Linux, `zip` elsewhere). Windows installs as
`qialike.exe`; every other platform is refused by name before anything is written.

The binary embeds DeepSeek Harness at build time, so `qialike` needs no harness checkout, no `pnpm`
and no `node_modules` at runtime — only `DEEPSEEK_API_KEY` (environment / `~/.dsh` settings /
`.env`) and a workspace (default `cwd`, or `--workspace`). Session state, settings and credentials
live in `~/.dsh`.

### Windows Terminal (PowerShell / cmd)

Windows Terminal has no bash, so the `curl | bash` line above does not work there — install by hand:

1. Download `qialike-windows-x64.zip` from
   [Releases](https://github.com/qialike/qialike/releases) (on ARM devices take `-arm64`; the mirror
   is at `gitcode.com/qialike/qialike/releases`).

2. Unpack the single `qialike.exe` into `%USERPROFILE%\.dsh\bin\` — `qialike uninstall` scans only
   that directory and `~/.local/bin`, so this is where it will be cleaned up with the rest.

3. Add that directory to your **user** PATH (Settings → Environment Variables, or the PowerShell
   below), then **reopen the terminal**.

   ```powershell
   [Environment]::SetEnvironmentVariable('Path',
     "$env:USERPROFILE\.dsh\bin;" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')
   ```

4. Add a provider with `/models` after launching.

Verify with `qialike --version`. Those four steps are currently the only route — the networked
installer runs under bash only; and if you put `qialike.exe` somewhere else, `qialike uninstall`
will not remove it for you.

## Updates

Linux and macOS **update automatically**: about a second after launch a background child process
checks once for a newer release (it never blocks the UI, and failures are silent). Only a **patch**
release is **installed silently**; a **minor** or **major** release is announced in the status line
only.

- **What automatic updates require**: the binary sits in the install directory `~/.dsh/bin` (the one
  the `curl` installer places). A locally built checkout build is never replaced and takes no part
  in automatic updates.
- **Turning it off, or switching to notice-only**: the `qialike-update.auto` setting takes `true`
  (default — patch releases installed silently), `false` (no check at all) or `"notify"` (announce
  only, never install). `QIALIKE_DISABLE_AUTOUPDATE=1` disables it globally, and
  `QIALIKE_ALWAYS_NOTIFY_UPDATE=1` forces notice-only.
- **Updating by hand**: `qialike upgrade` moves to the newest release, `qialike upgrade <version>`
  installs a specific one, and `qialike upgrade --check` only reports. `/upgrade` does the same from
  inside the TUI.

**Windows updates by hand only**: a running `.exe` cannot be replaced and the installer is bash, so
there is no automatic update on Windows. `qialike upgrade --check` only checks and prints the
download links; updating means [installing by hand](#windows-terminal-powershell--cmd) — download
the new `.zip`, quit qialike, replace `qialike.exe`.

## Running

Once installed, run `qialike` directly (a build from source lands in `dist/qialike`):

```sh
qialike                              # start a new session on the hero screen (never auto-resumes)
qialike resume                       # continue the newest session in this directory
qialike --resume <sessionId>         # resume a specific persisted session
qialike --workspace ~/proj           # operate in ~/proj (its own sessions)
qialike --model deepseek-flash       # pick a model (DeepSeek V4.1 Flash)
qialike --help                       # every flag (--dump-config, --no-project-overlay, …)
```

On continuing sessions:

- A bare `qialike` always **starts a new session** and shows the hero screen; it never auto-resumes.
- `qialike resume` continues the most recently used session **in this directory** (last activity
  first) and lands directly in the conversation view; when no session there has content yet it still
  opens the conversation view rather than the hero.
- Resuming a session or sending it a message marks it most-recently-used, and the status line marks
  it `(resumed)`. An explicit `--resume <sessionId>` always wins.
- To **auto-resume on every launch**, set `resume_last: true` in `~/.dsh/qialike.json` (or
  `QIALIKE_RESUME_LAST=1`) — the default is `false`, i.e. every launch starts fresh.

### Browser UI and headless / remote access

`qialike web` runs the installed `dsh` CLI, which should be at least the harness version embedded in
this qialike build: both sides read and write the same `~/.dsh/sessions` logs, and an older `dsh`
reader mistakes the newer range-compressed `sourceEventSeqs` for corrupt history
(`SessionPersistenceCorruptionError`). It checks `dsh` first: when it is missing, or its version
differs from the one embedded in this build, a warning prints the matching install command (and on a
version difference the command exits without starting the web server).

`dsh web` binds to `127.0.0.1:3080`, prints one URL carrying a per-run auth token
(`http://127.0.0.1:3080/?token=…`) and opens it in the default browser. Use **that** URL: without
the token the server answers `401 dsh web authentication required; reopen the URL printed by dsh
web.`; and the auth cookie it sets is valid only for the authority it was issued for
(`127.0.0.1:3080` and `localhost:3080` are different authorities), so pick one hostname and stay
with it. `--port <n>` moves the port; if the port is already taken the second server exits with
`EADDRINUSE` while the browser keeps talking to the older one — whose token you do not have.

#### Serve locally, browse from another machine

Keep the default loopback binding and tunnel from the machine that has the browser — the service is
never exposed to the network, so this works on any network. Do **not** serve `--host 0.0.0.0`
directly: the web profile refuses it (`error: --host 0.0.0.0 is intentionally not supported yet …`).
The tunnel:

```sh
# on the headless / terminal-only host (no local browser, hence --no-open)
qialike web --no-open                  # note the printed http://127.0.0.1:3080/?token=… URL

# on the machine with the browser
ssh -L 3080:localhost:3080 user@headless-host
# then open the printed URL (http://127.0.0.1:3080/?token=…) in the local browser
```

If 3080 is taken **locally**, change only the local mapping — the server needs no restart and the
token URL does not change: `ssh -L 8080:localhost:3080 user@headless-host`, then open
`http://127.0.0.1:8080/?token=…`. Only a conflict on the **server** side calls for
`qialike web --port <n>`, together with a new tunnel target and URL.

### Surface features

- **Slash command palette**: type `/` to autocomplete. Commands: `/help`, `/models`, `/compact`,
  `/clear`, `/new`, `/sessions`, `/exit`. Use `↑/↓` to move, `Enter` to run, `Esc` to dismiss.
- **`/compact`**: manually compact the current session's older history into a summary, through the
  same harness `compaction` service the web surface uses. It takes no arguments (anything after the
  command is rejected with `Usage: /compact (no arguments)`); success, nothing-to-compact and the
  classified failures each have their own message.
- **`/plan` plan mode**: the agent plans instead of executing until the plan is approved via
  `exit_plan_mode`, or you leave with `/plan off`. `/plan <objective>` enters and hands the
  objective to the agent as a message at the same time.
- **`/goal` durable goal**: set one completion goal for long-running tasks. `/goal` shows the
  current goal, `/goal <objective>` creates one, `/goal edit <objective>` changes it, and
  `/goal pause` / `resume` / `clear` control it. Once created it works toward the goal in automatic
  rounds and stops when the model confirms the goal is met.
- **`/models` model selection**: a full-screen dialog with **two levels** — the first groups
  providers (one row per provider with a key set, the model count at the row's end, e.g.
  `OpenCode Zen · 63 models`; the current model sits on top), `Enter` opens that provider's **model
  sub-list**, and `Esc` goes back. **Every list has live type-to-filter** (a `⌕ type to filter` box
  on top), and lists longer than a page support `PgUp`/`PgDn` and `Home`/`End`. Picking a model in
  the sub-list and pressing `Enter` saves it — **the next request uses it**.
- **Reasoning effort**: for a model that declares it, pressing `Enter` in the sub-list first opens a
  third-level **Effort** picker — **the levels and the default come entirely from that model's own
  declaration** (the built-in DeepSeek offers Off / Low / High / Max, default High), and **the model
  choice completes only once the effort is confirmed**. The chosen level persists with the selection
  and rides on every request; providers that declare no effort skip the step. From the main window,
  **`Ctrl+T`** (or **`Alt+T`** where the terminal takes that combination) cycles it, and the current
  level is highlighted in the model label and the status line.
- **Providers and API keys**: `＋ Add provider` lists **every known provider** with its key status
  (`✓ key set` / `no key`), and configured OpenAI-compatible providers show the gateway's **live
  model list**. Selecting any provider sets or replaces its API key, and giving a dormant template
  route a key **activates it on the spot**. Press **`Ctrl+D`** (or `Alt+D`) in the list to
  deactivate the highlighted provider — **its API key is removed** and it leaves the first level; if
  the hidden one was current, the selection moves to another configured provider, and **with no
  usable provider left the model label reads `not set`**. Re-adding it means setting a key again.
  `＋ Add a custom provider` opens a field-by-field form for a custom endpoint and model ids.
- **`/theme` color schemes** (vim-style `:colorscheme`): bare `/theme` opens the **theme picker** —
  `↑/↓` to move, type to filter, **live preview** while moving, `Enter` applies and persists, `Esc`
  cancels and restores; `/theme <name>` and `/theme <role> <hex>` remain as shortcuts. **16 schemes**
  are built in, and `~/.dsh/themes/*.json` adds your own.
- **`/sessions` session manager (the only session picker)**: a full-screen dialog listing persisted
  sessions of the **current working directory** (title / id; newest first, grouped by creation date
  under `Today` / `Yesterday` / date headers). **Type to filter** (title/id/cwd); `Enter` resumes,
  `Ctrl+R` renames (local and persistent), `Ctrl+F` pins/unpins (pinned sessions gather in a
  `📌 Pinned` group on top), `Ctrl+D` deletes (two confirmations; the current session is protected),
  `Esc` backs out in two levels; longer lists support `PgUp`/`PgDn`/`Home`/`End`. Each row leads
  with the session's title — **a summary of its first task**. The dialog carries historical records
  only; starting a brand-new session is `/new`'s job.
- **`/new` new session**: starts a fresh session in place (cancels the current turn, creates a new
  agent, tears down the old one). The current model selection and working directory carry over, and
  the earlier conversation stays reachable from `/sessions` or `--resume`.
- **`/export` session export**: bare `/export` opens an **export dialog** (format JSON/Markdown,
  editable file name, sanitize toggle); flags go straight through — `/export <sessionId>` picks a
  session, `--markdown` switches format (JSON by default), `--sanitize` redacts (text and tool
  output become `[redacted:…]`), and `--output <name>` sets the file name (subdirectories allowed).
  It writes `export-<time>-<id>.(json|md)` into the **workspace root** and shows the path in the
  status line.
- **`/sidebar` right-panel toggle**: the right-hand **Steps** panel (`session <id>`, `Steps X/Y`
  progress and the step checklist; `no plan yet` when the model has not used `todo_write`) shows
  automatically at ≥110 columns. Bare `/sidebar` cycles `auto → on → off`, `/sidebar on|off|auto`
  sets a mode, and **clicking the Steps title bar** does the same; the choice persists in
  `~/.dsh/qialike.json`.
- **Layout**: a conversation column (transcript plus the input dock) and the Steps panel
  on the right.
- **Live run status (the screen never *looks* frozen)**: while the agent runs, the status bar keeps
  showing the **phase and elapsed seconds** — `⠙ thinking · 12s · Esc to pause` (thinking),
  `⠴ answering · Ns` (streaming text); a tool call shows the current tool name (parallel calls
  collapse to `name ×n`), and after ≥4s of silence it adds `Ns since last event`. Settled tool rows
  collapse into **summary cards** (e.g. `✓ bash · ls -la …`, `✓ todo_write · 3/5`), and **clicking
  the row** or running **`/think`** expands or collapses the full result (the complete text always
  remains in the session log). If a model output hits its length ceiling before producing body text,
  the transcript says so plainly — send any message to continue, or lower the reasoning effort with
  `Ctrl+T`.
- **User-question dialog (`ask_user_question`)**: a single ask carrying several questions is
  answered on **one card**, one question at a time — the title shows `Ask question k/N` and each
  question is a clickable tab (answered `✓`, current `[n]`); answering advances automatically,
  `←/→` goes back to change an answer, the whole batch submits at the end, and `Esc` cancels it.
  Choosing **Other…** opens an inline editor directly under the option list. Questions and options
  **wrap in full, never truncated**, and the dialog scrolls internally when content overflows.
- **Approval dialog**: when a tool requests approval, an in-band dialog shows the tool name and the
  reason. `y`/`a` allows once, `n`/`Esc` rejects. On a host where the sandbox cannot be enforced,
  this dialog is what per-call shell approval runs through.
- **Running tool rows stay alive**: while Bash/Read/Write and friends execute, the row animates — a
  leading spinner and a live `· Ns` elapsed tail — and returns to the static icon row afterwards,
  where a click expands the result.

### Tools (model-callable)

- **`delete` / `move`**: delete, rename or move files and directories inside the workspace. The
  harness's built-in file tools only create, overwrite and edit — they cannot delete or rename, so
  qialike supplies those two. **The fence**: they operate **inside the workspace root only**,
  **refuse the workspace root itself**, and both ends of a `move` must be inside the workspace;
  `read-only` refuses them and `danger-full-access` allows them. `delete` is **irreversible** (there
  is no trash), removing a non-empty directory needs an explicit `recursive: true`, and creating a
  file needs no `mkdir` — parent directories are created for you.
- **`glob` / `grep`**: find files by path pattern and search by content. Both are driven by the
  ripgrep the package carries, and they work **out of the box** — no separate ripgrep install and no
  path to configure.

## Plugin architecture ("everything is a plugin")

Everything in qialike is a plugin — the interface itself included. Extensions therefore need no
rebuild, and both channels take plain data files:

- **Skills**: drop a skill bundle at `$DSH_HOME/skills/<name>/SKILL.md` (or a project's
  `.dsh/skills/`, `.agents/skills/`, or `~/.agents/skills/`) and the harness discovers it — there is
  no switch to flip.
- **MCP servers**: `qialike plugin add-mcp <name> <command> [args...]` appends a stdio MCP server to
  your overlay; its tools then appear to the model as `mcp__<name>__<tool>`. `remove-mcp` deletes
  that row.

`qialike plugin` does that file work for you, so there is no YAML to hand-write:

```sh
qialike plugin list [--available]   # layers and rows; --available lists every bundled plugin
qialike plugin add-mcp <name> <command> [args...] [--project]
qialike plugin remove-mcp <name> [--project]
```

`--project` targets the **repository-level** overlay (`<repo>/.dsh/tui.cordis.patch.yml`) rather than
your personal one. Enabling or disabling a built-in row needs no command either: write a row
**without** `insert` containing `disabled: true` and it overrides that row by `id`.
`qialike --dump-config` prints the composed layers and which layer each plugin came from.

### Provider catalogue and reasoning-effort declarations

`/models` → `＋ Add provider` lists **every known provider** — the self-hosted adapter's built-in
templates plus the loadable gateway sub-plugins, **62 in all** (61 template entries plus the
built-in `deepseek-official` endpoint). Three groups come from **loadable sub-plugins**, all enabled
by default and unloadable as a whole: write the corresponding switch in `qialike.json` and the
templates and already-configured routes both leave `/models` and the adapter.

| Sub-plugin | Switch | Providers |
| --- | --- | --- |
| `tui-opencode-gateways` | `qialike-opencode: { enabled: false }` | OpenCode Zen / Go |
| `tui-china-gateways` | `qialike-china-gateways: { enabled: false }` | Qiniu, SiliconFlow (including the cn endpoint) |
| `tui-foreign-gateways` | `qialike-foreign-gateways: { enabled: false }` | OpenRouter, Vercel AI Gateway, Cloudflare, Hugging Face, Baseten, Fireworks AI, Together AI, Nvidia, Groq, Cerebras |

Most speak the OpenAI-compatible protocol; Anthropic and MiniMax use their native Messages
protocol. The official DeepSeek endpoint is not in the template catalogue — the built-in
`deepseek-official` default route serves it (3 models, ready with no configuration). Deployment-type
endpoints (Vertex AI, Databricks, Snowflake Cortex, plus the Azure and Cloudflare rows the plugins
provide) are flagged `endpoint required`.

Configured OpenAI-compatible providers show the gateway's **live model list** (a dynamic
`GET {baseURL}/models`, falling back to the template's preset models on failure or timeout);
OpenCode Zen is a single entry listing all 63 models, and after saving any of them the request is
routed automatically to the right protocol endpoint — the `claude-`/`qwen-` prefixes to Anthropic
messages, `gpt-`/`grok-`/`muse-` to OpenAI Responses, `gemini-` to Google generateContent, and
everything else to chat/completions; all four authentications are verified against the live gateway.

**Reasoning effort** level sets are data-driven the same way: a provider's and model's **static
declaration** wins; only a route whose endpoint is confirmed to accept `reasoning_effort` (the
template declares `effortWire: 'reasoning-effort'`, today only the built-in DeepSeek) uses the
bundled models.dev-style catalogue snapshot (`src/effort-catalog.ts`) to fill in models with no
static declaration. Providers can therefore differ in their levels, and the list, the default
preselection, the `Ctrl+T` cycle and the request all follow that model's own declaration.

API keys are written by the credentials service into `~/.dsh/.credentials.yaml` (under each
provider's reference) and resolved on demand, with an environment variable of the same name taking
precedence. Models declaring image input (such as DeepSeek V4 Flash Vision Exp, GPT-4o, Claude)
accept images attached to the conversation, which the adapter converts into OpenAI `image_url` parts
or Anthropic base64 source blocks.

## Where files live

| Path | Contents |
| --- | --- |
| `~/.dsh/bin/qialike` | The program itself. The install directory is fixed here and **deliberately does not follow `$DSH_HOME`** |
| Workspace (default `cwd`) | Where the agent reads and writes; `/export` output goes here too |
| `~/.dsh/qialike.json` | This interface's settings: `resume_last`, `sidebar_mode`, `hidden_providers` |
| `~/.dsh/settings.yaml` | harness settings |
| `~/.dsh/.credentials.yaml` | API keys for each provider |
| `~/.dsh/sessions/` | Session logs, shared with `dsh` and the web UI |
| `~/.dsh/themes/*.json` | Custom color schemes |
| `~/.dsh/profiles/tui/cordis.patch.yml` | Your own overlay (mount MCP servers, enable/disable built-in rows) |
| `~/.dsh/skills/` | Skill bundles (a project's `.dsh/skills/` works too) |
| `~/.dsh/qialike.log` | Error and crash log; rotates to `.log.1` past a threshold |

`qialike uninstall` clears `~/.dsh` (**including the credentials above**); see "Install as a
command".

## Troubleshooting

Look up what you are seeing; each entry points at the chapter that explains it.

**`qialike: command not found` (just installed)**: the PATH line is in your profile, but this shell
  has not read it — `source ~/.bashrc` (or `~/.zshrc` on zsh), or **open a new terminal**. See
  "Quick start", step 1.

**`Model: not set` / the hero says `No provider yet`**: no model is configured yet, or every
  configured one is hidden — add a provider in `/models` or set its key again. See "Surface
  features".

**`Terminal too small — keys paused`**: the terminal is not tall enough; this surface needs at
  least **14 rows** (and ≥110 columns to show the right panel) — make the window taller and the keys
  resume by themselves.

**`SANDBOX_UNAVAILABLE`**: neither sandbox rung (bubblewrap / Landlock) can be enforced on this
  host, so bash is refused under `workspace-write` / `read-only` — use the file tools instead, or
  switch to `danger-full-access` knowingly. See "Security boundaries".

**On a dark scheme the composer card merges into the page**: the terminal is 24-bit capable but
  does not say so and qialike dropped to 256 colors — set `COLORTERM=truecolor` or
  `QIALIKE_COLOR=24bit`. On a **16-color terminal** this is a known degradation with no fix. See
  "Terminal color depth".

**`401 dsh web authentication required`**: the address is missing its token — use the URL the
  server printed at startup, and do not switch between `127.0.0.1` and `localhost`.

**`EADDRINUSE`**: the port is taken. For a **server-side** conflict use
  `qialike web --port <n>`; for a **local-only** conflict just change the SSH mapping
  (`-L 8080:localhost:3080`) — the server needs no restart and the token URL does not change.

**`SessionPersistenceCorruptionError`**: the `dsh` on this system is older than the harness embedded
  in this build — upgrade it (`npm install -g @deepseek-ai/dsh`). See "Install as a command".

## Issues and contributing

- **Report a problem / request a feature**: [GitHub Issues](https://github.com/qialike/qialike/issues).
- **Contribute**: see [CONTRIBUTING.md](CONTRIBUTING.md) — build prerequisites, the test and check
  commands, the plugin-authoring and trust contract, and the commit conventions.

## Acknowledgements

qialike is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). qialike is
an independent community project, not affiliated with, cooperating with, authorized by or endorsed
by DeepSeek. "DeepSeek Harness" is a registered trademark of DeepSeek; it is used here only to
describe the technical origin and the relationship to the upstream software accurately.

## License

[MIT](LICENSE)

**The name and wordmark are outside the license grant**: the rights MIT grants — to use, modify and
redistribute — cover the **software itself**, not the `qialike` name or its wordmark. They identify
this project only; do not imply endorsement or partnership.

Third-party dependencies and their licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
