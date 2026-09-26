# qialike

Terminal client for **DeepSeek Harness** — a full-screen TUI over an agent session.

> **This npm channel ships the Windows binaries only.** Linux and macOS install with the shell
> installer, because a `curl … | bash` line is what those platforms already have:
>
> ```sh
> curl -fsSL https://qialike.com/install | bash
> ```
>
> Windows has no `bash`, which is why this package exists: it turns the manual
> "download a zip, unpack it into `%USERPROFILE%\.dsh\bin\`, edit your PATH, reopen the terminal"
> sequence into one command.

## Install (Windows)

```sh
npm i -g qialike
qialike --version
```

`x64` and `arm64` are both published and npm picks the right one for you. The download is about
56–59 MB and installs one binary; nothing else is fetched.

## How this package is put together

`qialike` itself is ~7 kB: a small launcher plus two `optionalDependencies`.

| package | contents | why |
| --- | --- | --- |
| `qialike` | `bin/qialike.js` | owns the `qialike` command; resolves and spawns the platform binary |
| `qialike-win32-x64` | `qialike.exe` (138 MB unpacked) | `os: win32`, `cpu: x64` |
| `qialike-win32-arm64` | `qialike.exe` (129 MB unpacked) | `os: win32`, `cpu: arm64` |

The `os`/`cpu` fields are what make npm install **exactly one** platform payload — the other is
skipped as an unsatisfiable optional dependency, never downloaded. This split (`bin` in a tiny
parent, the binary in a platform-specific child) is the same shape esbuild, Biome, SWC and sharp
use, and it exists for one reason: when a platform package goes missing — a mirrored registry that
dropped it, `npm i --omit=optional`, an interrupted install — a launcher can say so in words
instead of failing with a bare spawn error.

If you ever see:

```
qialike: the qialike-win32-x64 package is missing, so there is no binary to run.
```

reinstall it explicitly with the version the launcher prints.

## What it needs at runtime

Nothing but the binary. qialike embeds DeepSeek Harness at build time, so there is no harness
checkout, no `pnpm` and no `node_modules` involved once installed — only a
`DEEPSEEK_API_KEY` (environment, `~/.dsh` settings, or a `.env` file) and a workspace
(the current directory, or `--workspace`).

## Where your state lives

Everything is under `%USERPROFILE%\.dsh\` — shared with the `dsh` CLI and the web UI:

| path | what |
| --- | --- |
| `.credentials.yaml` | API keys (written by `/models`) |
| `sessions/` | session logs |
| `qialike.json` | settings, including providers added through `/models` |
| `profiles\` | your overlay, e.g. to mount MCP servers |
| `attachments\`, `storages\` | images and durable key/value state |

## Uninstalling

```powershell
qialike uninstall --help   # print what it will remove, and remove nothing
qialike uninstall          # then, if that is what you want
```

**`qialike uninstall` has no confirmation and ignores every argument except `--help`.** It clears
the entire `%USERPROFILE%\.dsh\` tree — sessions, settings, **and your credentials** — and removes
the PATH line the shell installer added. Credentials are not restored, so re-enter the API keys
(here, through `/models`).

Two Windows-specific notes, and the second one is a good reason this channel exists:

- `qialike uninstall` only edits `~/.bashrc` and `~/.zshrc`, neither of which Windows uses. Nothing
  this package adds lives there — npm's global bin directory (`%APPDATA%\npm`) is put on PATH by
  the Node installer — so there is no PATH line here to clean up.
- **The unfixable case for the shell installer is fixed here.** That installer places the binary at
  `%USERPROFILE%\.dsh\bin\qialike.exe`, which is *inside* the tree `qialike uninstall` clears — and
  Windows will not delete a running executable, so the recursive removal fails part-way and leaves
  the home half-deleted. Installed from npm, the running image lives under
  `%APPDATA%\npm\node_modules\qialike-win32-x64\`, outside `%USERPROFILE%\.dsh\`, so the clear has
  nothing locked to fight with and completes.

So on this channel the two steps are independent and both are needed:

```powershell
qialike uninstall            # 1. clear %USERPROFILE%\.dsh  (sessions, settings, credentials)
npm uninstall -g qialike     # 2. remove the program and its shim
```

## Links

- Source, releases and the full manual: <https://github.com/qialike/qialike>
- Mirror: <https://gitcode.com/qialike/qialike>
- Licence: MIT
