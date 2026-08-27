/**
 * Build the single-file SEA (`dist/dsh-tui`) bundle.
 *
 * The entry (`src/bin.ts`) boots the same profile composition the npm bundle
 * ships (dsh-base + dsh-tui-app patch layers) through the Cordis Loader, but a
 * single file cannot resolve plugin modules by name at runtime. So this builder:
 *  1. scans the DeepSeek Harness checkout for `@deepseek-ai/*` packages,
 *  2. reads the base + tui patch layers to find every plugin the composition
 *     references by `name`,
 *  3. emits an import manifest that statically imports exactly those modules
 *     (bundled by esbuild) and a config embed carrying the patch/root files,
 *  4. esbuild-bundles the entry to one ESM file, then
 *  5. wraps it with Node SEA (`--experimental-sea-config` + `postject`).
 *
 * Resolution uses a symlink farm (`nodePaths`) so bare `@deepseek-ai/*` names —
 * including subpath exports — resolve through the harness's built packages and
 * then get bundled. Native-addon packages are stubbed: the TUI patch disables
 * the OS sandbox rows, so their (native) modules never activate; a stub keeps
 * esbuild from following the `.node` import.
 *
 * @module dsh-tui/build
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..')
const HARNESS = process.env.DSH_HARNESS ?? resolve(ROOT, '../deepseek-harness')
const OUT_DIR = join(ROOT, 'dist')
const GEN_DIR = join(ROOT, 'apps/tui-bin/generated')
const STUB_DIR = join(ROOT, 'apps/tui-bin/stub-native')

/** Packages that load a native `.node` addon; stubbed (never activated by the TUI patch). */
const NATIVE_PACKAGES = new Set([
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/node-addon-landlock-run',
])

/**
 * Third-party modules that load a native binding (or an optional dev-only
 * tool) and must be stubbed so Bun never bundles the native `.node`/WASM it
 * cannot load inside a single file. Each is Windows-only FFI or a capability a
 * text coding-agent TUI never activates, so a no-op is correct on Linux.
 *
 * Add a module here (one line) instead of a new stubPackage call so the stub
 * set stays one data source and every stub is logged at build time.
 */
const STUB_PACKAGES = new Set([
  'koffi', // Windows FFI (advapi32/kernel32/user32/ole32) — guarded win32-only
  'node-pty', // PTY terminal sessions — never exercised; bash runs via child_process
  'sharp', // native image processing — a text coding-agent TUI does not use it
  'react-devtools-core', // optional Ink devtools — dev-only
])

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
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

/** All harness `@deepseek-ai/*` packages as name → absolute package dir. */
function scanPackages() {
  const found = new Map()
  const add = (dir) => {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) return
    const pkg = readJson(manifest)
    if (typeof pkg.name === 'string' && pkg.name.startsWith('@deepseek-ai/')) found.set(pkg.name, dir)
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
  return out
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
  // No-op stubs so the native/optional deps bundle and resolve (they are never
  // activated by a text coding-agent TUI). Created before the mirror so the
  // harness store does not supply the real (native) package. The whitelist is
  // the single source of truth; each stub is logged for auditability.
  for (const name of STUB_PACKAGES) {
    stubPackage(name)
    console.log(`dsh-tui: stubbed ${name}`)
  }

  // Third-party deps of the vendored/transformed plugins resolve from the
  // harness's pnpm virtual store; mirror every entry we do not already own.
  mirrorHarnessStore(nm)

  // Ink's layout engine loads yoga.wasm at module scope via createRequire +
  // fs.readFile, which a single file cannot satisfy; inline the wasm as base64.
  patchInkYoga(nm)

  const link = (name, dir) => {
    const target = join(nm, ...name.split('/')) // @scope/name -> node_modules/@scope/name
    mkdirSync(dirname(target), { recursive: true })
    if (NATIVE_PACKAGES.has(name)) {
      symlinkSync(STUB_DIR, target, 'dir')
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

/** Compile the tui-app source to `lib/` so the SEA bundle can resolve its exports. */
async function buildBundleLib() {
  const pkgDir = join(ROOT, 'packages/dsh-tui-app')
  const result = await build({
    entryPoints: [join(pkgDir, 'src/index.tsx'), join(pkgDir, 'src/startup.ts'), join(pkgDir, 'src/invariant.ts')],
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
    `export const BASE_PATCH = ${JSON.stringify(readFileSync(join(HARNESS, 'packages/bundle/base/cordis.patch.yml'), 'utf8'))}`,
    `export const TUI_PATCH = ${JSON.stringify(readFileSync(join(ROOT, 'packages/dsh-tui-app/cordis.patch.yml'), 'utf8'))}`,
    '',
  ].join('\n'))
}

/** Bundle the entry with Bun and compile it into a single self-contained binary. */
function bundle() {
  const target = join(OUT_DIR, 'dsh-tui')
  rmSync(target, { force: true })
  run('bun', ['build', '--compile', '--target', 'bun', '--outfile', target, join(ROOT, 'apps/tui-bin/src/bin.ts')])
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
  mkdirSync(OUT_DIR, { recursive: true })
  const specifiers = pluginSpecifiers()
  createResolveFarm()
  await buildBundleLib()
  generate(specifiers)
  bundle()
  console.log(`dsh-tui: built ${join(OUT_DIR, 'dsh-tui')} (${specifiers.size} plugin specifiers)`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
