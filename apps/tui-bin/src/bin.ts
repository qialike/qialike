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

import { basename, dirname, join, resolve, sep } from 'node:path'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { constants, homedir, tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
import { PLUGIN_MODE, UNINSTALL_MODE, WEB_MODE } from './launcher-modes.ts'
import { classifyProjectLayer } from './project-overlay.ts'
import type { ProjectRowProblem } from './project-overlay.ts'

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
  // `||`, not `??`: an EMPTY override (`DSH_TUI_DSH= dsh-tui web`) means "unset".
  // spawnSync('') throws a TypeError, so `??` surfaced a stack trace instead of
  // the documented "install the CLI" guidance and its 127 exit code.
  return process.env.DSH_TUI_DSH || 'dsh'
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
 * The trust ledger the loader consults. It is module state on purpose: the
 * harness constructs this plugin as `new Include(ctx, config)`, so a subclass
 * constructor that swallows those arguments replaces the plugin's `ctx` with
 * whatever it was handed — the tree then dies with `ctx.extend` undefined.
 */
let activeTrustLedger: TrustLedger = {}

/** Publish the ledger to the loader (called once, before boot). */
function setTrustLedger(ledger: TrustLedger): void {
  activeTrustLedger = ledger
}

/**
 * Where LOCAL (non-bundled) plugins live: `<profile>/node_modules/`, i.e. the
 * ordinary npm layout. It must be this — and not a bespoke `plugins/` folder —
 * because the patch parser resolves a `./…` name against the PROFILE directory
 * before this code ever sees it, and because a plugin's own dependencies then
 * resolve through the same `node_modules` chain (the tax the survey documents).
 * Rename it here and the CLI, the validator and the loader stay in step.
 */
function localRoot(): string {
  return join(profileDir(), 'node_modules')
}

/** The trust ledger: `<profile>/plugins.trust.json`. */
function trustFile(): string {
  return join(profileDir(), 'plugins.trust.json')
}

/** One trusted plugin: what was vouched for, when, and against which harness. */
interface TrustRecord {
  /** Hash of the plugin directory at trust time (see {@link hashPluginDir}). */
  hash: string
  /** The harness version it was trusted against — an upgrade re-asks. */
  harness: string
  /** ISO timestamp, for the human reading the file. */
  at: string
  /** The resolved entry that will be loaded. */
  entry: string
}

/** Plugin name (or relative path) → its trust record. */
type TrustLedger = Record<string, TrustRecord>

/**
 * Read the trust ledger. A missing or unreadable file means "nothing trusted" —
 * the safe default: every local plugin then fails loud until it is trusted.
 */
function readTrustLedger(): TrustLedger {
  try {
    const raw = JSON.parse(readFileSync(trustFile(), 'utf8')) as unknown
    return typeof raw === 'object' && raw !== null ? raw as TrustLedger : {}
  } catch {
    return {}
  }
}

/** Restrictive permissions for the directory that holds plugins and the ledger. */
function hardenProfileDir(): void {
  try {
    mkdirSync(profileDir(), { recursive: true, mode: 0o700 })
    for (const path of [profileDir(), localRoot()]) {
      if (existsSync(path)) chmodSync(path, 0o700)
    }
  } catch { /* best effort: a filesystem without POSIX modes must not break a boot */ }
}

/** Stable hash of a plugin directory: every file's relative path + bytes, with
 *  `node_modules` excluded (dependencies are not what the user vouches for, and
 *  hashing them would make a reinstall look like tampering). */
function hashPluginDir(dir: string): string {
  const hash = createHash('sha256')
  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git')
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(current, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path, rel)
      else if (entry.isFile()) {
        hash.update(rel)
        hash.update('\0')
        hash.update(readFileSync(path))
        hash.update('\0')
      }
    }
  }
  walk(dir, '')
  return hash.digest('hex')
}

/** Resolve a plugin TARGET (`<name>` or a path under `plugins/`) to its entry,
 *  or undefined when it is not a local plugin. Paths are realpath-checked, so a
 *  symlink cannot point the loader outside the sandbox directory. */
function localPluginTarget(target: string): { dir: string; entry: string } | undefined {
  const root = localRoot()
  let entry: string
  if (target.startsWith('.') || target.startsWith('/') || target.startsWith('file:')) {
    // A path form is accepted only INSIDE the plugin root; `file://` URLs come
    // from the patch parser, which resolves `./name` against the profile dir.
    const asPath = target.startsWith('file:') ? fileURLToPath(target) : resolve(root, target)
    if (!existsSync(asPath)) return undefined
    entry = asPath
  } else {
    try {
      entry = createRequire(join(profileDir(), 'package.json')).resolve(target)
    } catch {
      return undefined
    }
  }
  let real: string
  let realRoot: string
  try {
    real = realpathSync(entry)
    realRoot = realpathSync(root)
  } catch {
    return undefined
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined
  // Hash the plugin directory: the entry's own directory, or the package root
  // when the entry is a file inside one.
  const dir = statSync(real).isDirectory() ? real : dirname(real)
  return { dir, entry: real }
}

/** The plugin target a RESOLVED specifier refers to (used by the ladder). */
function resolveLocalPlugin(name: string): { dir: string; entry: string } | undefined {
  return localPluginTarget(name)
}

/**
 * Fail loud unless the ledger vouches for THIS directory, under THIS harness
 * version, unchanged since it was trusted. The three failure modes have three
 * different fixes, so each message says which one applies.
 */
function assertPluginTrusted(name: string, local: { dir: string; entry: string }, trusted: TrustLedger): void {
  const record = trusted[name]
  const prefix = `${NAME}: refusing to load local plugin "${name}" (${local.dir})`
  const reTrust = `run \`${NAME} plugin trust ${name}\` to trust it (read its files yourself first)`
  if (record === undefined) {
    throw new Error(`${prefix}: it is not trusted yet — ${reTrust}`)
  }
  if (record.harness !== HARNESS_VERSION) {
    throw new Error(`${prefix}: it was trusted for harness ${record.harness}, this build embeds`
      + ` ${HARNESS_VERSION} — ${reTrust} again after reviewing it`)
  }
  const actual = hashPluginDir(local.dir)
  if (record.hash !== actual) {
    throw new Error(`${prefix}: its contents changed since it was trusted (hash mismatch) —`
      + ` ${reTrust} again after reviewing the change`)
  }
}

/**
 * Every LOCAL plugin name worth reporting: the ones an overlay actually
 * references (a row that is neither bundled nor `cordis:`) plus whatever the
 * ledger remembers. Enumerating `node_modules` itself would list the whole
 * dependency tree of anything installed beside them.
 * @param layers - the parsed layers, embedded first.
 */
function referencedLocalPlugins(layers: readonly (readonly PatchOptions[])[]): string[] {
  const names = new Set<string>()
  const walk = (entries: readonly unknown[]): void => {
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as { name?: unknown; insert?: unknown }
      if (typeof row.name === 'string' && !(row.name in PLUGIN_BUILTINS) && !row.name.startsWith('cordis:')) {
        names.add(row.name)
      }
      if (Array.isArray(row.insert)) walk(row.insert)
    }
  }
  for (const layer of layers) walk(layer)
  return [...names].sort()
}

/** Human-readable trust state of one candidate (used by `plugin list`). */
function trustState(target: string, ledger: TrustLedger): string {
  const local = localPluginTarget(target)
  if (local === undefined) return 'UNRESOLVABLE'
  const record = ledger[target]
  if (record === undefined) return 'NOT TRUSTED'
  if (record.harness !== HARNESS_VERSION) return `trusted for harness ${record.harness} (this build: ${HARNESS_VERSION})`
  return record.hash === hashPluginDir(local.dir) ? 'trusted' : 'CHANGED since trusted'
}

/** Write the trust ledger atomically (temp + rename) with owner-only modes. */
function writeTrustLedger(ledger: TrustLedger): void {
  mkdirSync(profileDir(), { recursive: true, mode: 0o700 })
  const file = trustFile()
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, file)
  try { chmodSync(file, 0o600) } catch { /* best effort */ }
}

/** The project-overlay trust ledger: `<profile>/overlays.trust.json`. */
function overlayTrustFile(): string {
  return join(profileDir(), 'overlays.trust.json')
}

/** One trusted project overlay: which bytes were vouched for, when, against which harness. */
interface OverlayTrustRecord {
  hash: string
  harness: string
  at: string
}

/** Absolute overlay path → its trust record. */
type OverlayTrustLedger = Record<string, OverlayTrustRecord>

/** Read the overlay ledger; a missing or unreadable file means "nothing trusted". */
function readOverlayTrust(): OverlayTrustLedger {
  try {
    const raw = JSON.parse(readFileSync(overlayTrustFile(), 'utf8')) as unknown
    return typeof raw === 'object' && raw !== null ? raw as OverlayTrustLedger : {}
  } catch {
    return {}
  }
}

/** Write the overlay ledger atomically (temp + rename) with owner-only modes. */
function writeOverlayTrust(ledger: OverlayTrustLedger): void {
  mkdirSync(profileDir(), { recursive: true, mode: 0o700 })
  const file = overlayTrustFile()
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, file)
  try { chmodSync(file, 0o600) } catch { /* best effort */ }
}

/**
 * Ledger key for one overlay: the realpath when it resolves, else the resolved
 * path. A repository reached through a symlinked path must hit the same record
 * as the same repository reached directly.
 */
function overlayKey(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return resolve(file)
  }
}

/** sha256 of the overlay FILE's bytes — the thing that actually gets applied. */
function overlayContentHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Refuse safety row changes from the project scope, naming the rows and the fix. */
function assertProjectOverlaySafe(file: string, problems: readonly ProjectRowProblem[]): void {
  const safety = problems.filter((p) => p.kind === 'safety').map((p) => p.id)
  if (safety.length === 0) return
  throw new Error(`${NAME}: the project overlay ${file} changes safety-critical rows (${safety.join(', ')})`
    + ` — this repository cannot decide your sandbox, approval or permission settings.`
    + ` Move that part to YOUR overlay (${userPatchPath()}), or start with \`--no-project-overlay\`.`)
}

/** Refuse execution rows until this exact file is trusted for THIS harness version. */
function assertProjectOverlayTrusted(file: string, problems: readonly ProjectRowProblem[]): void {
  const rows = problems.filter((p) => p.kind === 'execution').map((p) => p.id).join(', ')
  const reTrust = `run \`${NAME} plugin trust-overlay\` inside that repository to trust it (read the file yourself first)`
  const record = readOverlayTrust()[overlayKey(file)]
  if (record === undefined) {
    throw new Error(`${NAME}: the project overlay ${file} mounts a server that runs a process (${rows})`
      + ` — ${reTrust}, or start with \`--no-project-overlay\``)
  }
  if (record.harness !== HARNESS_VERSION) {
    throw new Error(`${NAME}: the project overlay ${file} was trusted for harness ${record.harness},`
      + ` this build embeds ${HARNESS_VERSION} — ${reTrust} again after reviewing it`)
  }
  const actual = overlayContentHash(file)
  if (record.hash !== actual) {
    throw new Error(`${NAME}: the project overlay ${file} changed since it was trusted (hash mismatch)`
      + ` — ${reTrust} again after reviewing the change`)
  }
}

/** Load a trusted local plugin IN PROCESS. `require` (not `import`) because the
 *  loader resolves plugins synchronously; ESM namespaces are normalized to the
 *  shape cordis expects (a function or an object with `apply`). */
function loadLocalPlugin(local: { dir: string; entry: string }): unknown {
  const loaded = createRequire(join(profileDir(), 'package.json'))(local.entry) as
    { default?: unknown } | ((...args: unknown[]) => unknown)
  const candidate = (loaded as { default?: unknown }).default ?? loaded
  if (typeof candidate === 'function') return candidate
  if (typeof loaded === 'function') return loaded
  return candidate
}

/**
 * Include subclass implementing the resolution ladder of a single-file build:
 *
 *  1. `cordis:*`            → the loader's own builtins;
 *  2. a BUNDLED name        → the statically imported map (zero resolution risk);
 *  3. a LOCAL plugin        → `<profile>/plugins/…`, loaded in-process, and only
 *                             when the trust ledger vouches for it (see
 *                             {@link assertPluginTrusted});
 *  4. anything else         → loud failure naming every place that was tried.
 *
 * Step 3 is the T1 channel: it exists because the README invites third-party
 * plugins through `ctx.get('tui')`, while a bundled-only build can only run
 * plugins that were compiled into it. It is deliberately narrow — the plugin
 * must live under the profile's `plugins/` directory (realpath-checked, so a
 * symlink cannot escape), must be trusted for THIS harness version, and cannot
 * have changed since it was trusted.
 */
class SeaInclude extends Include {
  override import(name: string, getOuterStack?: () => string[]): unknown {
    const builtin = PLUGIN_BUILTINS[name]
    if (builtin !== undefined) return builtin
    if (name.startsWith('cordis:')) return super.import(name, getOuterStack)
    const local = resolveLocalPlugin(name)
    if (local !== undefined) {
      assertPluginTrusted(name, local, activeTrustLedger)
      return loadLocalPlugin(local)
    }
    throw new Error(`${NAME}: cannot resolve plugin "${name}": it is not one of the`
      + ` ${Object.keys(PLUGIN_BUILTINS).length} plugins bundled into this build,`
      + ` and no local plugin of that name is installed under ${localRoot()}`
      + ` (add one there and run \`${NAME} plugin trust ${name}\`)`)
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

/**
 * The directory the embedded composition is materialized into: a STABLE
 * per-user path under the harness home, not a fresh temp dir.
 *
 * It used to be `mkdtempSync($TMPDIR/dsh-tui-*)`, which leaked one directory per
 * launch (the only `rmSync` calls in this file belong to `uninstall`) and could
 * never be extended by the user. This is the harness's own profile namespace
 * (`dsh --profile tui`), which is exactly where a user patch layer belongs — the
 * built-in layers below are written under distinct names so they never collide
 * with a harness-managed `package.json` / `cordis.patch.yml` in that directory.
 */
function profileDir(): string {
  return join(dshHomePath(), 'profiles', 'tui')
}

/**
 * Write `content` to `file` only when it differs. The content IS the version
 * stamp: an upgrade rewrites the built-in layers, while a steady-state launch
 * touches no mtime.
 */
function syncFile(file: string, content: string): void {
  try {
    if (readFileSync(file, 'utf8') === content) return
  } catch { /* missing or unreadable: fall through and write it */ }
  writeFileSync(file, content)
}

/**
 * Best-effort removal of the profile dirs OLDER builds leaked into `$TMPDIR`
 * (one per launch). Only entries older than a day are removed: a directory in
 * use belongs to a launch of the same binary that is still running, and
 * deleting it under that process would break its config tree.
 */
function sweepLegacyProfiles(): void {
  const tmp = tmpdir()
  try {
    const now = Date.now()
    for (const name of readdirSync(tmp)) {
      if (!name.startsWith('dsh-tui-')) continue
      const path = join(tmp, name)
      try {
        if (now - statSync(path).mtimeMs < 24 * 60 * 60 * 1000) continue
        rmSync(path, { recursive: true, force: true })
      } catch { /* a single locked entry must not stop the sweep */ }
    }
  } catch { /* best effort: never let cleanup break a boot */ }
}

/**
 * Materialize the EMBEDDED composition (root config + the two built-in patch
 * layers) into {@link profileDir} and return their absolute paths.
 *
 * These three files are REQUIRED layers, not optional ones — see
 * {@link readEmbeddedLayer}; a missing file is this process's own bug and fails
 * loud rather than booting a composition without the TUI layer.
 */
function materializeProfile(): { root: string; base: string; tui: string } {
  const dir = profileDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  hardenProfileDir()
  const root = join(dir, 'cordis.yml')
  const base = join(dir, 'base.cordis.patch.yml')
  const tui = join(dir, 'tui-app.cordis.patch.yml')
  syncFile(root, PROFILE_ROOT)
  syncFile(base, BASE_PATCH)
  syncFile(tui, TUI_PATCH)
  sweepLegacyProfiles()
  return { root, base, tui }
}

/**
 * Path of the USER overlay — the one layer this binary does not own, applied
 * after both embedded layers (see `main`). Its absence is normal.
 */
function userPatchPath(): string {
  return join(profileDir(), 'cordis.patch.yml')
}

/**
 * The PROJECT overlay: `<projectRoot>/.dsh/tui.cordis.patch.yml`, applied AFTER
 * the user overlay so a repository can pin its own MCP servers without touching
 * the personal file. The filename is distinct from the harness's own project
 * files, so the two never fight over one path.
 *
 * The project root rule MIRRORS the harness's skill provider (walk up to the
 * first `.git`, else stay at cwd) — the overlay must land in the same directory
 * the project's `.dsh/skills` is discovered from, or "the project config" would
 * mean two different places.
 * @param cwd - directory the walk starts from.
 * @returns absolute path of the project overlay.
 */
function projectPatchPath(cwd: string): string {
  let current = cwd
  for (;;) {
    if (existsSync(join(current, '.git'))) return join(current, '.dsh', 'tui.cordis.patch.yml')
    const parent = dirname(current)
    if (parent === current) return join(cwd, '.dsh', 'tui.cordis.patch.yml')
    current = parent
  }
}

/** The overlay file for a scope. */
function overlayPath(scope: 'user' | 'project', cwd: string): string {
  return scope === 'project' ? projectPatchPath(cwd) : userPatchPath()
}

/** One `insert` row for an MCP server, as text (values JSON-quoted, which is
 *  also valid YAML double-quoted scalar / flow-sequence syntax). */
function mcpRowText(serverName: string, command: string, commandArgs: readonly string[]): string {
  return ['- insert:',
    `    - id: mcp-${serverName}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${JSON.stringify(serverName)}`,
    "        transport: 'stdio'",
    `        command: ${JSON.stringify(command)}`,
    `        args: [${commandArgs.map((a) => JSON.stringify(a)).join(', ')}]`,
    ''].join('\n')
}

/** One `name`-carrying row of a parsed patch layer. */
interface LayerRow { id: string; name: string; disabled: boolean }

/** Every row id a set of layers defines (top level and inside `insert`). */
function layerRowIds(layers: readonly (readonly PatchOptions[])[]): Set<string> {
  const ids = new Set<string>()
  const walk = (entries: readonly unknown[]): void => {
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as { id?: unknown; insert?: unknown }
      if (typeof row.id === 'string') ids.add(row.id)
      if (Array.isArray(row.insert)) walk(row.insert)
    }
  }
  for (const layer of layers) walk(layer)
  return ids
}

/**
 * Fail loud on a user overlay that cannot do what it says. The loader is silent
 * about both mistakes, which is the worst possible outcome for a hand-written
 * file: a row whose `id` matches nothing is a no-op, and an `insert`ed plugin
 * name that this single-file build never bundled simply never mounts.
 * @param user - the parsed user layer.
 * @param known - row ids defined by the embedded layers.
 * @param file - the overlay file the message must name.
 * @throws when the layer contains an unmatched id or an unbundled plugin name.
 */
function validateUserLayer(user: readonly PatchOptions[], known: ReadonlySet<string>, file: string): void {
  const problems: string[] = []
  const walk = (entries: readonly unknown[], inserted: boolean): void => {
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as { id?: unknown; name?: unknown; insert?: unknown }
      const id = typeof row.id === 'string' ? row.id : '(no id)'
      if (Array.isArray(row.insert)) {
        walk(row.insert, true)
        continue
      }
      if (inserted) {
        if (typeof row.name !== 'string') {
          problems.push(`inserted row ${id} has no \`name\``)
        } else if (!(row.name in PLUGIN_BUILTINS) && !row.name.startsWith('cordis:')
          && localPluginTarget(row.name) === undefined) {
          problems.push(`inserted row ${id} names "${row.name}", which this single-file build does not`
            + ` bundle and no local plugin under ${localRoot()} provides`)
        }
      } else if (typeof row.id === 'string' && !known.has(row.id)) {
        problems.push(`row ${id} matches no built-in row — a row WITHOUT \`insert\` only re-configures an`
          + ' existing row; to add a plugin, put it under `insert:`')
      }
      // `insert:` with nothing under it (or a non-list value) is a row that
      // mounts nothing while looking like it should — e.g. the header left
      // behind by deleting its last child.
      if ('insert' in row && !Array.isArray(row.insert)) {
        problems.push(`row ${id} has an empty \`insert\` — it needs at least one child row`)
      }
    }
  }
  walk(user, false)
  if (problems.length > 0) {
    throw new Error(`${NAME}: invalid overlay ${file}:\n  - ${problems.join('\n  - ')}`)
  }
}

/**
 * Every plugin a parsed layer contributes, including rows nested under
 * `insert`. Used by `--dump-config` to show WHERE each mounted plugin comes
 * from (embedded layer vs the user overlay).
 */
function layerRows(patches: readonly PatchOptions[]): LayerRow[] {
  const rows: LayerRow[] = []
  const walk = (entries: readonly unknown[]): void => {
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as { id?: unknown; name?: unknown; insert?: unknown; disabled?: unknown }
      if (typeof row.name === 'string') {
        rows.push({
          id: typeof row.id === 'string' ? row.id : '(no id)',
          name: row.name,
          disabled: row.disabled === true,
        })
      }
      if (Array.isArray(row.insert)) walk(row.insert)
    }
  }
  walk(patches)
  return rows
}

/**
 * Print the composed profile layers and exit — the diagnostic that answers
 * "which layer mounted this plugin?" (and the reason a user row failed to
 * resolve). Deliberately does NOT boot the tree.
 * @param layers - the layers in application order, embedded first.
 */
function dumpConfig(layers: readonly { label: string; file: string; patches: readonly PatchOptions[]; embedded: boolean }[]): void {
  const out = [`${NAME}: composition dump`]
  for (const layer of layers) {
    const rows = layerRows(layer.patches)
    const off = rows.filter((row) => row.disabled).length
    out.push(`  ${layer.label.padEnd(7)} ${layer.file}${layer.embedded ? ' (embedded)' : ''}`
      + ` — ${layer.patches.length} patch row(s), ${rows.length} plugin row(s)`
      + `${off > 0 ? `, ${off} disabled` : ''}`)
    for (const row of rows) out.push(`      ${row.id} → ${row.name}${row.disabled ? ' (disabled)' : ''}`)
  }
  process.stdout.write(out.join('\n') + '\n')
}

const PLUGIN_HELP = `Usage: dsh-tui plugin <command> [options]

Inspect and edit the layers this binary composes. The embedded (base + tui)
layers are read-only; the OVERLAYS are the extension point:
  user     ${'$DSH_HOME'}/profiles/tui/cordis.patch.yml           (always)
  project  <projectRoot>/.dsh/tui.cordis.patch.yml  (per repository)

Commands:
  list [--available]           layers, their plugin rows, and every plugin
                               bundled into this binary with --available
  add-mcp <name> <command> [args...] [--project]
                               append an stdio MCP server to the overlay
  remove-mcp <name> [--project]
                               delete that server's row from the overlay
  trust <name>                 record a LOCAL plugin as trusted (read its
                               files yourself first — this command does not)
                               <profile>/node_modules/<name> (runs in-process)
  untrust <name|path>          forget that trust (the files stay on disk)
  trust-overlay                trust THIS repository's overlay
                               (.dsh/tui.cordis.patch.yml) to mount servers
                               that run processes — read the file yourself first
  untrust-overlay              forget that decision (the file stays on disk)

MCP servers reach the model as mcp__<name>__<tool>. A row can only name a plugin
bundled into this build, and a row id must match a built-in row (or use insert);
anything else is rejected instead of being ignored.
`

/** Parse an overlay file, requiring it to be a valid patch list. */
function readOverlay(binName: string, file: string): { text: string; patches: PatchOptions[] } {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (text.trim() === '') return { text: '', patches: [] }
  const patches = loadOptionalPatches(binName, file)
  if (patches === undefined) throw new Error(`${binName}: ${file} disappeared while reading it`)
  return { text, patches }
}

/** The `serverName` of one MCP row, or undefined. */
function mcpServerName(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const entry = row as { name?: unknown; config?: unknown }
  if (entry.name !== '@deepseek-ai/dsh-mcp-client') return undefined
  const config = entry.config as { serverName?: unknown } | undefined
  return typeof config?.serverName === 'string' ? config.serverName : undefined
}

/** Whether a parsed layer already defines this MCP server. */
function definesMcpServer(patches: readonly PatchOptions[], serverName: string): boolean {
  const walk = (entries: readonly unknown[]): boolean => entries.some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const row = entry as { insert?: unknown }
    if (mcpServerName(entry) === serverName) return true
    return Array.isArray(row.insert) ? walk(row.insert) : false
  })
  return walk(patches)
}

/**
 * Delete one MCP server's row from an overlay by LINE SURGERY — the file is
 * hand-written and may hold `!!js` expressions or comments that a parse →
 * re-serialize round trip would destroy. The row is located by its
 * `serverName`, expanded upward to its enclosing `- ` item and downward to the
 * next item at the same indent, and only removed when exactly one candidate
 * exists (otherwise nothing is written).
 * @returns the new file text, or undefined when nothing matched.
 * @throws when the server appears more than once (ambiguous: refuse to guess).
 */
function removeMcpRowText(text: string, serverName: string): string | undefined {
  const lines = text.split('\n')
  const needle = new RegExp(`^\\s*serverName:\\s*['"]?${serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`)
  const hits = lines.reduce<number[]>((acc, line, i) => (needle.test(line) ? [...acc, i] : acc), [])
  if (hits.length === 0) return undefined
  if (hits.length > 1) {
    throw new Error(`${NAME}: ${serverName} appears ${hits.length} times — remove the rows by hand`)
  }
  const at = hits[0]!
  const indentOf = (line: string): number => (/^(\s*)/.exec(line)?.[1] ?? '').length
  const serverIndent = indentOf(lines[at]!)
  let start = at
  while (start > 0) {
    const above = lines[start - 1]!
    const item = /^(\s*)-\s/.exec(above)
    if (item !== null && item[1]!.length < serverIndent) { start -= 1; break }
    if (above.trim() === '' || indentOf(above) === 0) break
    start -= 1
  }
  const rowIndent = indentOf(lines[start]!)
  let end = at + 1
  while (end < lines.length) {
    const item = /^(\s*)-\s/.exec(lines[end]!)
    if (item !== null && item[1]!.length <= rowIndent) break
    end += 1
  }
  const kept = [...lines.slice(0, start), ...lines.slice(end)]
  // An `insert:` header whose block just lost its LAST row would be left dangling
  // (`- insert:` with nothing under it parses as a null child and mounts
  // nothing) — drop such a header too.
  for (let i = kept.length - 1; i >= 0; i--) {
    const header = /^(\s*)-\s+insert:\s*$/.exec(kept[i] ?? '')
    if (header === null) continue
    const next = kept.slice(i + 1).find((line) => line.trim() !== '')
    if (next === undefined || indentOf(next) <= header[1]!.length) kept.splice(i, 1)
  }
  const body = kept.join('\n')
  return body.trim() === '' ? '[]\n' : body
}

/**
 * `dsh-tui plugin …` — the overlay CLI (a launcher mode: it never boots the TUI).
 * @param argv - the whole invocation, `plugin` first.
 * @returns the process exit code.
 */
function runPlugin(argv: readonly string[]): number {
  const args = argv.slice(1)
  const command = args[0]
  const rest = args.slice(1)
  const scope: 'user' | 'project' = rest.includes('--project') ? 'project' : 'user'
  const positional = rest.filter((arg) => arg !== '--project')
  const cwd = process.cwd()
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(PLUGIN_HELP)
    return 0
  }
  if (command === 'list') {
    const dumped = materializeProfile()
    const layers = [
      { label: 'base', file: dumped.base, patches: readEmbeddedLayer(NAME, dumped.base), embedded: true },
      { label: 'tui', file: dumped.tui, patches: readEmbeddedLayer(NAME, dumped.tui), embedded: true },
      { label: 'user', file: userPatchPath(), patches: readOverlay(NAME, userPatchPath()).patches, embedded: false },
      { label: 'project', file: projectPatchPath(cwd), patches: readOverlay(NAME, projectPatchPath(cwd)).patches, embedded: false },
    ]
    dumpConfig(layers)
    const names = Object.keys(PLUGIN_BUILTINS).sort()
    process.stdout.write(`  bundled plugins: ${names.length}`
      + `${positional.includes('--available') ? `\n      ${names.join('\n      ')}` : ' (pass --available to list them)'}\n`)
    const ledger = readTrustLedger()
    const referenced = referencedLocalPlugins([layers[1]!.patches, layers[2]!.patches, layers[3]!.patches])
    const all = [...new Set([...referenced, ...Object.keys(ledger)])].sort()
    process.stdout.write(`  local plugins (${localRoot()}):${all.length === 0 ? ' none referenced' : ''}\n`)
    for (const target of all) {
      const orphan = ledger[target] !== undefined && !referenced.includes(target) ? ' (not referenced by any overlay)' : ''
      process.stdout.write(`      ${target} → ${trustState(target, ledger)}${orphan}\n`)
    }
    const projectFile = projectPatchPath(cwd)
    if (existsSync(projectFile)) {
      const project = readOverlay(NAME, projectFile).patches
      const policy = classifyProjectLayer(project, [layers[0]!.patches, layers[1]!.patches, layers[2]!.patches])
      const execution = policy.filter((p) => p.kind === 'execution').map((p) => p.id)
      const safety = policy.filter((p) => p.kind === 'safety').map((p) => p.id)
      process.stdout.write(`  project overlay: ${projectFile} — ${project.length} row(s)`
        + `${execution.length > 0 ? `, runs processes: ${execution.join(', ')}` : ''}`
        + `${safety.length > 0 ? `, REFUSED safety rows: ${safety.join(', ')}` : ''}\n`
        + `      trust: ${overlayTrustState(projectFile)}\n`)
    }
    return 0
  }
  if (command === 'add-mcp' || command === 'remove-mcp') {
    const [serverName, command0, ...commandArgs] = positional
    if (serverName === undefined) {
      process.stderr.write(`${NAME}: ${command} needs a server <name>\n`)
      return 1
    }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
      process.stderr.write(`${NAME}: "${serverName}" is not a valid server name ([A-Za-z0-9_-]{1,32})\n`)
      return 1
    }
    const file = overlayPath(scope, cwd)
    try {
      const overlay = readOverlay(NAME, file)
      let next: string
      if (command === 'add-mcp') {
        if (command0 === undefined) {
          process.stderr.write(`${NAME}: add-mcp needs <name> and <command>\n`)
          return 1
        }
        if (definesMcpServer(overlay.patches, serverName)) {
          process.stderr.write(`${NAME}: ${file} already defines the MCP server "${serverName}"\n`)
          return 1
        }
        // An overlay that parses to ZERO rows is effectively empty — appending
        // to the literal text of an `[]` file would emit a second YAML document.
        const text = overlay.patches.length === 0 ? '' : overlay.text.replace(/\n*$/, '\n')
        next = text + mcpRowText(serverName, command0, commandArgs)
      } else {
        const removed = removeMcpRowText(overlay.text, serverName)
        if (removed === undefined) {
          process.stderr.write(`${NAME}: ${file} defines no MCP server "${serverName}"\n`)
          return 1
        }
        next = removed
      }
      // Validate the FILE WE ARE ABOUT TO INSTALL (temp + rename): a broken
      // overlay must be caught here, not at the next boot.
      const temp = `${file}.tmp`
      mkdirSync(dirname(file), { recursive: true })
      try {
        writeFileSync(temp, next)
        loadOptionalPatches(NAME, temp)
        renameSync(temp, file)
      } catch (error) {
        rmSync(temp, { force: true }) // never leave a temp layer behind
        throw error
      }
      process.stdout.write(`${NAME}: ${command === 'add-mcp' ? 'added' : 'removed'} MCP server`
        + ` "${serverName}" ${command === 'add-mcp' ? 'to' : 'from'} ${file}\n`)
      return 0
    } catch (error) {
      process.stderr.write(`${NAME}: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }
  if (command === 'trust' || command === 'untrust') {
    const target = positional[0]
    if (target === undefined) {
      process.stderr.write(`${NAME}: ${command} needs a plugin <name> or path\n`)
      return 1
    }
    hardenProfileDir()
    const local = localPluginTarget(target)
    if (local === undefined) {
      process.stderr.write(`${NAME}: no local plugin "${target}" under ${localRoot()}\n`)
      return 1
    }
    const ledger = readTrustLedger()
    if (command === 'trust') {
      const hash = hashPluginDir(local.dir)
      ledger[target] = { hash, harness: HARNESS_VERSION, at: new Date().toISOString(), entry: local.entry }
      writeTrustLedger(ledger)
      process.stdout.write(`${NAME}: trusted local plugin "${target}" for harness ${HARNESS_VERSION}\n`
        + `  dir:   ${local.dir}\n  entry: ${local.entry}\n  hash:  ${hash}\n`
        + '  This plugin now runs IN THIS PROCESS with full privileges.\n')
      return 0
    }
    delete ledger[target]
    writeTrustLedger(ledger)
    process.stdout.write(`${NAME}: untrusted local plugin "${target}" (it stays on disk)\n`)
    return 0
  }
  if (command === 'trust-overlay' || command === 'untrust-overlay') {
    hardenProfileDir()
    const file = projectPatchPath(cwd)
    if (!existsSync(file)) {
      process.stderr.write(`${NAME}: no project overlay at ${file} (run this inside the repository)\n`)
      return 1
    }
    const ledger = readOverlayTrust()
    if (command === 'untrust-overlay') {
      delete ledger[overlayKey(file)]
      writeOverlayTrust(ledger)
      process.stdout.write(`${NAME}: untrusted the project overlay ${file} (the file stays on disk)\n`)
      return 0
    }
    // Show what is being vouched for: the rows that will run processes at boot —
    // and say so when the layer is refused for a reason trust cannot fix.
    const dumped = materializeProfile()
    const prior = [readEmbeddedLayer(NAME, dumped.base), readEmbeddedLayer(NAME, dumped.tui),
      readOverlay(NAME, userPatchPath()).patches]
    const problems = classifyProjectLayer(readOverlay(NAME, file).patches, prior)
    const execution = problems.filter((p) => p.kind === 'execution')
    const safety = problems.filter((p) => p.kind === 'safety')
    // A safety row makes the whole layer unusable: trust cannot buy it, so the
    // launch is refused no matter what the ledger says. Recording it as trusted
    // anyway would report success for something that cannot start (a script doing
    // `trust-overlay && dsh-tui` would see exit 0 and then a refused boot), and the
    // record is worthless besides — removing the safety row changes the file's hash
    // and invalidates it. So: name the rows, write NOTHING, and fail. This holds for
    // a MIXED layer too (safety + execution rows): the earlier shape returned 1 only
    // when there was no execution row at all.
    if (safety.length > 0) {
      process.stdout.write(`${NAME}: ${file} changes safety-critical rows (${safety.map((p) => p.id).join(', ')})`
        + ' — those are refused as a rule, not by trust, so this layer will be REJECTED at boot.'
        + ` Move that part to your own overlay (${userPatchPath()}).\n`)
      if (execution.length > 0) {
        process.stdout.write(`  not trusted: ${execution.map((p) => p.id).join(', ')}`
          + ' would only take effect if that row were gone (which also changes the file).\n')
      }
      return 1
    }
    if (execution.length === 0) {
      process.stdout.write(`${NAME}: ${file} mounts no process-running rows — nothing to trust\n`)
      return 0
    }
    const hash = overlayContentHash(file)
    ledger[overlayKey(file)] = { hash, harness: HARNESS_VERSION, at: new Date().toISOString() }
    writeOverlayTrust(ledger)
    process.stdout.write(`${NAME}: trusted the project overlay for harness ${HARNESS_VERSION}\n`
      + `  file:  ${file}\n  rows:  ${execution.map((p) => p.id).join(', ')}\n  hash:  ${hash}\n`
      + '  Its commands now run when dsh-tui starts in this repository.\n')
    return 0
  }
  process.stderr.write(`${NAME}: unknown plugin command "${command}" (see \`dsh-tui plugin --help\`)\n`)
  return 1
}

/** Human-readable trust state of the project overlay (used by `plugin list`). */
function overlayTrustState(file: string): string {
  const record = readOverlayTrust()[overlayKey(file)]
  if (record === undefined) return 'UNTRUSTED (execution rows will be refused at boot)'
  if (record.harness !== HARNESS_VERSION) return `trusted for harness ${record.harness} (this build: ${HARNESS_VERSION})`
  return record.hash === overlayContentHash(file) ? 'trusted' : 'CHANGED since trusted (refused at boot)'
}

/**
 * Read one REQUIRED embedded layer. The harness's `loadOptionalPatches` is the
 * parser for USER overlays and reports a missing file as `undefined`; called on
 * our own just-materialized layer that would silently degrade into "boots
 * without this layer", so it is turned into a loud failure here.
 * @param binName - diagnostic prefix.
 * @param file - absolute path of the layer.
 * @returns the parsed patch list (always an array).
 */
function readEmbeddedLayer(binName: string, file: string): PatchOptions[] {
  const layer = loadOptionalPatches(binName, file)
  if (layer === undefined) {
    throw new Error(`${binName}: embedded layer missing after materialization: ${file}`)
  }
  return layer
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
 * What `dsh-tui uninstall --help` explains instead of removing anything.
 *
 * `uninstall` ignores the rest of the line (that is what makes it safe to run
 * from an installer), so `--help` has to be answered before the removal: asking
 * what a destructive command does must never be the thing that runs it.
 */
const UNINSTALL_HELP = `${NAME} uninstall — remove dsh-tui and the state it created

Clears the harness home ($DSH_HOME, default ~/.dsh): settings, sessions,
attachments, exports, caches, custom themes, and ~/.dsh/bin. Removes the PATH
line the installer appended to ~/.bashrc / ~/.zshrc. The dsh-tui checkout is
never touched, and every cleared item is regenerated on the next run.

usage: dsh-tui uninstall [--help]
`

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
 * @param args - the full invocation arguments ({@link WEB_MODE} first), forwarded
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
  // Launcher flags are handled before the app owns the command line. Their
  // names live in `launcher-modes.ts` because `main.ts` (the thin entry) must
  // hand these positionals over before it validates the mode — see that module.
  const args = process.argv.slice(2)
  if (args[0] === UNINSTALL_MODE) {
    // Destructive, and (by design) it ignores the rest of the line — so `--help`
    // is answered here. Falling through would mean "tell me what this does"
    // wipes the harness home.
    if (args.some((arg) => arg === '--help' || arg === '-h')) {
      process.stdout.write(UNINSTALL_HELP)
      process.exit(0)
    }
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
  if (args[0] === WEB_MODE) {
    const pre = preflightWebDsh()
    if (pre === 'missing') process.exit(127)
    if (pre === 'mismatch') process.exit(1) // version differs: warn, do NOT start web
    process.exit(await runWeb(args))
  }
  // `plugin` owns its whole command line too, and — like the other launcher
  // modes — never boots the tree or touches the terminal.
  if (args[0] === PLUGIN_MODE) process.exit(runPlugin(args))
  // `--dump-config` is a DIAGNOSTIC: it must not touch the terminal at all (a
  // piped `dsh-tui --dump-config > file` has to stay free of screen escapes), so
  // it runs before the alternate screen, the splash and every terminal probe.
  // It materializes the layers (that is what it reports) and never boots.
  if (args.includes('--dump-config')) {
    const dumped = materializeProfile()
    const userFile = userPatchPath()
    const projectFile = projectPatchPath(process.cwd())
    dumpConfig([
      { label: 'root', file: dumped.root, patches: [], embedded: true },
      { label: 'base', file: dumped.base, patches: readEmbeddedLayer(NAME, dumped.base), embedded: true },
      { label: 'tui', file: dumped.tui, patches: readEmbeddedLayer(NAME, dumped.tui), embedded: true },
      { label: 'user', file: userFile, patches: loadOptionalPatches(NAME, userFile) ?? [], embedded: false },
      { label: 'project', file: projectFile, patches: loadOptionalPatches(NAME, projectFile) ?? [], embedded: false },
    ])
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

  const base = readEmbeddedLayer(NAME, profile.base)
  const tui = readEmbeddedLayer(NAME, profile.tui)
  // The USER overlay is applied LAST, so it can re-target any built-in row by id
  // or insert rows of its own (an MCP server: `name: '@deepseek-ai/dsh-mcp-client'`).
  // Optional by design — an absent file simply means "no overlay". Because the
  // single-file build resolves only the names bundled at build time, a user row
  // can re-configure and insert BUNDLED plugins, never load arbitrary code.
  const userFile = userPatchPath()
  const user = loadOptionalPatches(NAME, userFile) ?? []
  // The repository layer is skipped entirely by `--no-project-overlay` (or
  // DSH_TUI_NO_PROJECT_OVERLAY=1): the escape hatch for a repository whose
  // overlay this build refuses, and for anyone who does not want repo config.
  const skipProject = args.includes('--no-project-overlay') || process.env.DSH_TUI_NO_PROJECT_OVERLAY === '1'
  const projectFile = projectPatchPath(process.cwd())
  const project = skipProject ? [] : loadOptionalPatches(NAME, projectFile) ?? []
  // Both overlays are hand-written, and the loader is silent about every way they
  // can be wrong — so they are validated here, before anything boots. The
  // PROJECT layer is applied last: a repository outranks the personal file.
  const known = layerRowIds([base, tui])
  if (user.length > 0) validateUserLayer(user, known, userFile)
  if (project.length > 0) {
    validateUserLayer(project, known, projectFile)
    // The project scope has a policy of its own: no safety-critical rows, and
    // execution rows only when this exact file is trusted (see the block above).
    const projectPolicy = classifyProjectLayer(project, [base, tui, user])
    assertProjectOverlaySafe(projectFile, projectPolicy)
    assertProjectOverlayTrusted(projectFile, projectPolicy)
  }
  // Tell the app about the repository layer so the status bar can name it: the
  // layer is applied without any prompt, and silence is what makes it dangerous.
  if (existsSync(projectFile)) {
    process.env.DSH_TUI_PROJECT_OVERLAY = JSON.stringify({
      file: projectFile,
      rows: project.length,
      skipped: skipProject,
    })
  }
  const patches = [...structuredClone(base), ...structuredClone(tui),
    ...structuredClone(user), ...structuredClone(project)]

  setTrustLedger(readTrustLedger())
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
