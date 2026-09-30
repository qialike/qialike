# @qialike/cli

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

Node.js **≥ 18** is required — it ships the `npm` used below. Install it first (the terminal must be
reopened afterwards so PATH picks it up), then install this package:

```powershell
winget install OpenJS.NodeJS.LTS     # or download the LTS installer from https://nodejs.org/
node --version                       # reopen the terminal, then check both
npm --version
npm i -g @qialike/cli
qialike --version
```

On Windows npm's global prefix is `%APPDATA%\npm` — inside your user profile, and on the user PATH
already — so this needs **no administrator rights**.

**Run it inside the Windows Terminal app**, not the legacy console window that `cmd.exe` /
`powershell.exe` open on their own: qialike draws 24-bit colour, `▀▄█` half-block art, emoji and a
flat cursor, and it takes mouse input — Windows Terminal handles all of that, the old console host
handles it poorly. Install it with `winget install Microsoft.WindowsTerminal` (Windows 11 ships it),
then open a PowerShell or cmd tab there — the shell is still your choice.

**You do not choose an architecture.** The package declares one optional dependency per Windows
target — `@qialike/cli-win32-x64` and `@qialike/cli-win32-arm64` — each restricted with `os`/`cpu`,
so npm downloads only the payload that matches your machine (x64 or arm64), never both.

## When optional dependencies are skipped

`--omit=optional`, pnpm's defaults (which skip them), a mirror that dropped the platform package or
an interrupted install all leave the launcher without a binary. It then prints the exact command to
install the package for your architecture, for example:

```sh
npm i -g @qialike/cli-win32-arm64@0.0.0-template
```

The version is pinned to the one you already have: a bare `npm i -g
@qialike/cli-win32-arm64` can resolve a platform package that does not match the parent that sent
you here. Use the version the launcher printed.

## Uninstalling

Two steps, because this package puts the program outside the harness home:

```sh
qialike uninstall                 # clears the harness home (state, settings, sessions)
npm uninstall -g @qialike/cli     # removes the program itself
```

`qialike uninstall` prints that second command for you — it cannot run it, because the payload sits
under your package manager's prefix rather than in `%USERPROFILE%\.dsh\bin`.

## Alternative installers

- Shell installer (Linux, macOS): `curl -fsSL https://qialike.com/install | bash`
- Release archives: <https://github.com/qialike/qialike/releases>

## License

MIT
