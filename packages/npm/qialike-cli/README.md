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

```sh
npm i -g @qialike/cli
qialike --version
```

**You do not choose an architecture.** The package declares one optional dependency per Windows
target — `@qialike/cli-win32-x64` and `@qialike/cli-win32-arm64` — each restricted with `os`/`cpu`,
so npm downloads only the payload that matches your machine (x64 or arm64), never both.

## When optional dependencies are skipped

`--omit=optional`, pnpm's defaults (which skip them), a mirror that dropped the platform package or
an interrupted install all leave the launcher without a binary. It then prints the exact command to
install the package for your architecture, for example:

```sh
npm i -g @qialike/cli-win32-arm64@0.8.2
```

## Alternative installers

- Shell installer (Linux, macOS): `curl -fsSL https://qialike.com/install | bash`
- Release archives: <https://github.com/qialike/qialike/releases>

## License

MIT
