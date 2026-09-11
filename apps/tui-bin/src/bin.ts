#!/usr/bin/env node
/**
 * dsh-tui — the full single-file SEA boot for the TUI terminal surface.
 *
 * Not the binary's entry point: {@link ./main.ts} is. That thin entry resolves
 * `--version` and a lone `--help` without loading this module's static graph,
 * then delegates everything else here through a deferred dynamic import, so
 * this file's ~111-plugin import set (`generated/plugins.ts` and friends) only
 * instantiates when a real boot is needed. On load it re-checks its own
 * launcher flags (`uninstall`, `web`, version — the web forwarder must never
 * run inside the TUI's alternate screen buffer) and then runs the full
 * composition below.
 *
 * This boot reimplements the app-boot `boot()` sequence with one change: a
 * {@link SeaInclude} resolves bare `@deepseek-ai/*` plugin names from the
 * statically imported {@link PLUGIN_BUILTINS} map instead of a runtime
 * `import()`, which a single bundled file cannot perform. Everything else is
 * the real profile composition: dsh-base patch layer + the TUI patch layer
 * over an empty root config, with the same command-line, environment, and
 * fail-loud guards.
 *
 * @module @yourname/dsh-tui/bin
 */

import { basename, dirname, join } from 'node:path'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { constants, homedir, tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { assertEntriesActivated, installFailLoud, loadLayeredEnv, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { DSH_HOME_DIR_NAME, dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { PROFILE_ROOT, BASE_PATCH, TUI_PATCH, HARNESS_VERSION } from '../generated/config-embed.js'
import { PLUGIN_BUILTINS } from '../generated/plugins.js'
import pkg from '../../../package.json' with { type: 'json' }

const NAME = 'dsh-tui'

/** How long a launch may stay silent before the splash line is worth showing.
 *  Measured: a normal start paints its first frame at ~0.6 s (hero or the
 *  file-backed transcript), so 1.2 s keeps the splash out of the way of every
 *  normal launch and still covers a genuinely slow machine or cold cache.
 *  `DSH_TUI_SPLASH_MS` overrides the delay; a NEGATIVE value forces the line out
 *  (the positive control — see `drawSplash`). */
const SPLASH_DELAY_MS = Number(process.env.DSH_TUI_SPLASH_MS ?? 1200)

// ── `web` subcommand preflight ───────────────────────────────────────────────
// The harness CLI the `dsh-tui web` forwarder spawns shares `~/.dsh` session
// logs with this TUI, so a missing CLI or a version older than the embedded
// harness produces confusing failures later (e.g. history that will not load).
// Warn up front, print the exact install command, and let the user proceed.

/** Which `dsh` the web forwarder will launch (`$DSH_TUI_DSH` overrides PATH). */
function webDshCommand(): string {
  return process.env.DSH_TUI_DSH ?? 'dsh'
}

/** Windows needs the shell to resolve npm `.cmd`/`.bat` shims — both when the
 *  command comes from PATH and when an explicit `$DSH_TUI_DSH` points at a
 *  `.cmd`/`.bat` file. POSIX never uses the shell (arguments stay safe). */
function winShellFor(explicit: string | undefined): boolean {
  if (process.platform !== 'win32') return false
  return explicit === undefined || /\.(cmd|bat)$/i.test(explicit)
}

const VERSION_TOKEN_RE = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/
function parseVersion(text: string): string | null {
  const match = VERSION_TOKEN_RE.exec(text)
  return match === null ? null : match[1]
}

/**
 * Probe the installed `dsh`.
 * @returns 'ok' when the CLI exists AND its version matches the embedded one
 * (the caller proceeds to launch web); 'missing' when the CLI is absent
 * (caller exits 127); 'mismatch' when its version differs from the embedded
 * harness (caller exits 1 — web is NOT launched on a version mismatch).
 */
function preflightWebDsh(): 'ok' | 'missing' | 'mismatch' {
  const command = webDshCommand()
  const probe = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    // Windows resolves npm `.cmd`/`.bat` shims through the shell (PATH or an
    // explicit $DSH_TUI_DSH pointing at one); POSIX stays shell-free.
    shell: winShellFor(process.env.DSH_TUI_DSH),
    timeout: 5000,
  })
  if (probe.error !== undefined || probe.status === null || probe.status !== 0) {
    process.stderr.write(
      `${NAME}: web mode needs the DeepSeek Harness CLI (\`dsh\`), which is not installed.\n`
      + `  Install it with:\n`
      + `    npm install -g @deepseek-ai/dsh@${HARNESS_VERSION}\n`,
    )
    return 'missing'
  }
  const installed = parseVersion(probe.stdout ?? '')
  if (installed === null) {
    process.stderr.write(
      `${NAME}: warning — could not read the installed \`dsh\` version from \`${command} --version\` `
      + `(${probe.stdout.trim().slice(0, 80) || '<no output>'}).\n`
      + `  Install the matching version with:\n`
      + `    npm install -g @deepseek-ai/dsh@${HARNESS_VERSION}\n`,
    )
    return 'mismatch'
  }
  if (installed !== HARNESS_VERSION) {
    process.stderr.write(
      `${NAME}: warning — installed \`dsh\` ${installed} does not match the harness this ${NAME} embeds (${HARNESS_VERSION}).\n`
      + `  Install the matching version with:\n`
      + `    npm install -g @deepseek-ai/dsh@${HARNESS_VERSION}\n`,
    )
    return 'mismatch'
  }
  return 'ok'
}

/**
 * Include subclass that resolves bare plugin names from the statically bundled
 * module map. `cordis:` names and relative paths still fall through to the
 * standard {@link Include#import}.
 */
class SeaInclude extends Include {
  override import(name: string, getOuterStack?: () => string[]): unknown {
    const builtin = PLUGIN_BUILTINS[name]
    if (builtin !== undefined) return builtin
    return super.import(name, getOuterStack)
  }
}

/**
 * Boot the Loader against `configPath` with `patches`, resolving bare names
 * from the bundled plugin map. Mirrors `@deepseek-ai/dsh-app-boot#boot`, but
 * installs a {@link SeaInclude} as the `cordis:include` builtin before the
 * config-tree entries mount.
 * @param binName - the diagnostic prefix for load-failure errors.
 * @param configPath - absolute path of the empty root config to include.
 * @param patches - overlay patches applied over the included tree.
 * @param prepare - host setup run after the Loader installs and before any
 * config-tree entry mounts (provides the command line and launch environment).
 * @returns the booted root context once every entry started.
 */
async function bootSea(
  binName: string,
  configPath: string,
  patches: PatchOptions[],
  prepare: (ctx: Context) => void,
): Promise<Context> {
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(dirname(configPath)).href + '/'
    ctx.provide('dshHomePath', dshHomePath)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = SeaInclude
    ctx.loader.builtins.group = Group
    await prepare(ctx)
    await ctx.loader.create({
      id: 'include',
      name: 'cordis:include',
      config: {
        path: pathToFileURL(configPath).href,
        ...patches.length > 0 ? { patches } : {},
      },
    })
    await ctx.get('loader')?.await()
    if (ctx.get('loader') === undefined) return ctx
    await assertEntriesActivated(ctx, binName)
    return ctx
  } catch (cause) {
    await ctx.fiber.dispose()
    throw new Error(`${binName}: plugin tree failed to load: ${mountDetail(cause)}`, { cause })
  }
}

/**
 * Reportable text of a mount failure, with the failed ROWS named.
 *
 * The loader reports several failed rows as ONE `AggregateError` whose own
 * message ("loader entries failed to apply") names none of them, and the rows
 * sit behind it (directly or as `cause`) — so a composition that fails on two
 * rows printed nothing an operator could act on. The harness's own preset mount
 * flattens this shape (`agent-presets` `mountDetail`); the launcher has to do the
 * same, or a profile mistake costs a bisect instead of a message.
 * @param error - the value the boot rejected with.
 * @returns one line per cause.
 */
function mountDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const branches = error instanceof AggregateError
    ? error.errors
    : error.cause instanceof AggregateError ? error.cause.errors : []
  if (branches.length === 0) return error.message
  return [error.message, ...branches.map((branch) => `- ${mountDetail(branch).replaceAll('\n', '\n  ')}`)].join('\n')
}

/** Materialize the embedded profile files in a fresh temp dir and return their paths. */
function materializeProfile(): { root: string; base: string; tui: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-'))
  const root = join(dir, 'cordis.yml')
  const base = join(dir, 'base.cordis.patch.yml')
  const tui = join(dir, 'tui-app.cordis.patch.yml')
  writeFileSync(root, PROFILE_ROOT)
  writeFileSync(base, BASE_PATCH)
  writeFileSync(tui, TUI_PATCH)
  return { root, base, tui }
}

/**
 * A bounded single controller that disposes the tree once on a stop request.
 *
 * The alternate-screen leave is deliberately NOT issued here. Leaving the
 * alternate screen before the async disposal completes would paint every
 * render the still-mounted Ink app emits during teardown (agent status
 * changes, the busy spinner, cancellation/stream events) onto the normal
 * screen buffer, where it lingers above the shell prompt. The leave is owned
 * by the exit handlers instead: the guarded backstop in main() covers
 * pre-mount exits, and once the app mounts, its own exit handler (see
 * dsh-tui-app's start()) writes the leave after every other exit handler.
 */
function installShutdown(ctx: { current?: Context }): { shutdown(): Promise<void> } {
  let stopping: Promise<void> | undefined
  let exiting = false
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => { await ctx.current?.fiber.dispose() })()
    return stopping
  }
  // Dispose the tree and then actually exit: without the explicit
  // `process.exit` the event loop stays alive (stdin listener + the never-
  // resolving keep-alive promise in main()), so a SIGTERM/SIGINT would leave a
  // disposed-but-zombie process running forever and never record the exit.
  const exitAfterDispose = (code: number): void => {
    if (exiting) return
    exiting = true
    void shutdown().then(() => process.exit(code))
  }
  process.on('SIGTERM', () => exitAfterDispose(143))
  process.on('SIGINT', () => exitAfterDispose(130))
  return { shutdown }
}

/** The project version, read from the root package.json (single source of truth). */
function readVersion(): string {
  return (pkg as { version?: string }).version ?? '0.0.0'
}

/** Whether it is safe to `rm -rf` the given directory. The harness home is
 *  named `.dsh`; refusing anything else (a bare ancestor, the OS home, `/`,
 *  or an arbitrary `$DSH_HOME`) keeps a destructive clear from ever touching
 *  an un-scoped path. */
function canClearHome(dir: string): boolean {
  if (!dir) return false
  const home = homedir()
  if (dir === '/' || dir === home) return false
  return basename(dir) === DSH_HOME_DIR_NAME
}

/**
 * Uninstall dsh-tui completely: clear the entire harness home
 * (`$DSH_HOME`, default `~/.dsh`) — every dsh-tui-owned file (config, logs,
 * title/activity/pinned caches, custom themes) **and** the harness/dsh shared
 * data under the same root (settings.yaml, sessions, profiles, storages,
 * attachments, exports). All of it is optional user state, never required for
 * startup: each is regenerated on the next run (settings load as defaults,
 * a fresh anonymous id is minted, storage/attachments dirs are recreated), so
 * a cold home never fails. `~/.dsh/bin` is a local-dev install artifact and is
 * not present in production, so no special handling is needed for it — the
 * single recursive remove takes it along. The dev-install symlink at
 * `~/.local/bin` and the PATH export line the repo-root `install` script
 * appended to the shell profiles are removed too. The repo checkout is never
 * touched.
 * @returns the process exit code: 0 on success or when nothing was installed,
 * 1 when a removal failed or the home was refused as unsafe.
 */
function uninstallSelf(): number {
  let removed = 0
  let failed = false
  let refusedHome = false

  // Clear the entire harness home in one recursive remove. `~/.dsh/bin` (the
  // production binary copy a dev install creates) lives under the same root and
  // is just removed with it; production has no such dir.
  const home = dshHomePath()
  if (!canClearHome(home)) {
    // Never rm -rf a path we cannot prove is the dsh data home.
    refusedHome = true
    failed = true
    process.stderr.write(`${NAME}: refusing to clear harness home "${home}" — not a recognized dsh data directory. Remove it manually.\n`)
  } else {
    let present = false
    try {
      readdirSync(home)
      present = true
    } catch {
      present = false // home absent -> nothing installed
    }
    if (present) {
      try {
        rmSync(home, { recursive: true, force: true })
        removed += 1
        process.stdout.write(`${NAME}: removed ${home}\n`)
      } catch (error) {
        failed = true
        process.stderr.write(`${NAME}: failed to remove ${home}: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }

  // The dev-install symlink at ~/.local/bin (created by scripts/install). It is
  // not the production copy, so it can be unlinked directly.
  const localLink = join(homedir(), '.local', 'bin', NAME)
  try {
    const stat = lstatSync(localLink)
    if (stat.isFile() || stat.isSymbolicLink()) {
      rmSync(localLink, { force: true })
      process.stdout.write(`${NAME}: removed ${localLink}\n`)
      removed += 1
    }
  } catch {
    // No dev symlink installed.
  }

  // The PATH export line the repo-root `install` script appends to the shell
  // profiles. Drop it together with its `# dsh-tui` marker comment and the
  // blank line before it, so uninstall restores the profiles it touched.
  const pathLine = 'export PATH="$HOME/.dsh/bin:$PATH"'
  for (const rc of [join(homedir(), '.bashrc'), join(homedir(), '.zshrc')]) {
    let text: string
    try {
      text = readFileSync(rc, 'utf8')
    } catch {
      continue // no such profile
    }
    const kept: string[] = []
    let dropped = false
    for (const line of text.split('\n')) {
      if (line === pathLine) {
        dropped = true
        if (kept.at(-1) === '# dsh-tui') kept.pop()
        if (kept.at(-1)?.trim() === '') kept.pop()
        continue
      }
      kept.push(line)
    }
    if (!dropped) continue
    try {
      writeFileSync(rc, kept.join('\n'))
      process.stdout.write(`${NAME}: removed PATH entry from ${rc}\n`)
      removed += 1
    } catch (error) {
      failed = true
      process.stderr.write(`${NAME}: failed to remove PATH entry from ${rc}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  if (refusedHome) {
    process.stdout.write(`${NAME}: harness home "${home}" left in place (unsafe path refused). Remove it manually.\n`)
  } else if (failed) {
    // Some item failed to remove (e.g. the sandbox blocked a write, or a path
    // was locked). Never claim success: report the partial result honestly.
    process.stdout.write(`${NAME}: uninstall FAILED — ${removed === 0 ? 'nothing was removed' : 'some items removed'}; see the errors above. Nothing else was changed.\n`)
  } else if (removed === 0) {
    process.stdout.write(`${NAME}: nothing to remove (harness home and PATH entry not found)\n`)
  } else {
    process.stdout.write(`${NAME}: uninstalled\n`)
  }
  return failed ? 1 : 0
}

/**
 * Launch the DeepSeek Harness browser UI by forwarding the whole invocation to
 * the installed `dsh` CLI (`dsh web`, the official alias of `dsh --profile
 * web`). The Web surface is a harness-owned profile — dsh-base + dsh-web-app —
 * whose frontend dist ships inside the published `@deepseek-ai/dsh` package;
 * a single-file SEA cannot re-host its disk-backed mechanisms (agent-preset
 * files, per-client plugin bundles, the static dist), so this terminal
 * launcher delegates instead of re-implementing the surface. The `dsh` binary
 * must therefore be on PATH (or pointed to by `$DSH_TUI_DSH`).
 * @param args - the full invocation arguments (`args[0] === 'web'`), forwarded
 * verbatim: `dsh-tui web --port 8080 --no-open` runs `dsh web --port 8080 --no-open`.
 * @returns the child process exit code.
 */
function runWeb(args: string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    const explicit = process.env.DSH_TUI_DSH
    const child = spawn(explicit ?? 'dsh', args, {
      stdio: 'inherit',
      // Windows resolves npm `.cmd`/`.bat` shims through the shell — from PATH
      // or an explicit $DSH_TUI_DSH pointing at one (kept in sync with the
      // preflight probe above). POSIX never uses the shell.
      shell: winShellFor(explicit),
    })
    // Ctrl+C / SIGTERM reach the whole foreground process group, so both
    // processes receive the signal; forwarding leaves the server's own
    // shutdown path in charge, and we then exit with its status.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => { child.kill(signal) })
    }
    child.on('error', (error: Error & { code?: string }) => {
      if (error.code === 'ENOENT') {
        process.stderr.write(
          `${NAME}: web mode needs the DeepSeek Harness CLI (\`dsh\`) on PATH. `
          + `Install it with \`npm install -g @deepseek-ai/dsh\` (or the harness repo's install script), `
          + `then retry \`${NAME} web\`.\n`,
        )
        resolve(127)
      } else {
        process.stderr.write(`${NAME}: failed to launch dsh: ${error.message}\n`)
        resolve(1)
      }
    })
    child.on('exit', (code, signal) => {
      // A signal-terminated child exits with the shell convention 128 + N.
      const sigNum = signal === null
        ? undefined
        : Object.entries(constants.signals).find(([name]) => name === signal)?.[1]
      resolve(code ?? (sigNum === undefined ? 1 : 128 + Number(sigNum)))
    })
  })
}

async function main(): Promise<void> {
  // Launcher flags are handled before the app owns the command line.
  const args = process.argv.slice(2)
  if (args[0] === 'uninstall') {
    process.exit(uninstallSelf())
  }
  if (args.includes('--version') || args.includes('-V') || args.includes('-v')) {
    process.stdout.write(`${NAME} ${readVersion()}\n`)
    process.exit(0)
  }
  // The `web` subcommand hands over to the harness CLI before any terminal
  // surface mounts: the web server must never run inside the TUI's alternate
  // screen buffer. Remaining arguments go to `dsh` verbatim. A preflight
  // guides the user when the harness CLI is missing or its version does not
  // match the embedded one.
  if (args[0] === 'web') {
    const pre = preflightWebDsh()
    if (pre === 'missing') process.exit(127)
    if (pre === 'mismatch') process.exit(1) // version differs: warn, do NOT start web
    process.exit(await runWeb(args))
  }
  // Run inside the alternate screen buffer so the terminal keeps no scrollback
  // and never shows its right-edge scrollbar. The leave (`\x1b[?1049l`) must be
  // the process's LAST terminal write: anything written after it lands on the
  // normal screen buffer and stays there as residue — the stderr-mirrored exit
  // log line, Ink's unmount frame/cursor restore, and any frame the mounted
  // app re-renders while the tree disposes. Once the app mounts, its own exit
  // handler (dsh-tui-app's start()) is registered after every other exit-time
  // writer and issues the leave; this backstop only covers exits before that
  // handler exists (boot failure, early fatal errors), which is why it is a
  // no-op once `appMounted` is set.
  const leaveAlt = (): void => {
    try { process.stdout.write('\x1b[?25h\x1b[?1049l') } catch { /* ignore */ }
  }
  // Enter the alternate screen buffer. `--help` must keep its exact current
  // output — the commander-rendered text is the process's only write after
  // this entry — so the splash below is skipped for help invocations; it is
  // also restricted to a real terminal (a piped stdout is a capture, where a
  // splash would only add noise before Ink's first frame). The splash is
  // overwritten in place by the app's first Ink frame — the patched frame
  // writer (apps/tui-bin/build.mjs) erases and repaints every line of the
  // first frame, and `\x1b[0J` clears anything below it — and a boot failure
  // before the app mounts exits through the backstop above, which leaves the
  // alternate buffer and discards the splash with it. Nothing reaches the
  // normal screen buffer, so no residue.
  const wantsHelp = args.some((arg) => arg === '--help' || arg === '-h')
  // The interactive launch enters the alternate screen WITH ITS FIRST FRAME (the
  // frame-writer patch does it), because entering it here left the screen blank
  // from t≈0 until Ink painted (~0.6 s) — a flash of emptiness before the hero.
  // Help keeps the pre-mount entry (its fast path in main.ts writes the same
  // bytes), and a non-tty stdout keeps today's behaviour too.
  const interactiveLaunch = !wantsHelp && process.stdout.isTTY === true
  if (!interactiveLaunch) process.stdout.write('\x1b[?1049h')
  if (interactiveLaunch) {
    // DEFERRED splash: `dsh-tui <version> — starting…` used to be written
    // immediately, so a normal launch showed a grey status line and then
    // replaced it with the hero ~0.6 s later — a flash where the user asked for
    // the hero. It is a slow-boot indicator now: drawn only if the app has not
    // flushed a frame by then (the first frame erases and repaints this line in
    // place, so a slow boot still gets a message instead of an empty screen).
    // Version verbatim (no `v` prefix) — same shape as the hero headline.
    const drawSplash = (): void => {
      process.stdout.write(`\x1b[90m${NAME} ${readVersion()} — starting…\x1b[0m`)
    }
    if (SPLASH_DELAY_MS < 0) {
      // Diagnostic value: draw it unconditionally. A 0 ms delay is NOT a usable
      // positive control — the timer still waits for the thread to yield, and by
      // then Ink has usually flushed its first frame, so the guard suppresses it.
      drawSplash()
    } else {
      const splash = setTimeout(() => {
        const flushed = (globalThis as { __dshTuiLastFlushAt?: number }).__dshTuiLastFlushAt
        if (flushed !== undefined) return
        drawSplash()
      }, SPLASH_DELAY_MS)
      splash.unref?.()
    }
  }
  let appMounted = false
  process.on('exit', () => { if (!appMounted) leaveAlt() })
  const profile = materializeProfile()
  const environment = loadLayeredEnv(NAME)
  const app: { current?: Context } = {}
  let exitRequested = false
  installFailLoud(NAME, process, async () => { await app.current?.fiber.dispose() })
  const { shutdown } = installShutdown(app)

  const base = loadOptionalPatches(NAME, profile.base) ?? []
  const tui = loadOptionalPatches(NAME, profile.tui) ?? []
  const patches = [...structuredClone(base), ...structuredClone(tui)]

  const ctx = await bootSea(NAME, profile.root, patches, (hostCtx) => {
    app.current = hostCtx
    hostCtx.provide('dshLaunchEnvironment', environment)
    provideCmdline(hostCtx, {
      args,
      exit: code => { exitRequested = true; void shutdown().then(() => process.exit(code)) },
    })
  })
  app.current = ctx
  // The app is mounted; from here its own exit handler owns the leave (see the
  // comment above the backstop), so the backstop becomes a no-op.
  appMounted = true

  // Keep the process alive: the mounted TUI holds open handles. If the tree
  // disposed itself (a one-shot side of the app), let the loop drain.
  const loader = ctx.get('loader')
  if (loader !== undefined && !exitRequested) {
    await new Promise<void>(() => {})
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${NAME}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
