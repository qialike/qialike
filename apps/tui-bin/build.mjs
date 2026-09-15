/**
 * Build the single-file executable (`dist/dsh-tui`).
 *
 * The entry (`src/bin.ts`) boots the same profile composition the npm bundle
 * ships (dsh-base + dsh-tui-app patch layers) through the Cordis Loader, but a
 * single file cannot resolve plugin modules by name at runtime. So this builder:
 *  1. scans the DeepSeek Harness checkout for `@deepseek-ai/*` packages,
 *  2. reads the base + tui patch layers to find every plugin the composition
 *     references by `name`,
 *  3. emits an import manifest that statically imports exactly those modules
 *     and a config embed carrying the patch/root files,
 *  4. compiles the entry into ONE self-contained executable with
 *     `bun build --compile` (see {@link compileTarget}) — the runtime embedded in
 *     the artifact is Bun (it reports `Bun v…`, never a Node SEA blob).
 *
 * Resolution uses a symlink farm (`nodePaths`) so bare `@deepseek-ai/*` names —
 * including subpath exports — resolve through the harness's built packages and
 * then get bundled. Native-addon packages are stubbed: the TUI patch disables
 * the OS sandbox rows, so their (native) modules never activate; a stub keeps
 * the bundler from following the `.node` import.
 *
 * @module dsh-tui/build
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import semver from 'semver'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..')
const HARNESS = process.env.DSH_HARNESS ?? resolve(ROOT, '../deepseek-harness')
const OUT_DIR = join(ROOT, 'dist')
const GEN_DIR = join(ROOT, 'apps/tui-bin/generated')
const STUB_DIR = join(ROOT, 'apps/tui-bin/stub-native')
const ENTRY = join(ROOT, 'apps/tui-bin/src/main.ts')
/** Runtime-visible harness version: the app sidebar shows it above the dsh-tui
 *  version. Regenerated on every build from the detected harness checkout, so
 *  it can never drift from what was actually embedded. */
const HARNESS_VERSION_FILE = join(ROOT, 'packages/dsh-tui-app/src/harness-version.ts')

/**
 * deepseek-harness versions this TUI is compatible with: the current version
 * (`HARNESS_VERSION_MAX`, raised only after the TUI is re-validated against a
 * newer harness release) and every historical release back to
 * `HARNESS_VERSION_MIN`. Building against anything outside the range fails at
 * compile time instead of breaking silently at runtime.
 */
const HARNESS_VERSION_MIN = '0.1.0-rc.7'
const HARNESS_VERSION_MAX = '0.1.5-rc.2'

/** Cross-compile targets (`name` -> `bun build --compile --target` value). */
const ALL_TARGETS = [
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-x64',
  'windows-x64',
  'windows-arm64',
]
const BUN_TARGET = Object.fromEntries(ALL_TARGETS.map((name) => [name, `bun-${name}`]))

/** Packages that load a native `.node` addon; stubbed (never activated by the TUI patch). */
const NATIVE_PACKAGES = new Set([
  '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/node-addon-landlock-run',
  '@deepseek-ai/dsh-sandbox-windows-acl',
  '@deepseek-ai/dsh-win32-process',
])

/**
 * Stub source for a {@link NATIVE_PACKAGES} entry whose real module carries a
 * native addon but whose callers only need it to be importable and to report
 * "unusable". `node-addon-landlock-run` is Linux-only, so the OS sandbox must
 * run on Linux's **bwrap** rung; this stub keeps the module bundle-able and
 * makes the landlock probe return `unusable` so the `dsh-sandbox-local` chain
 * never selects it (macOS Seatbelt / Windows ACL never touch it either).
 * Keyed by package name; the link loop uses it in place of the generic proxy.
 */
const NATIVE_STUB_SOURCE = {
  '@deepseek-ai/node-addon-landlock-run': [
    'export const LAUNCHER_BIN = "landlock-run"',
    'export const LAUNCHER_FAILURE_EXIT = 125',
    'export const launcherPath = () => ""',
    'export const grantArgs = () => []',
    'export const probe = () => "unusable"',
    'export default ""',
    '',
  ].join('\n'),
  // Windows-only restricted-token runner; it pulls the native koffi-backed
  // `dsh-win32-process` whose struct size checks crash at module scope on
  // Linux. The bwrap (Linux) / Seatbelt (macOS) rungs never touch it, so a
  // no-op keeps the bundle importable; Windows ACL confinement stays off.
  '@deepseek-ai/dsh-sandbox-windows-acl': [
    'export class AclWriteGrant {}',
    'export const assertTempRootOutsideWorkspace = () => {}',
    'export const tempWriteSid = ""',
    'export const workspaceWriteSid = ""',
    '',
  ].join('\n'),
  // The Win32 Job/process ABI (`subprocess-local`'s Windows runner). Its `ffi.ts`
  // asserts Koffi's `STARTUPINFOW`/`PROCESS_INFORMATION` layouts at MODULE LOAD,
  // and the bun:ffi-backed koffi shim computes no size for them — so merely
  // importing the Linux-capable `subprocess-local` crashed the binary with
  // `STARTUPINFOW layout mismatch: koffi computed undefined, expected 104`.
  // Every export here backs a `process.platform === 'win32'` branch, so a stub
  // that keeps them importable (and throws if a Windows path ever runs) is
  // enough on Linux/macOS — same rule as the Windows ACL entry above.
  '@deepseek-ai/dsh-win32-process': [
    'export class Win32Error extends Error {}',
    'export const loadWin32ProcessBindings = () => { throw new Error("win32 process bindings are not available in dsh-tui") }',
    'export const probeCurrentTokenJobSupport = () => ({ supported: false })',
    'export const spawnCurrentTokenJobProcess = () => { throw new Error("win32 process spawning is not available in dsh-tui") }',
    'export const closeHandleChecked = () => {}',
    'export const isJobEmpty = () => true',
    'export const pollProcessExit = () => undefined',
    'export const terminateJob = () => {}',
    '',
  ].join('\n'),
}

/**
 * Subpath-aware stubs for a consolidated native-addon package: harness 0.1.5
 * folded the per-addon packages (`node-addon-landlock-run`, …) into
 * `@deepseek-ai/node-addon-system`, whose consumers import **subpaths**
 * (`/landlock-run`, `/flock`). A subpath import resolves through the package's
 * own `exports` map, so the stub directory below is written with one file per
 * subpath and an `exports` map generated from the same keys — a plain
 * `main`-only stub (what {@link NATIVE_STUB_SOURCE} installs) cannot satisfy it.
 *
 * `/flock`'s `tryLockExclusive` grants immediately, mirroring the harness's own
 * single-process worker replacement
 * (`packages/experimental/webworker-runtime/src/node/external_packages/node-addon-system-flock.ts`):
 * the JSONL backend's in-process write claim already excludes every writer, and
 * the kernel lease is new in 0.1.5 — 0.1.2-rc.1 had no lock at all — so a TUI
 * host that never takes it is not losing a protection it previously had. Two
 * `dsh-tui` hosts on the SAME session are consequently no longer kept apart by
 * a kernel lock; nothing else changes (a single host still serializes writes).
 */
const NATIVE_SUBPATH_STUB_SOURCE = {
  '@deepseek-ai/node-addon-system': {
    './landlock-run': [
      'export const LAUNCHER_BIN = "landlock-run"',
      'export const LAUNCHER_FAILURE_EXIT = 125',
      'export const launcherPath = () => ""',
      'export const grantArgs = () => []',
      'export const probe = () => "unusable"',
      'export default ""',
      '',
    ].join('\n'),
    './flock': [
      'export async function tryLockExclusive(_fd) { return undefined }',
      'export default { tryLockExclusive }',
      '',
    ].join('\n'),
  },
}

/**
 * Give the workflow tool a Worker entry that exists inside a single-file binary.
 *
 * `@deepseek-ai/dsh-workflow-worker-thread` runs each workflow script in a
 * Worker Thread whose entry is the sibling `lib/worker.cjs`. In a Bun SEA
 * `import.meta.url` points into the blob, so the built-mode entry
 * (`fileURLToPath(new URL('./worker.cjs', import.meta.url))`) resolves to
 * `/$bunfs/root/worker.cjs`, which does not exist — every `workflow` tool call
 * failed with `ModuleNotFound resolving "/$bunfs/root/worker.cjs"`.
 *
 * That bundle is small (~32 KB) but NOT self-contained (it requires
 * `@deepseek-ai/dsh-{brand,tools,util-values,workflow}`), so a copy dropped in
 * the temp dir could not resolve them. This step therefore RE-BUNDLES it out of
 * the farm with Bun into one self-contained CJS file, embeds those bytes, and
 * patches the built-mode branch to materialize the file once under the OS temp
 * dir (content-hash named) before spawning. Only `apps/tui-bin/x/**` is touched.
 */
function patchBunSeaWorkflowWorker() {
  const pkg = join(ROOT, 'apps/tui-bin/x', '-deepseek-ai-dsh-workflow-worker-thread')
  const host = join(pkg, 'lib', 'index.js')
  const entry = join(pkg, 'lib', 'worker.cjs')
  if (!existsSync(host) || !existsSync(entry)) return
  const out = join(ROOT, 'apps/tui-bin/stub-native', 'workflow-worker.bundle.cjs')
  try {
    mkdirSync(dirname(out), { recursive: true })
    rmSync(out, { force: true })
    run('bun', ['build', '--target=bun', '--format=cjs', '--outfile', out, entry])
  } catch (error) {
    console.log(`dsh-tui: workflow worker re-bundle failed (${
      error instanceof Error ? error.message.split('\n')[0] : String(error)}); workflow stays unavailable`)
    return
  }
  const bundled = readFileSync(out)
  const source = bundled.toString('base64')
  const text = readFileSync(host, 'utf8')
  const entryLine = 'entry: fileURLToPath(new URL("./worker.cjs", import.meta.url)),'
  if (!text.includes(entryLine)) {
    console.log('dsh-tui: workflow worker spawn shape changed; leaving it patched as-is')
    return
  }
  const preamble = [
    'import { existsSync as __dshWfExists, mkdirSync as __dshWfMkdir, writeFileSync as __dshWfWrite } from "node:fs";',
    'import { tmpdir as __dshWfTmp } from "node:os";',
    'import { join as __dshWfJoin } from "node:path";',
    'import { createHash as __dshWfHash } from "node:crypto";',
    '/* dsh-tui patch: materialize the embedded workflow worker (see build.mjs). */',
    `const __dshWorkflowWorkerSource = ${JSON.stringify(source)};`,
    'let __dshWorkflowWorkerPathCache;',
    'function __dshWorkflowWorkerPath() {',
    '  if (__dshWorkflowWorkerPathCache !== undefined) return __dshWorkflowWorkerPathCache;',
    '  const digest = __dshWfHash("sha256").update(__dshWorkflowWorkerSource).digest("hex").slice(0, 16);',
    '  const dir = __dshWfJoin(__dshWfTmp(), "dsh-tui-workflow");',
    '  const file = __dshWfJoin(dir, `worker-${digest}.cjs`);',
    '  try {',
    '    if (!__dshWfExists(file)) {',
    '      __dshWfMkdir(dir, { recursive: true });',
    '      __dshWfWrite(file, Buffer.from(__dshWorkflowWorkerSource, "base64"), { mode: 0o600 });',
    '    }',
    '  } catch { /* fall through: the Worker surfaces its own error */ }',
    '  __dshWorkflowWorkerPathCache = file;',
    '  return file;',
    '}',
    '',
  ].join('\n')
  writeFileSync(host, preamble + text.replace(entryLine, 'entry: __dshWorkflowWorkerPath(),'))
  const bare = /require\("@deepseek-ai\//.test(bundled.toString('utf8'))
  console.log(`dsh-tui: embedded workflow worker (${(bundled.length / 1024).toFixed(0)} KB)`
    + `${bare ? ' — WARNING: bundle still requires @deepseek-ai/* by name' : ''}`)
}

/**
 * Third-party modules that load a native binding (or an optional dev-only
 * tool) and must be stubbed so Bun never bundles the native `.node`/WASM it
 * cannot load inside a single file. Each is Windows-only FFI or a capability a
 * text coding-agent TUI never activates, so a no-op is correct on Linux.
 *
 * Add a module here (one line) instead of a new stubPackage call so the stub
 * set stays one data source and every stub is logged at build time.
 *
 * `koffi` is deliberately NOT in this set: on Windows the bundled harness
 * genuinely needs it for durable session/file writes (`MoveFileExW`,
 * `GetFileSecurityW`, ...). It gets a real `bun:ffi`-backed replacement
 * instead (see `installKoffiShim` below).
 */
const STUB_PACKAGES = new Set([
  'node-pty', // PTY terminal sessions — never exercised; bash runs via child_process
  'sharp', // native image processing — a text coding-agent TUI does not use it
  'react-devtools-core', // optional Ink devtools — dev-only
])

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Detect the deepseek-harness version: nearest git tag, then root package.json. */
function detectHarnessVersion() {
  try {
    const tag = run('git', ['-C', HARNESS, 'describe', '--tags', '--abbrev=0']).trim()
    if (tag.length > 0) return tag.replace(/^dsh-v/, '')
  } catch { /* not a git checkout with tags; fall back to the root manifest */ }
  const version = readJson(join(HARNESS, 'package.json')).version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`dsh-tui: cannot determine the deepseek-harness version at ${HARNESS}`)
  }
  return version.replace(/^dsh-v/, '')
}

/** Runtime-visible embedded harness version (see assertHarnessCompatible). */
let HARNESS_VERSION_CURRENT = ''

/**
 * Fail the build when the harness checkout is outside the supported range.
 * The TUI is only compatible with the current harness version and historical
 * releases; a newer (unvalidated) or too-old version is a misconfiguration.
 */
function assertHarnessCompatible() {
  const version = detectHarnessVersion()
  HARNESS_VERSION_CURRENT = version
  // Explicit gte/lte, not a semver range string: a range bound that carries a
  // pre-release only matches same-tuple pre-releases, so `>=0.1.0-rc.7` would
  // wrongly reject every historical 0.1.x version.
  if (!(semver.gte(version, HARNESS_VERSION_MIN) && semver.lte(version, HARNESS_VERSION_MAX))) {
    throw new Error(
      `dsh-tui: deepseek-harness ${version} is outside the supported range `
      + `(${HARNESS_VERSION_MIN} .. ${HARNESS_VERSION_MAX}). The TUI is only compatible with the `
      + `current and historical harness versions; after upgrading the harness checkout and `
      + `re-validating the TUI against it, raise HARNESS_VERSION_MAX in apps/tui-bin/build.mjs. `
      + `Otherwise point DSH_HARNESS at a compatible checkout.`,
    )
  }
  console.log(`dsh-tui: deepseek-harness ${version} (supported ${HARNESS_VERSION_MIN}..${HARNESS_VERSION_MAX})`)
  // Publish the embedded version as a compile-time constant for the app (the
  // single-file SEA has no on-disk package.json to read at runtime).
  writeFileSync(
    HARNESS_VERSION_FILE,
    `/** Embedded deepseek-harness version, regenerated by apps/tui-bin/build.mjs on every build. */\nexport const HARNESS_VERSION = ${JSON.stringify(version)}\n`,
  )
}

function listSubdirs(base) {
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
}

function listPackageDirs(base) {
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map((entry) => entry.name)
}

/**
 * Harness `@deepseek-ai/*` packages vendored into `x/` and linked into the
 * resolve farm. The TUI's plugin graph (`pluginSpecifiers()`) is a strict
 * whitelist drawn from the cordis.patch.yml layers, so the vast majority of
 * these never enter the single-file bundle — but copying them here still pulls
 * them into the resolution farm and leaves their source in `x/`.
 *
 * A handful pull in third-party SDKs under a **non-MIT** license (Apache-2.0
 * for the Agent Client Protocol / OpenAI Codex SDKs, and a commercial "All
 * rights reserved" license for the Claude Agent SDK). None are referenced by
 * the TUI patch layers, so they are excluded here to keep them out of the build
 * surface entirely. Add a package to this set (one line) instead of widening the
 * vendor copy.
 */
const EXCLUDED_NON_MIT_SDK_PACKAGES = new Set([
  '@deepseek-ai/dsh-subagent-claude-code', // pulls @anthropic-ai/claude-agent-sdk (commercial license)
  '@deepseek-ai/dsh-subagent-codex', // pulls @openai/codex (Apache-2.0)
  '@deepseek-ai/dsh-acp', // pulls @agentclientprotocol/sdk (Apache-2.0)
  '@deepseek-ai/dsh-subagent-acp', // pulls @agentclientprotocol/sdk (Apache-2.0)
  '@deepseek-ai/dsh-session-snapshot', // pulls @agentclientprotocol/sdk (Apache-2.0)
])

/** All harness `@deepseek-ai/*` packages as name → absolute package dir. */
function scanPackages() {
  const found = new Map()
  const add = (dir) => {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) return
    const pkg = readJson(manifest)
    if (typeof pkg.name === 'string' && pkg.name.startsWith('@deepseek-ai/')) {
      if (EXCLUDED_NON_MIT_SDK_PACKAGES.has(pkg.name)) return
      found.set(pkg.name, dir)
    }
  }
  for (const name of listPackageDirs(join(HARNESS, 'vendor'))) add(join(HARNESS, 'vendor', name))
  for (const groupDir of listSubdirs(join(HARNESS, 'packages'))) {
    for (const name of listPackageDirs(join(HARNESS, 'packages', groupDir))) add(join(HARNESS, 'packages', groupDir, name))
  }
  return found
}

/**
 * Copy a package's `lib/` tree, inlining every
 * `createRequire(import.meta.url)("<...package.json>")` read with the parsed
 * JSON literal. A single-file bundle has no on-disk sibling `package.json`, so
 * these version reads (the module's own metadata) must become literals.
 * @param name - the package name.
 * @param dir - the package directory.
 * @returns the transformed copy directory.
 */
function transformPackageCopy(name, dir) {
  const out = join(ROOT, 'apps/tui-bin/x', name.replace(/[^A-Za-z0-9-]+/g, '-'))
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'lib'), { recursive: true })
  // Copy the manifest but drop source-tree exports: a single-file bundle must
  // resolve to `lib/`, never back to the `.ts` source (whose top-level
  // `createRequire(...)("../package.json")` reads would break inside the blob).
  const manifest = readJson(join(dir, 'package.json'))
  if (manifest.exports && typeof manifest.exports === 'object') {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const value = typeof target === 'string' ? target : target?.default
      if (typeof value === 'string' && value.includes('/src/')) delete manifest.exports[subpath]
      if (subpath.includes('/src/')) delete manifest.exports[subpath]
    }
  }
  writeFileSync(join(out, 'package.json'), JSON.stringify(manifest, null, 2))
  copyLib(join(dir, 'lib'), join(out, 'lib'), dir)
  // Preserve declared bin scripts: the farm symlinks `node_modules/@deepseek-ai/*`
  // to these copies, and pnpm's bin-linking reads e.g. `cordis/bin.js` — a missing
  // file triggers an ENOENT warning on every `pnpm install`.
  copyBins(manifest, dir, out)
  return out
}

/** Copy a manifest's declared `bin` scripts from the source package into the copy. */
function copyBins(manifest, dir, out) {
  const bin = manifest.bin
  const paths = typeof bin === 'string' ? [bin] : bin && typeof bin === 'object' ? Object.values(bin) : []
  for (const binPath of paths) {
    if (typeof binPath !== 'string') continue
    const src = join(dir, binPath)
    if (!existsSync(src)) continue
    const dst = join(out, binPath)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
  }
}

/** Recursively copy `from`'s `.js` files to `to`, inlining package.json reads against `pkgRoot`. */
function copyLib(from, to, pkgRoot) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(dst, { recursive: true })
      copyLib(src, dst, pkgRoot)
      continue
    }
    if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue
    writeFileSync(dst, inlinePkgJson(readFileSync(src, 'utf8'), src, pkgRoot))
  }
}

/**
 * Replace `createRequire(import.meta.url)(spec)` reads of the package's own
 * `package.json` with the parsed JSON literal. The harness anchors these at the
 * module file, so `../package.json` from a `lib/types/*` file lands one level
 * down; every such read intends the package root, so the spec is rebased there.
 */
function inlinePkgJson(text, file, pkgRoot) {
  return text.replace(/createRequire\d*\(import\.meta\.url\)\((["'])([^"']+)\1\)/g, (match, quote, spec) => {
    const rebased = resolve(pkgRoot, spec.replace(/^(?:\.\.\/)+/, ''))
    const anchored = resolve(dirname(file), spec)
    const abs = existsSync(rebased) ? rebased : anchored
    if (existsSync(abs)) {
      try { return JSON.stringify(JSON.parse(readFileSync(abs, 'utf8'))) } catch { /* not JSON */ }
    }
    return match
  })
}

/** Every `@deepseek-ai/*` module specifier the two patch layers reference. */
function pluginSpecifiers() {
  const specifiers = new Set()
  const patchFiles = [
    join(HARNESS, 'packages/bundle/base/cordis.patch.yml'),
    join(ROOT, 'packages/dsh-tui-app/cordis.patch.yml'),
  ]
  // The patch files use `!!js` scalars (the include's YAML dialect), so a
  // standard YAML schema cannot parse them; for specifier collection only the
  // `name:` value matters, which is a plain scalar.
  const nameRe = /^\s*-?\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm
  for (const file of patchFiles) {
    if (!existsSync(file)) throw new Error(`missing patch file ${file}`)
    const content = readFileSync(file, 'utf8')
    for (const match of content.matchAll(nameRe)) specifiers.add(match[1])
  }
  specifiers.add('@yourname/dsh-tui-app')
  specifiers.add('@yourname/dsh-tui-app/startup')
  for (const name of [
    '@deepseek-ai/cordis-plugin-loader',
    '@deepseek-ai/cordis-plugin-include',
    '@deepseek-ai/cordis-plugin-group',
    '@deepseek-ai/cordis-plugin-hmr',
    '@deepseek-ai/cordis-plugin-timer',
    // Bundled WITHOUT a row of its own: the USER overlay
    // ($DSH_HOME/profiles/tui/cordis.patch.yml) mounts MCP servers by naming it,
    // and a single-file build can only resolve names bundled HERE. Rowless costs
    // nothing at runtime — an unmounted module never connects to anything.
    '@deepseek-ai/dsh-mcp-client',
  ]) specifiers.add(name)
  return specifiers
}

/**
 * Create the resolution farm: `<root>/node_modules/@deepseek-ai/<name>` linked
 * to each harness package. Bun resolves bare `@deepseek-ai/*` names — including
 * subpath exports — from this node_modules dir and bundles them. Native
 * packages (and a no-op stub) land on the stub so nothing pulls a `.node` addon.
 */
function createResolveFarm() {
  const nm = join(ROOT, 'node_modules')
  mkdirSync(STUB_DIR, { recursive: true })
  writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({ name: '.dsh-native-stub', type: 'module', main: 'index.js' }, null, 2))
  writeFileSync(join(STUB_DIR, 'index.js'), 'export {}\n')
  rmSync(join(ROOT, 'apps/tui-bin/x'), { recursive: true, force: true })
  // Clean stale @deepseek-ai / @yourname links so every run re-links to the
  // latest (possibly transformed) target.
  rmSync(join(nm, '@deepseek-ai'), { recursive: true, force: true })
  rmSync(join(nm, '@yourname'), { recursive: true, force: true })
  // Clear leftover stub dirs so the mirrored store supplies the real packages.
  rmSync(join(nm, '@opentelemetry'), { recursive: true, force: true })
  for (const name of STUB_PACKAGES) rmSync(join(nm, name), { recursive: true, force: true })

  const stubPackage = (name) => {
    const target = join(nm, ...name.split('/'))
    if (existsSync(target)) return
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }, null, 2))
    // A permissive proxy: any property access or call returns a callable that
    // returns itself, so chained/inside-function usage never throws. The
    // Windows-only (koffi), PTY, and image paths never actually execute on
    // Linux, but their module-scope assignments (e.g. `const PVOID =
    // koffi.pointer("void")`) still run at import and must not throw.
    writeFileSync(join(target, 'index.js'), [
      'const noop = () => noop',
      'const proxy = new Proxy(noop, {',
      '  get: (t, p) => (p === "then" || p === Symbol.toStringTag ? undefined : proxy),',
      '  apply: () => proxy,',
      '  construct: () => proxy,',
      '  set: () => true,',
      '})',
      'export default proxy',
      'export const load = proxy',
      'export const pointer = proxy',
      'export const struct = proxy',
      'export const proto = proxy',
      'export const array = proxy',
      'export const register = proxy',
      'export const unregister = proxy',
      'export const decode = proxy',
      'export const view = proxy',
      'export { proxy as koffi }',
      '',
    ].join('\n'))
  }

  /**
   * Install the bun:ffi-backed koffi replacement at `<node_modules>/koffi`.
   * The bundled harness loads koffi lazily on Windows for durable writes
   * (`MoveFileExW`, `GetFileSecurityW`, `ReplaceFileW`, `GetLastError`) and
   * process-table inspection; the native koffi addon cannot be embedded in a
   * single-file bun compile, so a pure-JS shim over `bun:ffi` stands in. POSIX
   * never imports koffi, but installing it unconditionally keeps one path for
   * every platform.
   * @param nm - the resolve-farm `node_modules` root.
   */
  const installKoffiShim = (nm) => {
    const target = join(nm, 'koffi')
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'koffi', type: 'module', main: 'index.js' }, null, 2))
    writeFileSync(join(target, 'index.js'), readFileSync(join(ROOT, 'apps/tui-bin/stub/koffi.js'), 'utf8'))
    console.log('dsh-tui: installed bun:ffi koffi shim')
  }
  // No-op stubs so the native/optional deps bundle and resolve (they are never
  // activated by a text coding-agent TUI). Created before the mirror so the
  // harness store does not supply the real (native) package. The whitelist is
  // the single source of truth; each stub is logged for auditability.
  for (const name of STUB_PACKAGES) {
    stubPackage(name)
    console.log(`dsh-tui: stubbed ${name}`)
  }

  // Windows FFI: the bundled harness needs a WORKING koffi for durable
  // session/file writes (`MoveFileExW`, `GetFileSecurityW`, ...) at runtime.
  // The real koffi is a native addon that cannot be embedded in the single
  // file, so install the bun:ffi-backed replacement in its place (before the
  // harness-store mirror, which would otherwise re-link the native package).
  installKoffiShim(nm)

  // Third-party deps of the vendored/transformed plugins resolve from the
  // harness's pnpm virtual store; mirror every entry we do not already own.
  mirrorHarnessStore(nm)

  // Ink's layout engine loads yoga.wasm at module scope via createRequire +
  // fs.readFile, which a single file cannot satisfy; inline the wasm as base64.
  patchInkYoga(nm)

  // Ink's full-screen render path falls back to clearing the whole terminal
  // (clearTerminal) whenever the output fills the screen — i.e. on EVERY
  // render of this full-screen TUI — which macOS Terminal.app repaints as a
  // visible black flash/flicker. Patch it to overwrite frames in place.
  patchInkFullScreen(nm)

  // Ink composites the frame into a cell grid in Output.get() but discards it
  // after serialization. Patch it to expose the grid and bake a mouse-selection
  // highlight (inverse SGR) onto the selected cells BEFORE serialization, so the
  // transcript keeps its real markdown/rail/colors and only the selected cells
  // are inverted (an in-place highlight).
  patchInkFrameController(nm)

  // Ink's Output.write decides a glyph's column count from ansi-tokenize's
  // `fullWidth` flag OR a surrogate-pair length heuristic. BMP emoji that the
  // terminal draws two columns wide (✅ ❌ ⚡ …) are single codepoints with
  // fullWidth=false, so Ink places them at ONE grid column: every later cell of
  // that row (text AND the sidebar border columns) is emitted one column right,
  // overflowing the terminal width and kinking the vertical border. Judge width
  // from string-width — the same source Ink's layout/serialization uses — so the
  // cell grid agrees with the terminal.
  patchInkWideChar(nm)

  // The width of a glyph on the terminal depends on the terminal's text font
  // and its emoji fallback — EAW-W emoji (✅ ❌ ⚡) are wide everywhere, but an
  // EAW=N symbol such as ⚠ can be drawn WIDE by an emoji-font terminal while ✓
  // ✗ ☑ ⚙ next to it stay NARROW, and that mix is per-font, not per-table. The
  // durable fix is to MEASURE each glyph on the real terminal (CPR, ESC[6n)
  // instead of guessing: the shared string-width module keeps upstream EAW
  // semantics and reads runtime-measured overrides from
  // globalThis.__dshCharWidths, so measure, wrap, grid placement and row-height
  // estimates all agree with the actual rendering.
  patchStringWidthEmojiBlocks(nm)

  const link = (name, dir) => {
    const target = join(nm, ...name.split('/')) // @scope/name -> node_modules/@scope/name
    mkdirSync(dirname(target), { recursive: true })
    if (NATIVE_PACKAGES.has(name)) {
      const custom = NATIVE_STUB_SOURCE[name]
      if (custom !== undefined) {
        // A package-specific stub (the generic proxy does not export the names
        // its callers import, and esbuild would fail on a missing export).
        const dir = join(ROOT, 'apps/tui-bin/stub-native', `pkg-${name.replace(/[^A-Za-z0-9_-]/g, '_')}`)
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }, null, 2))
        writeFileSync(join(dir, 'index.js'), custom)
        symlinkSync(dir, target, 'dir')
      } else {
        symlinkSync(STUB_DIR, target, 'dir')
      }
      console.log(`dsh-tui: stubbed native ${name}`)
    } else {
      symlinkSync(dir, target, 'dir')
    }
  }

  // Rebuild our @deepseek-ai / @yourname overrides on top of the mirrored
  // store so the transformed (createRequire-inlined) packages win. Every
  // package is copied to `x/` (not symlinked to its real dir) so an import
  // never walks up into the harness's own node_modules store, which would
  // resolve real, untransformed packages transitively.
  rmSync(join(nm, '@deepseek-ai'), { recursive: true, force: true })
  for (const [name, dir] of scanPackages()) {
    link(name, transformPackageCopy(name, dir))
  }
  link('@yourname/dsh-tui-app', join(ROOT, 'packages/dsh-tui-app'))

  // Two native-addon stubs live under the harness's `native/` tree, which
  // scanPackages() does not walk, so the link loop above never re-created them
  // (the `rmSync(@deepseek-ai)` drop wiped the mirror's copy). Install them
  // explicitly so the un-stubbed `dsh-sandbox-local` / `session-persistence-jsonl`
  // bundles can import them. Both are installed unconditionally: which one the
  // build actually imports depends on the harness version the gate let through
  // (≤0.1.2-rc.1 imports `node-addon-landlock-run`; ≥0.1.5 imports the
  // `node-addon-system` subpaths), and an unused stub directory is inert.
  // The landlock stub reports `unusable`, pushing the Linux sandbox to bwrap.
  {
    const stubName = '@deepseek-ai/node-addon-landlock-run'
    const stubSrc = NATIVE_STUB_SOURCE[stubName]
    if (stubSrc !== undefined) {
      const dir = join(ROOT, 'apps/tui-bin/stub-native', 'pkg-node-addon-landlock-run')
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: stubName, type: 'module', main: 'index.js' }, null, 2))
      writeFileSync(join(dir, 'index.js'), stubSrc)
      const target = join(nm, ...stubName.split('/'))
      rmSync(target, { recursive: true, force: true })
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(dir, target, 'dir')
      console.log('dsh-tui: stubbed native ' + stubName)
    }
  }
  for (const [stubName, subpaths] of Object.entries(NATIVE_SUBPATH_STUB_SOURCE)) {
    const dir = join(ROOT, 'apps/tui-bin/stub-native', `pkg-${stubName.replace(/[^A-Za-z0-9_-]/g, '_')}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const exportsMap = { '.': './index.js' }
    for (const [subpath, source] of Object.entries(subpaths)) {
      const file = `${subpath.slice(2)}.js`
      writeFileSync(join(dir, file), source)
      exportsMap[subpath] = `./${file}`
    }
    writeFileSync(join(dir, 'index.js'), 'export {}\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: stubName, type: 'module', exports: exportsMap }, null, 2))
    const target = join(nm, ...stubName.split('/'))
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(dir, target, 'dir')
    console.log(`dsh-tui: stubbed native ${stubName} (${Object.keys(subpaths).join(', ')})`)
  }

  // On Windows, pnpm creates directory symlinks with relative targets (e.g.
  // `..\..\..\node_modules\.pnpm\...`) that `realpath`/`stat` cannot traverse
  // (EPERM), which breaks Bun's module resolution (its resolver canonicalizes
  // paths through realpath). Convert them to absolute-target junctions — the
  // native, no-admin link type whose realpath works — before bundling. POSIX
  // symlinks have no such problem, so this step is Windows-only.
  if (process.platform === 'win32') {
    const fixShadowLinks = (base) => {
      if (!existsSync(base)) return
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) continue
        const linkPath = join(base, entry.name)
        const resolved = resolve(dirname(linkPath), readlinkSync(linkPath))
        if (!existsSync(resolved)) continue
        rmSync(linkPath, { recursive: true, force: true })
        mkdirSync(dirname(linkPath), { recursive: true })
        symlinkSync(resolved, linkPath, 'junction')
      }
    }
    fixShadowLinks(join(ROOT, 'apps/tui-bin/node_modules/@yourname'))
    fixShadowLinks(join(ROOT, 'packages/dsh-tui-app/node_modules'))
  }

  // Bun gaps in the Node builtins the bundled harness uses (see the function).
  patchBunNodeUtilGaps()
  patchBunSeaWorkerEntries()
  patchBunSeaWorkflowWorker()
}

/**
 * Patch the BUNDLED COPIES of harness packages for Node builtins Bun does not
 * implement.
 *
 * `@deepseek-ai/dsh-subprocess-local` statically imports `getSystemErrorMessage`
 * from `node:util` (Node ≥ 22.10). Bun 1.3.14 exports `getSystemErrorName` but
 * NOT `getSystemErrorMessage`, and a missing named export of a builtin fails the
 * whole single-file bundle at LOAD time — the binary died with
 * `SyntaxError: Export named 'getSystemErrorMessage' not found in module
 * 'node:util'` before printing even `--version`. The name only feeds one
 * diagnostic string, so the fix is to drop it from the import and define a local
 * fallback that degrades to the errno's symbolic name.
 *
 * This edits `apps/tui-bin/x/**` (our transform of the harness's compiled
 * `lib/`), never the harness checkout — the same rule as the Ink patches.
 */
function patchBunNodeUtilGaps() {
  const farm = join(ROOT, 'apps/tui-bin/x')
  if (!existsSync(farm)) return
  const files = []
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (entry.name.endsWith('.js')) files.push(path)
    }
  }
  collect(farm)
  let patched = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('getSystemErrorMessage')) continue
    let next = text.replace(
      /import\s*\{([^}]*)\}\s*from\s*(["'])node:util\2;?/g,
      (match, names) => {
        const kept = String(names)
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '' && name !== 'getSystemErrorMessage')
        return kept.length > 0 ? `import { ${kept.join(', ')} } from "node:util";` : ''
      },
    )
    if (!next.includes('const getSystemErrorMessage')) {
      // The try/catch also swallows a missing `getSystemErrorName` binding, so a
      // file that imported only the absent name still degrades gracefully.
      next += '\nconst getSystemErrorMessage = (uvError) => {\n'
        + '  try { return String(getSystemErrorName(uvError)).toLowerCase() } catch { return `error ${uvError}` }\n'
        + '}\n'
    }
    writeFileSync(file, next)
    patched += 1
  }
  if (patched > 0) console.log(`dsh-tui: patched Bun node:util gaps in ${patched} bundled file(s)`)
}

/**
 * Run the JSONL migration verifier in-process instead of in a Worker Thread.
 *
 * Harness 0.1.5 verifies a migrated or competing current generation through
 * `new Worker(new URL('./worker.cjs', import.meta.url))`
 * (`session-persistence-jsonl/src/migration-verifier.ts:77`). Inside a Bun
 * single-file executable that URL resolves to `/$bunfs/root/worker.cjs`, which
 * is not part of the blob, so a **read open of any historical (v0/v1/v2) log**
 * failed with
 * `stored log is corrupt: Error: BuildMessage: ModuleNotFound resolving
 *  "/$bunfs/root/worker.cjs" (entry point)`
 * — the host could not attach a legacy session at all, while the transcript was
 * already on screen from the file reader.
 *
 * The worker is a thin wrapper around `verifyJsonlCurrentGeneration`, which the
 * same bundled file already exposes as `defaultGenerationRuntime.verify`; the
 * patch replaces `runVerificationWorker`'s body with that inline call, so the
 * SAME code, validation and failure surface run, just not on a second thread.
 * The harness itself replaces this worker's sibling native addon (`/flock`) the
 * same way for single-process runtimes — see the `node-addon-system` stub.
 *
 * Applied to `apps/tui-bin/x/**` (our transform of the harness's compiled
 * `lib/`), never to the harness checkout.
 */
function patchBunSeaWorkerEntries() {
  const farm = join(ROOT, 'apps/tui-bin/x')
  if (!existsSync(farm)) return
  const files = []
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (entry.name.endsWith('.js')) files.push(path)
    }
  }
  collect(farm)
  let patched = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('worker.cjs')) continue
    const start = text.indexOf('function runVerificationWorker(')
    if (start < 0) continue
    // The compiled file is pretty-printed with one top-level function per
    // block, so the next top-level `function` keyword bounds this one; the
    // JSDoc that follows belongs to the NEXT symbol and is left in place.
    let end = -1
    for (const marker of ['\nfunction ', '\nasync function ']) {
      const at = text.indexOf(marker, start)
      if (at >= 0 && (end < 0 || at < end)) end = at
    }
    if (end < 0) continue
    const replacement = [
      'function runVerificationWorker(path, compression, expectedId, expectedEventCount, expectedPrefix, signal) {',
      '\tsignal?.throwIfAborted();',
      '\t/* dsh-tui patch: verify in-process; the SEA has no worker entry (see build.mjs). */',
      '\treturn defaultGenerationRuntime.verify(path, compression, expectedId, expectedEventCount, expectedPrefix);',
      '}',
      '',
    ].join('\n')
    writeFileSync(file, text.slice(0, start) + replacement + text.slice(end + 1))
    patched += 1
  }
  if (patched > 0) console.log(`dsh-tui: patched Bun SEA worker entry in ${patched} bundled file(s)`)
}

/** Symlink every entry of the harness virtual-store `node_modules` we don't own. */
function mirrorHarnessStore(nm) {
  const store = join(HARNESS, 'node_modules/.pnpm/node_modules')
  if (!existsSync(store)) return
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (entry.name === '@deepseek-ai') continue
    const target = join(nm, entry.name)
    if (existsSync(target)) continue
    try {
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(join(store, entry.name), target, 'dir')
    } catch { /* a broken/odd entry is inert until imported */ }
  }
}

/**
 * Ink loads `yoga.wasm` at module scope via
 * `readFile(createRequire(import.meta.url).resolve("./yoga.wasm"))`. A single
 * file cannot resolve that read, so inline the wasm as base64 into every
 * `dist/node.js`. Bun resolves yoga from inside Ink's own `.pnpm` subtree, so
 * the store copy must be rewritten (this repo's store, not the harness).
 */
function patchInkYoga(nm) {
  const dirs = readdirSync(join(nm, '.pnpm')).filter((d) => d.startsWith('yoga-wasm-web@'))
  for (const dir of dirs) {
    const nodeJs = join(nm, '.pnpm', dir, 'node_modules', 'yoga-wasm-web', 'dist', 'node.js')
    const wasm = join(nm, '.pnpm', dir, 'node_modules', 'yoga-wasm-web', 'dist', 'yoga.wasm')
    if (!existsSync(nodeJs) || !existsSync(wasm)) continue
    const b64 = readFileSync(wasm).toString('base64')
    const text = readFileSync(nodeJs, 'utf8')
    const rewritten = text.replace(
      /await E\(_\(import\.meta\.url\)\.resolve\("\.\/yoga\.wasm"\)\)/,
      `Buffer.from(${JSON.stringify(b64)}, "base64")`,
    )
    if (rewritten !== text) writeFileSync(nodeJs, rewritten)
  }
}

/**
 * Patch Ink's full-screen render path so a full-height frame is overwritten in
 * place (absolute positioning + per-line erase + write) instead of clearing the
 * whole terminal first. Ink's `onRender` falls back to `ansiEscapes.clearTerminal`
 * (`\x1b[2J\x1b[3J\x1b[H`) whenever `outputHeight >= stdout.rows` — i.e. on
 * EVERY render of a full-screen app like this TUI — and macOS Terminal.app
 * repaints that as a visible black flash/flicker. The content never exceeds the
 * terminal height here (the root layout is `height=rows` and content clips), so
 * overwriting in place is always safe.
 *
 * Two further behaviors ride on the same patch:
 *  - line-level diffing: only lines whose text changed are erased and rewritten,
 *    so a keystroke in the composer repaints just the composer region instead of
 *    the whole screen (Terminal.app is slow at repainting CJK glyphs);
 *  - a per-frame suffix hook (`globalThis.__dshTuiFrameSuffix`): the app uses it
 *    to park the REAL terminal cursor at the composer caret after every frame,
 *    because the macOS IME composition/candidate window anchors to that cursor —
 *    a hidden or wandering cursor makes the candidate window jump on every
 *    redraw while typing Chinese.
 * A third behavior rides on the same patch: **theme-background fill**. Ink paints
 * text/border glyph cells without a background color, so a full-screen space
 * layer in `theme.bg` still leaves glyph cells showing the terminal's default
 * background (two-tone after a colorscheme switch). The frame writer rewrites
 * each changed line so every glyph cell carries the current theme background
 * (`globalThis.__dshTuiBgColor`, mirrored from the shared palette by
 * `src/theme.ts`); inverse spans (text selection) keep the terminal's default
 * inversion so their contrast is unaffected.
 * Upgrade-safe (replaces any previous helper version) and fails loudly if Ink's
 * internals move so the patch is never silently skipped.
 * @param nm - the resolve-farm `node_modules` root.
 */
export function patchInkFullScreen(nm) {
  const dirs = readdirSync(join(nm, '.pnpm')).filter((d) => d.startsWith('ink@'))
  if (dirs.length === 0) {
    throw new Error('dsh-tui: no ink package found in the resolve farm to patch')
  }
  const anchor = "import App from './components/App.js';"
  const helperStart = '// dsh-tui patch: overwrite full-screen frames in place'
  const helperEnd = 'const isCi ='
  const helper = `// dsh-tui patch: overwrite full-screen frames in place (no clearTerminal flash),
// rewriting only the lines that changed (line-level diff), so a keystroke in the
// composer repaints just the composer instead of the whole screen. A per-frame
// suffix hook lets the app park the real terminal cursor at the composer caret -
// the macOS IME composition/candidate window anchors to that position instead of
// jumping around.
// Theme fill: Ink paints text/border glyph cells without a background, and
// uncolored text relies on the terminal's default foreground - invisible when a
// light scheme paints a white background. __dshForceBg rewrites each changed line
// so every glyph cell carries the current theme background and, where Ink left
// the foreground unset, the theme text color (globalThis.__dshTuiBgColor and
// __dshTuiTextColor, mirrored by src/theme.ts). Inverse spans (selection) keep
// the terminal's default inversion for contrast.
const __dshSgrRe = /\\x1b\\[([0-9;]*)m/g;
// The SGR flavor for the forced glyph paint must match the color level Ink's
// own chalk colorization uses on THIS terminal, or the painted glyph cells
// disagree with the surrounding page (Apple Terminal.app ignores 38;2/48;2 and
// repaints those glyphs with its palette/default — the mismatched
// under-character blocks). Reuse chalk's auto-detected level with the same
// conversion chain (24-bit -> 256 cube/grey -> 16-color): level 3 emits
// truecolor, level 2 256-color, level 1 16-color, level 0 nothing.
import chalk from 'chalk';
const __dshRgb = (hex) => {
    if (typeof hex !== 'string') return null;
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255), ((n >> 8) & 255), (n & 255)];
};
// rgbToAnsi256: nearest color in the 6x6x6 cube + grey ramp (color-convert).
const __dshRgbToAnsi256 = (r, g, b) => {
    if (r === g && g === b) {
        if (r < 8) return 16;
        if (r > 248) return 231;
        return Math.round(((r - 8) / 247) * 24) + 232;
    }
    return 16
        + (36 * Math.round(r / 255 * 5))
        + (6 * Math.round(g / 255 * 5))
        + Math.round(b / 255 * 5);
};
// ansi256ToAnsi: fold a 256-color code to the nearest 16-color one.
const __dshAnsi256ToAnsi = (code) => {
    if (code < 8) return 30 + code;
    if (code < 16) return 90 + (code - 8);
    let red, green, blue;
    if (code >= 232) { red = (((code - 232) * 10) + 8) / 255; green = red; blue = red; }
    else { code -= 16; const remainder = code % 36; red = Math.floor(code / 36) / 5; green = Math.floor(remainder / 6) / 5; blue = (remainder % 6) / 5; }
    const value = Math.max(red, green, blue) * 2;
    if (value === 0) return 30;
    let result = 30 + ((Math.round(blue) << 2) | (Math.round(green) << 1) | Math.round(red));
    if (value === 2) result += 60;
    return result;
};
// Colour-depth override (DSH_TUI_COLOR): the table is a deliberate DUPLICATE of
// colorOverride() in packages/dsh-tui-app/src/color-depth.ts, and it lives here
// because this is the copy that owns Ink's chalk instance — the palette decision
// happens in a separate plugin bundle, and forcing only there left chalk at level
// 2, rendering the unmapped hexes back into the collapse the override exists to
// escape (measured: page #000000, card #5f5f5f). tests/color-depth.test.ts
// extracts this snippet and fails if the two tables drift.
const __dshColorOverride = (env) => {
    const v = String((env && env.DSH_TUI_COLOR) || '').trim().toLowerCase();
    if (v === '24bit' || v === 'truecolor') return 3;
    if (v === '256') return 2;
    if (v === '16') return 1;
    return null;
};
const __dshLevel = () => {
    const forced = __dshColorOverride(typeof process !== 'undefined' ? process.env : null);
    if (forced !== null && chalk.level !== forced) chalk.level = forced;
    return (typeof chalk !== 'undefined' && typeof chalk.level === 'number') ? chalk.level : 0;
};
const __dshBgSeq = (hex) => {
    const rgb = __dshRgb(hex);
    if (!rgb) return '';
    const level = __dshLevel();
    if (level >= 3) return '\\x1b[48;2;' + rgb.join(';') + 'm';
    const code = __dshRgbToAnsi256(rgb[0], rgb[1], rgb[2]);
    if (level === 2) return '\\x1b[48;5;' + code + 'm';
    if (level === 1) return '\\x1b[' + (__dshAnsi256ToAnsi(code) + 10) + 'm';
    return '';
};
const __dshFgSeq = (hex) => {
    const rgb = __dshRgb(hex);
    if (!rgb) return '';
    const level = __dshLevel();
    if (level >= 3) return '\\x1b[38;2;' + rgb.join(';') + 'm';
    const code = __dshRgbToAnsi256(rgb[0], rgb[1], rgb[2]);
    if (level === 2) return '\\x1b[38;5;' + code + 'm';
    if (level === 1) return '\\x1b[' + __dshAnsi256ToAnsi(code) + 'm';
    return '';
};
const __dshLineHex = (key) => (typeof globalThis[key] === 'string' && globalThis[key]) || null;
const __dshForceBg = (line, bgHex, fgHex) => {
    const bgCode = bgHex ? __dshBgSeq(bgHex) : '';
    const fgCode = fgHex ? __dshFgSeq(fgHex) : '';
    let out = '';
    let last = 0;
    let bgOn = false;
    let fgOn = false;
    let inverse = false;
    __dshSgrRe.lastIndex = 0;
    for (let m; (m = __dshSgrRe.exec(line)) !== null;) {
        const seg = line.slice(last, m.index);
        if (seg.length > 0) {
            if (fgHex && !fgOn && !inverse) { out += fgCode; fgOn = true; }
            if (bgHex && !bgOn && !inverse) { out += bgCode; bgOn = true; }
        }
        out += seg;
        const p = m[1] === '' ? ['0'] : m[1].split(';');
        let i = 0;
        while (i < p.length) {
            const c = p[i];
            if (c === '0') { bgOn = false; fgOn = false; inverse = false; i++; }
            else if (c === '39') { fgOn = false; i++; }
            else if (c === '49') { bgOn = false; i++; }
            else if (c === '7') { inverse = true; i++; }
            else if (c === '27') { inverse = false; i++; }
            else if (c === '38') { if (p[i + 1] === '5') { fgOn = true; i += 3; } else if (p[i + 1] === '2') { fgOn = true; i += 5; } else i++; }
            else if (c === '48') { if (p[i + 1] === '5') { bgOn = true; i += 3; } else if (p[i + 1] === '2') { bgOn = true; i += 5; } else i++; }
            else i++;
        }
        out += m[0];
        last = m.index + m[0].length;
    }
    const tail = line.slice(last);
    if (tail.length > 0) {
        if (fgHex && !fgOn && !inverse) out += fgCode;
        if (bgHex && !bgOn && !inverse) out += bgCode;
    }
    out += tail;
    return out;
};
// Enter the alternate screen WITH the first frame. Entering it at boot instead
// left the terminal blank until Ink painted (~0.6 s), which reads as a flash of
// emptiness before the hero; this way the user's shell stays visible until the
// hero appears in one write. Idempotent, and shared by both frame paths (the
// CPR calibration lock can buffer the first frame into the flush below).
const __dshEnterAlt = () => {
    if (writeFullScreenFrame._alt === true) return '';
    writeFullScreenFrame._alt = true;
    return '\\x1b[?1049h\\x1b[2J\\x1b[H';
};
// The ONE write path for every full-screen frame. The exit phase installs
// __dshTuiSyncFrameWriter, and honouring it here — rather than only in the Ink
// render path — keeps "every frame painted during exit is written synchronously"
// true for the calibration flush and the watchdog repaint as well: either of them
// painting a frame during exit would otherwise still be a QUEUED stdout write on a
// Windows TTY (or a POSIX pipe) and could be overtaken by the synchronous leave,
// landing as residue on the restored normal screen.
const __dshWriteFrame = (stdout, frame) => {
    const syncWrite = typeof globalThis !== 'undefined' ? globalThis.__dshTuiSyncFrameWriter : undefined;
    if (typeof syncWrite === 'function') {
        try { syncWrite(frame); return; } catch { /* fall through to the queued write */ }
    }
    stdout.write(frame);
};
// Whether a frame carries any visible text (background fills and SGR-only rows
// do not count). Used to hold back the first, empty frames — see below.
const __dshFrameHasText = (lines) => {
    for (const line of lines) {
        if (line.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, '').trim() !== '') return true;
    }
    return false;
};
const writeFullScreenFrame = (stdout, output) => {
    const lines = output.split('\\n');
    // CPR glyph-width calibration window: while the app measures a glyph's real
    // terminal width (ESC[6n round trips on the bottom row), frames must NOT
    // overwrite the probe row mid-measurement. Buffer the latest frame and write
    // it once calibration unlocks (__dshCalibrationFlush).
    if (typeof globalThis !== 'undefined' && globalThis.__dshCalibrationLock) {
        writeFullScreenFrame._pending = lines;
        return;
    }
    // Before the alternate screen is entered, hold back frames with no content:
    // the app's first frames are background fills only, and painting one on the
    // NORMAL screen would wipe the user's shell, while entering the alternate
    // screen for it would leave a blank screen until the hero arrives (~0.4 s —
    // the flash the user reported). The entry therefore rides the first frame
    // that actually has something to show, and the shell stays visible until
    // then. Deliberately before the liveness stamp too: nothing was flushed, and
    // the boot splash uses that stamp to decide whether to speak up.
    if (writeFullScreenFrame._alt !== true && !__dshFrameHasText(lines)) return;
    // Watchdog liveness: record the wall-clock every time Ink hands us a frame,
    // so the app can tell a stalled render loop from a quiet-but-alive screen
    // (see __dshTuiRepaintLastFrame below).
    if (typeof globalThis !== 'undefined') globalThis.__dshTuiLastFlushAt = Date.now();
    const prev = writeFullScreenFrame._prev;
    const bgHex = __dshLineHex('__dshTuiBgColor');
    const fgHex = __dshLineHex('__dshTuiTextColor');
    const paint = (line) => (bgHex || fgHex) ? __dshForceBg(line, bgHex, fgHex) : line;
    const changedLines = [];
    let frame = __dshEnterAlt();
    if (prev === undefined || prev.length !== lines.length) {
        // first frame or a resize: rewrite every line
        for (let i = 0; i < lines.length; i++) {
            changedLines.push(lines[i]);
            frame += '\\x1b[' + (i + 1) + ';1H\\x1b[2K' + paint(lines[i]);
        }
        if (lines.length > 0) frame += (bgHex ? __dshBgSeq(bgHex) : '') + '\\x1b[0J'; // clear residue below (shrink)
    } else {
        for (let i = 0; i < lines.length; i++) {
            if (prev[i] === lines[i]) continue;
            changedLines.push(lines[i]);
            frame += '\\x1b[' + (i + 1) + ';1H\\x1b[2K' + paint(lines[i]);
        }
    }
    writeFullScreenFrame._prev = lines;
    const suffix = typeof globalThis.__dshTuiFrameSuffix === 'function' ? globalThis.__dshTuiFrameSuffix() : '';
    if (suffix) frame += suffix;
    if (frame !== '') __dshWriteFrame(stdout, frame);
    if (typeof globalThis !== 'undefined' && typeof globalThis.__dshCharScan === 'function' && changedLines.length > 0) {
        globalThis.__dshCharScan(changedLines);
    }
};
// Flush a frame buffered while the CPR calibration window was locked.
globalThis.__dshCalibrationFlush = () => {
    const pending = writeFullScreenFrame._pending;
    if (!pending || pending.length === 0) return;
    writeFullScreenFrame._pending = undefined;
    if (writeFullScreenFrame._alt !== true && !__dshFrameHasText(pending)) return;
    const bgHex = __dshLineHex('__dshTuiBgColor');
    const fgHex = __dshLineHex('__dshTuiTextColor');
    const paint = (line) => (bgHex || fgHex) ? __dshForceBg(line, bgHex, fgHex) : line;
    let frame = __dshEnterAlt();
    for (let i = 0; i < pending.length; i++) frame += '\\x1b[' + (i + 1) + ';1H\\x1b[2K' + paint(pending[i]);
    if (pending.length > 0) frame += (bgHex ? __dshBgSeq(bgHex) : '') + '\\x1b[0J';
    const suffix = typeof globalThis.__dshTuiFrameSuffix === 'function' ? globalThis.__dshTuiFrameSuffix() : '';
    if (suffix) frame += suffix;
    if (frame !== '') __dshWriteFrame(process.stdout, frame);
    writeFullScreenFrame._prev = pending;
    if (typeof globalThis !== 'undefined') globalThis.__dshTuiLastFlushAt = Date.now();
    if (typeof globalThis !== 'undefined' && typeof globalThis.__dshCharScan === 'function') {
        globalThis.__dshCharScan(pending);
    }
};
// Watchdog self-heal: the app calls this when its liveness check decides the
// render loop has stopped flushing frames while the agent is running. Ink's own
// render may be wedged (it would then never call writeFullScreenFrame again),
// so this bypasses Ink entirely: rewrite the last known frame straight to
// stdout. The per-frame suffix (cursor parking) rides along as usual.
globalThis.__dshTuiRepaintLastFrame = () => {
    const prevLines = writeFullScreenFrame._prev;
    if (!prevLines || prevLines.length === 0) return;
    const bgHex = __dshLineHex('__dshTuiBgColor');
    const fgHex = __dshLineHex('__dshTuiTextColor');
    const paint = (line) => (bgHex || fgHex) ? __dshForceBg(line, bgHex, fgHex) : line;
    let frame = '';
    for (let i = 0; i < prevLines.length; i++) frame += '\\x1b[' + (i + 1) + ';1H\\x1b[2K' + paint(prevLines[i]);
    if (prevLines.length > 0) frame += (bgHex ? __dshBgSeq(bgHex) : '') + '\\x1b[0J';
    const suffix = typeof globalThis.__dshTuiFrameSuffix === 'function' ? globalThis.__dshTuiFrameSuffix() : '';
    if (suffix) frame += suffix;
    if (frame !== '') __dshWriteFrame(process.stdout, frame);
    if (typeof globalThis !== 'undefined') globalThis.__dshTuiLastFlushAt = Date.now();
};
`
  const branchRe = /if \(outputHeight >= this\.options\.stdout\.rows\) \{\s*this\.options\.stdout\.write\(ansiEscapes\.clearTerminal \+ this\.fullStaticOutput \+ output\);/
  const branchNew = 'if (outputHeight >= this.options.stdout.rows) {\n                    writeFullScreenFrame(this.options.stdout, output);'
  for (const dir of dirs) {
    const inkJs = join(nm, '.pnpm', dir, 'node_modules', 'ink', 'build', 'ink.js')
    if (!existsSync(inkJs)) continue
    let text = readFileSync(inkJs, 'utf8')
    if (!text.includes(anchor)) {
      throw new Error(`dsh-tui: cannot patch Ink (import anchor missing in ${inkJs})`)
    }
    let changed = false
    // (Re)install the helper block: replace any previous version between the
    // marker comment and the following `const isCi` declaration.
    const s = text.indexOf(helperStart)
    const e = text.indexOf(helperEnd)
    if (s !== -1 && e !== -1 && e > s) {
      const next = text.slice(0, s) + helper + text.slice(e)
      if (next !== text) { text = next; changed = true }
    } else if (s === -1 && e !== -1) {
      const next = text.replace(anchor, anchor + helper)
      if (next !== text) { text = next; changed = true }
    } else {
      throw new Error(`dsh-tui: cannot locate the Ink patch insertion point in ${inkJs} (Ink internals changed?)`)
    }
    if (branchRe.test(text)) {
      text = text.replace(branchRe, branchNew)
      changed = true
    } else if (!text.includes('writeFullScreenFrame(this.options.stdout, output);')) {
      throw new Error(`dsh-tui: cannot patch Ink onRender branch in ${inkJs} (Ink internals changed?)`)
    }
    if (changed) {
      writeFileSync(inkJs, text)
      console.log(`dsh-tui: patched Ink full-screen render path (${dir})`)
    }
  }
}

/** Ink composites every frame into a cell grid in Output.get() (each cell
 *  { value, fullWidth, styles }) but discards the grid after serialization and
 *  never exposes it. Patch it so dsh-tui can (a) read the composited grid
 *  (`cells: output`) and (b) bake a mouse-selection highlight onto the exact
 *  selected cells BEFORE serialization — inverse SGR (7/27), which stacks over
 *  any existing fg/bg without stripping it, so code/panel/diff backgrounds and
 *  the text colors survive and only the selected region is inverted. This is an
 *  in-place highlight that a React-level flat-text view cannot do.
 *  The app drives it via `globalThis.__dshFrameController = { selection, bg }`. */
export function patchInkFrameController(nm) {
  const dirs = readdirSync(join(nm, '.pnpm')).filter((d) => d.startsWith('ink@'))
  if (dirs.length === 0) {
    throw new Error('dsh-tui: no ink package found to patch (frame controller)')
  }
  const marker = '// dsh-tui patch: bake a selection highlight'
  const anchor = '        const generatedOutput = output'
  const injection = `// dsh-tui patch: bake a selection highlight onto the composited cell grid
    // BEFORE serialization (keeps every cell's own styles; only the selected
    // cells gain a highlight). Read from globalThis.__dshFrameController. Each
    // selected cell gets a NEW styles array (never mutate in place: a shared
    // StyledChar could render elsewhere on screen, and in-place mutation would
    // leak the highlight onto that identical text).
    const __fc = (typeof globalThis !== 'undefined' && globalThis.__dshFrameController) ? globalThis.__dshFrameController : null;
    const __dshSel = __fc ? __fc.selection : null;
    if (__fc) __fc.copiedText = '';
    if (__dshSel) {
        // Inverse (SGR 7/27) rather than a background override: a cell may already
        // carry a background (code/panel/diff), and a later-applied bg would be
        // shadowed by it. Inverse is orthogonal to fg/bg and never strips styles.
        const __code = '\\x1b[7m';
        const __end = '\\x1b[27m';
        // Markdown/terminal DECORATION characters (box-drawing + the user ┃ rail)
        // must not enter the copy or the highlight: a code block / table / blockquote
        // borders (│ ╭ ╮ ╰ ╯ ─ …) and the user rail ┃ are chrome, not the text the
        // user wants (some clients exclude these via selectable metadata; we use a
        // box-drawing-range heuristic). Skips them so e.g. copying a code block yields
        // the code, not its border box.
        const __deco = /^[\\u2500-\\u257F]$/;
        const __invAppend = (cell, line) => { if (!cell || cell.type !== 'char' || cell.value === '' || cell.value == null || cell.styles.some((s) => s.code === __code) || __deco.test(cell.value)) return; cell.styles = [...cell.styles, { type: 'ansi', code: __code, endCode: __end }]; line.v += cell.value; };
        // LINE/FLOW selection: walk from the anchor cell to the
        // focus cell following the text flow. Highlighting + copying both use the
        // SAME flow, so a drag from the start of a line into the middle of the next
        // highlights (and copies) the whole first line + that prefix — NOT a
        // column-aligned box. Falls back to a rectangle when endpoints are absent.
        const __a = __fc.anchor, __f = __fc.focus;
        let __txt = '';
        const __rect = () => { const inv = (cell) => { if (!cell || cell.type !== 'char' || cell.value === '' || cell.value == null || cell.styles.some((s) => s.code === __code)) return; cell.styles = [...cell.styles, { type: 'ansi', code: __code, endCode: __end }]; }; let t = ''; for (let y = __dshSel.y1; y <= __dshSel.y2; y++) { const row = output[y]; if (!row) continue; let l = ''; for (let x = __dshSel.x1; x <= __dshSel.x2; x++) { const cell = row[x]; if (!cell || __deco.test(cell.value)) continue; inv(cell); l += cell.value; } t += l.replace(/\\s+$/, '') + '\\n'; } return t.replace(/\\n+$/, ''); };
        if (__a && __f && typeof __a.row === 'number' && typeof __f.row === 'number') {
            const ar = __a.row - 1, ac = __a.col - 1, fr = __f.row - 1, fc2 = __f.col - 1;
            let sR = ar, sC = ac, eR = fr, eC = fc2;
            if (ar > fr || (ar === fr && ac > fc2)) { sR = fr; sC = fc2; eR = ar; eC = ac; }
            const C = (typeof __fc.contentLeft === 'number' && __fc.contentLeft >= 0) ? __fc.contentLeft : 4; // grid content column: message column (paddingX 1 + MESSAGE_LEFT_COLS 3) or the Steps sidebar's own band
            const rEnd = (y) => { const row = output[y]; if (!row) return C; const bound = (typeof __fc.contentRight === 'number' && __fc.contentRight > C) ? __fc.contentRight : (row.length - 1); let e = C; for (let x = C; x <= Math.min(bound, row.length - 1); x++) { const c = row[x]; if (c && c.value !== '' && c.value != null && !/^\\s*$/.test(c.value) && !__deco.test(c.value)) e = x; } return e; };
            for (let y = sR; y <= eR; y++) {
                const row = output[y]; if (!row) { __txt += '\\n'; continue; }
                // Clamp the per-row cell range to the CONTENT column [C .. content end]
                // so neither the highlight nor the copy reaches past the text into the
                // right-side padding/margin (the trailing blank the user wants to skip).
                const end = rEnd(y);
                const from = (y === sR) ? Math.max(C, Math.min(sC, end)) : C;
                const to = (y === eR) ? Math.min(eC, end) : end;
                const line = { v: '' };
                for (let x = from; x <= to; x++) { __invAppend(row[x], line); }
                __txt += line.v.replace(/\\s+$/, '') + '\\n';
            }
            __fc.copiedText = __txt.replace(/\\n+$/, '');
        } else {
            __fc.copiedText = __rect();
        }
    }
    `
  for (const dir of dirs) {
    const outputJs = join(nm, '.pnpm', dir, 'node_modules', 'ink', 'build', 'output.js')
    if (!existsSync(outputJs)) continue
    let text = readFileSync(outputJs, 'utf8')
    if (!text.includes(anchor)) {
      throw new Error(`dsh-tui: cannot patch Ink output.js (anchor missing) in ${outputJs}`)
    }
    let changed = false
    const s = text.indexOf(marker)
    const a = text.indexOf(anchor)
    if (s !== -1 && a !== -1 && a > s) {
      // Already patched: replace the previous injection (marker..anchor) in place.
      const next = text.slice(0, s) + injection + text.slice(a)
      if (next !== text) { text = next; changed = true }
    } else {
      const next = text.replace(anchor, injection + anchor)
      if (next !== text) { text = next; changed = true }
    }
    if (!text.includes('cells: output')) {
      text = text.replace('height: output.length\n        };', 'height: output.length,\n            cells: output\n        };')
      changed = true
    }
    if (changed) {
      writeFileSync(outputJs, text)
      console.log(`dsh-tui: patched Ink frame controller (${dir})`)
    }
  }
}

/**
 * Ink's Output.write advances one grid column for characters it does not
 * consider wide. Its original test — ansi-tokenize's `fullWidth` flag OR
 * `character.value.length > 1` — misses single-codepoint glyphs the terminal
 * draws two columns wide (✅ ❌ ⚡ … are one code point each, and after the
 * string-width emoji-block patch so is bare ⚠). Those glyphs then occupy one
 * grid cell while every later glyph of the row lands one real column right of
 * where Ink thinks it is: a row containing one serializes to `width + 1`
 * columns, the sidebar border columns shift right by one on that row
 * (broken/kinked vertical border), and the last column falls off the terminal
 * width.
 *
 * Judge width from string-width — the same source Ink's layout measure and
 * cell serialization use — so grid placement agrees with the terminal. One
 * refinement: when a widened base glyph is immediately followed by a variation
 * selector (⚠️ ☀️ ♥️ …), Ink receives the U+FE0F as its own zero-width token
 * and would place it in a THIRD cell, shifting the row back by one. Keep such
 * bases narrow so the VS16 cell itself supplies the glyph's second column (two
 * grid cells for a two-column glyph). Fails loudly if Ink's internals move so
 * the fix is never silently skipped.
 * @param nm - the resolve-farm `node_modules` root.
 */
export function patchInkWideChar(nm) {
  const dirs = readdirSync(join(nm, '.pnpm')).filter((d) => d.startsWith('ink@'))
  if (dirs.length === 0) {
    throw new Error('dsh-tui: no ink package found in the resolve farm to patch (wide char)')
  }
  const regionRe = /const characters = styledCharsFromTokens\(tokenize\(line\)\);[\s\S]*?offsetX \+= isWideCharacter \? 2 : 1;\n\s+}/
  const region = [
    'const characters = styledCharsFromTokens(tokenize(line));',
    '                    let offsetX = x;',
    '                    // dsh-tui patch: per-glyph width placement (see charwidth.ts).',
    '                    // A glyph the terminal PAINTS two columns wide but whose CURSOR advance',
    '                    // is only ONE column (⚠ / ⚠️ / 🏷️ … on VTE: wcwidth counts 1, the color-emoji',
    '                    // glyph paints 2) needs its reserved second cell to be a REAL space so',
    '                    // the cursor actually advances two columns — otherwise every later cell',
    '                    // of the row (the sidebar border included) prints one column LEFT.',
    '                    // ⚠️ / 🏷️ / ☀️ arrive as base + U+FE0F: keep the base narrow so the VS16 cell (a',
    '                    // space here) carries the glyph\'s second column; never a third cell.',
    "                    const __pw = (typeof globalThis !== 'undefined' && globalThis.__dshPaintWide instanceof Set) ? globalThis.__dshPaintWide : new Set([0x23f8, 0x2600, 0x26a0, 0x1f3f7, 0x1f6e0]);",
    "                    const __cw = (typeof globalThis !== 'undefined' && globalThis.__dshCharWidths instanceof Map) ? globalThis.__dshCharWidths : null;",
    '                    const __padFlags = [];',
    '                    for (let __i = 0; __i < characters.length; __i++) {',
    '                        const character = characters[__i];',
    '                        const __next = characters[__i + 1];',
    "                        const __cp = typeof character.value === 'string' ? character.value.codePointAt(0) : -1;",
    "                        const __isVS = character.type === 'char' && character.value === '\uFE0F';",
    '                        const __pad = __pw.has(__cp) && (__cw === null || __cw.get(__cp) === 1);',
    '                        __padFlags[__i] = __pad;',
    '                        if (__isVS && __padFlags[__i - 1]) {',
    "                            currentLine[offsetX] = { type: 'char', value: ' ', fullWidth: false, styles: character.styles };",
    '                            offsetX += 1;',
    '                            continue;',
    '                        }',
    '                        currentLine[offsetX] = character;',
    "                        const isWideCharacter = (stringWidth(character.value) > 1 || __pad) && !(__next && __next.type === 'char' && __next.value === '\uFE0F');",
    '                        if (isWideCharacter) {',
    "                            currentLine[offsetX + 1] = {",
    "                                type: 'char',",
    "                                value: __pad ? ' ' : '',",
    '                                fullWidth: false,',
    '                                styles: character.styles',
    '                            };',
    '                        }',
    '                        offsetX += isWideCharacter ? 2 : 1;',
    '                    }',
  ].join('\n')
  for (const dir of dirs) {
    const outputJs = join(nm, '.pnpm', dir, 'node_modules', 'ink', 'build', 'output.js')
    if (!existsSync(outputJs)) continue
    let text = readFileSync(outputJs, 'utf8')
    // Idempotent: skip only when the current fallback set is already in place
    // (a stale patch — e.g. a narrower PAINT_WIDE list — MUST be re-applied so
    // newly paint-wide glyphs get their reserved second cell too).
    if (text.includes('const __padFlags = [];') && text.includes('0x2600')) continue
    if (!regionRe.test(text)) {
      throw new Error(`dsh-tui: cannot patch Ink wide-char placement in ${outputJs} (Ink internals changed?)`)
    }
    writeFileSync(outputJs, text.replace(regionRe, region))
    console.log(`dsh-tui: patched Ink wide-char placement (${dir})`)
  }
}

/**
 * The single shared text-width oracle: Ink's layout measure (widest-line →
 * string-width), its grid placement in output.js (`stringWidth > 1`), clip/slice
 * logic and the app's own row-height estimates all import the same `string-width`
 * module. Replacing that module with the implementation below makes every layer
 * agree on every glyph's width.
 *
 * Semantics: upstream EAW by default (text dingbats such as ✓ ✗ ☑ ⚙ stay one
 * column — no per-glyph guess list, so nothing regresses on EAW terminals), plus
 * a runtime per-code-point override table (`globalThis.__dshCharWidths`) filled
 * by the CPR calibration probe (packages/dsh-tui-app/src/charwidth.ts). The
 * probe measures each glyph's REAL rendered width on the actual terminal+font
 * via `ESC[6n`, so a terminal that draws ⚠ two columns wide (color-emoji
 * fallback) is honoured while a terminal that draws it narrow is measured narrow
 * too — the divider cannot drift on any terminal. Residual U+FE0E/U+FE0F
 * variation selectors carry no column. The whole file is rewritten at build
 * time (idempotent; the patch owns this dependency copy).
 * @param nm - the resolve-farm `node_modules` root.
 */
export function patchStringWidthEmojiBlocks(nm) {
  const dirs = readdirSync(join(nm, '.pnpm')).filter((d) => d.startsWith('string-width@'))
  if (dirs.length === 0) {
    throw new Error('dsh-tui: no string-width package found in the resolve farm to patch (runtime calibration)')
  }
  const source = `// dsh-tui: runtime-calibrated string-width (replaced at build time).
// Upstream EAW semantics by default; per-code-point overrides measured on the
// REAL terminal via CPR (ESC[6n) live in globalThis.__dshCharWidths (a Map set
// up by packages/dsh-tui-app/src/charwidth.ts). No static guess list: a glyph
// the terminal draws narrow stays narrow, a glyph it draws wide is widened.
import stripAnsi from 'strip-ansi';
import eastAsianWidth from 'eastasianwidth';
import emojiRegex from 'emoji-regex';

const widths = () => (typeof globalThis !== 'undefined' && globalThis.__dshCharWidths instanceof Map) ? globalThis.__dshCharWidths : null;

// dsh-tui paint-wide glyphs: color-emoji terminals draw these as a two-cell
// pictograph even though the cursor only advances ONE column (CPR measures the
// cursor advance, not the painted extent, so a measured width of 1 for ⚠ on
// VTE/Noto Color Emoji still leaves the glyph overrunning its cell and the next
// characters crammed against it). Reserve two columns in the layout for these,
// regardless of the (advance-based) CPR measurement. Members are confirmed by
// real-terminal observation; text symbols (✓ ✗ ☑ ♠ ⚙ …) stay ONE column.
// 0x1f3f7 (🏷 U+1F3F7): an EAW-N ASTRAL emoji — charwidth.ts never probes
// astral code points ("always two columns"), yet VTE advances it ONE column
// while Noto Color Emoji paints the label two cells wide (same class as ⚠).
// 0x1f6e0 (🛠 U+1F6E0): the same EAW-N astral "colored glyph" class (hammer &
// wrench paints two cells on color-emoji terminals while the cursor advances
// one; string-width reports 1 for the bare base and only 2 once a U+FE0F
// variation selector forces emoji presentation). Without the reservation the
// painted second column pushes the row's right border one cell left.
// 0x23f8 (U+23F8) and 0x2600 (U+2600): EAW-N/A BMP emoji that the color-emoji
// font paints two cells wide while the cursor advances ONE -- the padding rows'
// CPR cache measured advance 1 for both. Unreserved they show as a Paused
// badge crammed against the pictograph, and as a markdown-table row whose later
// cells (the sidebar divider included) print one column LEFT.
// The astral members of this set are additionally probed by charwidth.ts's
// scan (PAINT_WIDE_ASTRAL) so the advance-based pad decision stays terminal
// specific; on CPR-less runs the default here pads them like ⚠.
const PAINT_WIDE = new Set([0x23f8, 0x2600, 0x26a0, 0x1f3f7, 0x1f6e0]);

export default function stringWidth(string, options = {}) {
	if (typeof string !== 'string' || string.length === 0) {
		return 0;
	}

	options = {
		ambiguousIsNarrow: true,
		...options
	};

	string = stripAnsi(string);

	if (string.length === 0) {
		return 0;
	}

	// Emoji sequences (incl. variation-selector pairs and astral emoji) count as
	// two columns.
	string = string.replace(emojiRegex(), '  ');
	// A residual variation selector (default-emoji base + U+FE0F that emoji-regex
	// did not absorb, or a stray FE0E/FE0F) carries no column.
	string = string.replace(/[\\uFE0E\\uFE0F]/g, '');

	const map = widths();
	const ambiguousCharacterWidth = options.ambiguousIsNarrow ? 1 : 2;
	let width = 0;

	for (const character of string) {
		const codePoint = character.codePointAt(0);

		// Ignore control characters
		if (codePoint <= 0x1F || (codePoint >= 0x7F && codePoint <= 0x9F)) {
			continue;
		}

		// Ignore combining characters
		if (codePoint >= 0x300 && codePoint <= 0x36F) {
			continue;
		}

		// Paint-wide glyphs (color-emoji fallback) reserve two columns even though
		// the cursor advances one — CPR alone cannot see the painted extent.
		if (PAINT_WIDE.has(codePoint)) {
			width += 2;
			continue;
		}

		// CPR-measured real width wins over the EAW default.
		const calibrated = map === null ? undefined : map.get(codePoint);
		if (calibrated !== undefined) {
			width += calibrated;
			continue;
		}

		const code = eastAsianWidth.eastAsianWidth(character);
		switch (code) {
			case 'F':
			case 'W':
				width += 2;
				break;
			case 'A':
				width += ambiguousCharacterWidth;
				break;
			default:
				width += 1;
		}
	}

	return width;
}
`
  for (const dir of dirs) {
    const indexJs = join(nm, '.pnpm', dir, 'node_modules', 'string-width', 'index.js')
    if (!existsSync(indexJs)) continue
    if (readFileSync(indexJs, 'utf8') === source) continue
    writeFileSync(indexJs, source)
    console.log(`dsh-tui: rewrote string-width with runtime-calibrated widths (${dir})`)
  }
}

/** Compile the tui-app source to `lib/` so the SEA bundle can resolve its exports. */
async function buildBundleLib() {
  const pkgDir = join(ROOT, 'packages/dsh-tui-app')
  const result = await build({
    entryPoints: [join(pkgDir, 'src/index.tsx'), join(pkgDir, 'src/startup.ts'), join(pkgDir, 'src/models.ts'), join(pkgDir, 'src/llm.ts'), join(pkgDir, 'src/opencode.ts'), join(pkgDir, 'src/china-gateways.ts'), join(pkgDir, 'src/foreign-gateways.ts'), join(pkgDir, 'src/azure.ts'), join(pkgDir, 'src/theme-plugin.ts'), join(pkgDir, 'src/sidebar-toggle.ts'), join(pkgDir, 'src/panels/conversation.tsx'), join(pkgDir, 'src/panels/approval.tsx'), join(pkgDir, 'src/panels/question.tsx'), join(pkgDir, 'src/panels/models.tsx'), join(pkgDir, 'src/sessions.tsx'), join(pkgDir, 'src/export.tsx'), join(pkgDir, 'src/new.ts'), join(pkgDir, 'src/goal.ts'), join(pkgDir, 'src/plan.ts'), join(pkgDir, 'src/selftest.ts'), join(pkgDir, 'src/image-attach.ts'), join(pkgDir, 'src/invariant.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2024',
    outdir: join(pkgDir, 'lib'),
    packages: 'external',
    loader: { '.ts': 'tsx' },
    jsx: 'automatic',
    logLevel: 'silent',
  })
  if (result.errors.length > 0) throw new Error(`tui-app lib build failed:\n${result.errors.map(e => e.text).join('\n')}`)
}

/** Emit the static import manifest and the config embed the entry consumes. */
function generate(specifiers) {
  rmSync(GEN_DIR, { recursive: true, force: true })
  mkdirSync(GEN_DIR, { recursive: true })
  const used = []
  const lines = []
  const bySpec = new Map()
  for (const spec of [...specifiers].sort()) {
    if (bySpec.has(spec)) continue
    const key = `m_${used.length + 1}`
    used.push(spec)
    bySpec.set(spec, key)
    lines.push(NATIVE_PACKAGES.has(spec)
      ? `import * as ${key} from '../stub/noop.js'`
      : `import * as ${key} from '${spec}'`)
  }
  lines.push('')
  lines.push('export const PLUGIN_BUILTINS = {')
  for (const spec of used) lines.push(`  ${JSON.stringify(spec)}: ${bySpec.get(spec)},`)
  lines.push('}')
  writeFileSync(join(GEN_DIR, 'plugins.ts'), lines.join('\n') + '\n')
  writeFileSync(join(GEN_DIR, 'config-embed.ts'), [
    '// Generated at build time; see apps/tui-bin/build.mjs.',
    `export const PROFILE_ROOT = ${JSON.stringify('[]\n')}`,
    `export const HARNESS_VERSION = ${JSON.stringify(HARNESS_VERSION_CURRENT || detectHarnessVersion())}`,
    `export const BASE_PATCH = ${JSON.stringify(readFileSync(join(HARNESS, 'packages/bundle/base/cordis.patch.yml'), 'utf8'))}`,
    `export const TUI_PATCH = ${JSON.stringify(readFileSync(join(ROOT, 'packages/dsh-tui-app/cordis.patch.yml'), 'utf8'))}`,
    '',
  ].join('\n'))
}

/** Per-target binary path: `dist/<name>/dsh-tui[.exe]` (generic binary name, no
 *  platform/arch suffix; the arch lives in the parent dir / package name). */
function targetBinaryPath(name) {
  const exe = name.startsWith('windows') ? '.exe' : ''
  return join(OUT_DIR, name, `dsh-tui${exe}`)
}

/** Compile one target: `name` is an ALL_TARGETS key, or `null` for the host (`bun`). */
function compileTarget(name, outfile) {
  const bunTarget = name === null ? 'bun' : BUN_TARGET[name]
  mkdirSync(dirname(outfile), { recursive: true })
  rmSync(outfile, { force: true })
  run('bun', ['build', '--compile', '--target', bunTarget, '--outfile', outfile, ENTRY])
  console.log(`dsh-tui: built ${outfile}`)
}

/** Archive one target's binary into `dist/`: linux -> tar.gz, others -> zip.
 *  Package file names keep the platform/arch (`dsh-tui-<name>.tar.gz/.zip`); the
 *  archive contains just the generic-named binary. */
function packageBinary(name) {
  const bin = targetBinaryPath(name)
  if (name.startsWith('linux')) {
    run('tar', ['-czf', join(OUT_DIR, `dsh-tui-${name}.tar.gz`), '-C', join(OUT_DIR, name), 'dsh-tui'])
  } else {
    run('zip', ['-j', join(OUT_DIR, `dsh-tui-${name}.zip`), bin])
  }
  console.log(`dsh-tui: packaged ${name}`)
}

/**
 * Bundle the entry with Bun into single self-contained binaries.
 *
 * Target selection:
 *   - `DSH_TUI_TARGETS=linux-x64,darwin-arm64` -> build exactly those;
 *   - `--single` -> build only the current platform, output `dist/dsh-tui`;
 *   - otherwise -> build every target in ALL_TARGETS.
 * Cross-target binaries land in per-target dirs `dist/<name>/dsh-tui[.exe]` (so
 * both Windows arches can keep the generic `dsh-tui.exe` name). Packaging:
 * `--package` archives them into `dist/dsh-tui-<name>.tar.gz/.zip`, mirroring
 * the project's release gating. `--single` skips packaging.
 */
function bundle() {
  const args = process.argv.slice(2)
  const single = args.includes('--single')
  const pack = args.includes('--package')
  const requested = (process.env.DSH_TUI_TARGETS ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  if (requested.length > 0) {
    for (const t of requested) {
      if (BUN_TARGET[t] === undefined) {
        throw new Error(`unknown DSH_TUI_TARGETS entry "${t}" (allowed: ${ALL_TARGETS.join(', ')})`)
      }
    }
    for (const name of requested) {
      compileTarget(name, targetBinaryPath(name))
      if (pack) packageBinary(name)
    }
    return
  }

  if (single) {
    compileTarget(null, join(OUT_DIR, 'dsh-tui'))
    return
  }

  for (const name of ALL_TARGETS) {
    compileTarget(name, targetBinaryPath(name))
    if (pack) packageBinary(name)
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  return result.stdout ?? ''
}

async function main() {
  if (!existsSync(join(HARNESS, 'package.json'))) {
    throw new Error(`DSH_HARNESS not found at ${HARNESS}; set DSH_HARNESS to the deepseek-harness checkout`)
  }
  assertHarnessCompatible()
  // Fresh dist: every previous artifact (cross-target dirs, tarballs) is stale
  // for this build and would otherwise linger.
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const specifiers = pluginSpecifiers()
  createResolveFarm()
  await buildBundleLib()
  generate(specifiers)
  bundle()
  console.log(`dsh-tui: build complete (${specifiers.size} plugin specifiers)`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
