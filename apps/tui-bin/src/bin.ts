#!/usr/bin/env node
/**
 * dsh-tui — single-file SEA launcher for the TUI terminal surface.
 *
 * This entry reimplements the app-boot `boot()` sequence with one change: a
 * {@link SeaInclude} resolves bare `@deepseek-ai/*` plugin names from the
 * statically imported {@link PLUGIN_BUILTINS} map instead of a runtime
 * `import()`, which a single bundled file cannot perform. Everything else is
 * the real profile composition: dsh-base patch layer + the TUI patch layer
 * over an empty root config, with the same command-line, environment, and
 * fail-loud guards.
 *
 * @module @yourname/dsh-tui/bin
 */

import { dirname, join } from 'node:path'
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { assertEntriesActivated, installFailLoud, loadLayeredEnv, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { PROFILE_ROOT, BASE_PATCH, TUI_PATCH } from '../generated/config-embed.js'
import { PLUGIN_BUILTINS } from '../generated/plugins.js'
import pkg from '../../../package.json' with { type: 'json' }

const NAME = 'dsh-tui'

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
    throw new Error(`${binName}: plugin tree failed to load: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
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

/**
 * Uninstall dsh-tui: remove the dsh-tui-owned user files (`~/.dsh/dsh-tui.log`,
 * `~/.dsh/dsh-tui.json`), drop the PATH export line the repo-root `install`
 * script appended to the shell profiles, and point at the production binary
 * copy at `~/.dsh/bin/dsh-tui` for manual removal — that file is the running
 * binary, so it cannot delete itself. The dev-install symlink at
 * `~/.local/bin` is managed by `scripts/uninstall.sh` (`pnpm uninstall:local`),
 * not here. Sessions under `~/.dsh/sessions` are shared with dsh and are
 * intentionally kept; the repo checkout is never touched.
 * @returns the process exit code: 0 on success or when nothing was installed,
 * 1 when a removal failed.
 */
function uninstallSelf(): number {
  let removed = 0
  let failed = false
  // The production binary copy (the repo-root `install` script copies
  // dist/dsh-tui here). It IS the running binary, so the command only points
  // at it and lets the user finish the removal by hand.
  const copyPath = join(homedir(), '.dsh', 'bin', NAME)
  let copyPresent = false
  try {
    const stat = lstatSync(copyPath)
    copyPresent = stat.isFile() || stat.isSymbolicLink()
  } catch {
    // Nothing installed at the production path.
  }
  if (copyPresent) {
    process.stdout.write(`${NAME}: the running binary at ${copyPath} cannot delete itself; `
      + `remove it manually, e.g. \`rm ${copyPath}\`\n`)
  }
  // dsh-tui-owned user files (written by log.ts / config.ts at the same
  // dshHomePath anchors). Both are regenerated on the next run; sessions under
  // ~/.dsh/sessions are shared with dsh and are intentionally kept.
  for (const file of [dshHomePath('dsh-tui.log'), dshHomePath('dsh-tui.json')]) {
    try {
      rmSync(file)
      process.stdout.write(`${NAME}: removed ${file}\n`)
      removed += 1
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') continue // already gone
      failed = true
      process.stderr.write(`${NAME}: failed to remove ${file}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
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
  if (!copyPresent && removed === 0 && !failed) {
    process.stdout.write(`${NAME}: nothing to remove (no dsh-tui user files or PATH entry found)\n`)
  } else {
    process.stdout.write(`${NAME}: uninstalled. Reinstall with \`bash scripts/install\` (repo root).\n`)
  }
  return failed ? 1 : 0
}

async function main(): Promise<void> {
  // Launcher flags are handled before the app owns the command line.
  const args = process.argv.slice(2)
  if (args[0] === 'uninstall') {
    process.exit(uninstallSelf())
  }
  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write(`${NAME} ${readVersion()}\n`)
    process.exit(0)
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
  const leaveAlt = (): void => { try { process.stdout.write('\x1b[?25h\x1b[?1049l') } catch { /* ignore */ } }
  process.stdout.write('\x1b[?1049h')
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
