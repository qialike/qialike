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
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/** A bounded single controller that disposes the tree once on a stop request. */
function installShutdown(ctx: { current?: Context }): { shutdown(): Promise<void> } {
  let stopping: Promise<void> | undefined
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => { await ctx.current?.fiber.dispose() })()
    return stopping
  }
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
  return { shutdown }
}

/** The project version, read from the root package.json (single source of truth). */
function readVersion(): string {
  return (pkg as { version?: string }).version ?? '0.0.0'
}

async function main(): Promise<void> {
  // Launcher flags are handled before the app owns the command line.
  const args = process.argv.slice(2)
  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write(`${NAME} ${readVersion()}\n`)
    process.exit(0)
  }
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
