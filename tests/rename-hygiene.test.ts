/**
 * Hygiene guards for the `dsh-tui` → `qialike` rename.
 *
 * A rename this wide regresses quietly: one leftover specifier, one old log
 * name, or one directory that kept the old spelling, and the next build or a
 * user's existing state silently misses. These guards read the SHIPPED surface
 * and assert that every remaining legacy string is deliberate — the
 * compatibility layer and the places that clean up pre-rename artifacts.
 *
 * The allowlist is per file with an expected count: adding a legacy string
 * anywhere else (or a second one in an allowed file) fails until it is either
 * removed or justified here.
 *
 * Run with `bun test tests/rename-hygiene.test.ts`.
 *
 * @module qialike/rename-hygiene-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

/** Directories that are build output, dependencies, or the vendored farm. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'lib', 'generated', 'x', '.resolve', 'stub-native', '.git', 'build'])

/** Shipped source roots the scan covers (tests are excluded on purpose: a test
 *  fixture may name a legacy string to prove the compatibility layer works). */
const SURFACE = [
  'packages/qialike-app/src',
  'apps/tui-bin/src',
  'apps/tui-bin/build.mjs',
  'scripts',
]

/** Files allowed to name the pre-rename product, with the occurrence count and
 *  the reason. Every one of them is compatibility or cleanup code. */
const LEGACY_ALLOWLIST: Readonly<Record<string, readonly [count: number, reason: string]>> = {
  'packages/qialike-app/src/legacy-names.ts': [15, 'the compatibility layer itself: legacy file names, namespaces, and the env prefix'],
  'packages/qialike-app/src/index.tsx': [1, 'comment on the first import that mirrors legacy env vars'],
  'packages/qialike-app/src/log.ts': [1, 'comment on the lazy log path the migration may rename'],
  'packages/qialike-app/src/selftest.ts': [1, 'accepts a pre-rename checkout root package name'],
  'packages/qialike-app/src/llm.ts': [1, 'legacy settings namespace constant'],
  'packages/qialike-app/src/theme-plugin.ts': [1, 'legacy settings namespace constant'],
  'packages/qialike-app/src/opencode.ts': [1, 'legacy settings namespace constant'],
  'packages/qialike-app/src/azure.ts': [1, 'legacy settings namespace constant'],
  'packages/qialike-app/src/china-gateways.ts': [1, 'legacy settings namespace constant'],
  'packages/qialike-app/src/foreign-gateways.ts': [1, 'legacy settings namespace constant'],
  'apps/tui-bin/src/bin.ts': [5, 'pre-rename rc marker, temp-dir sweep, alias resolution comment'],
  'apps/tui-bin/src/main.ts': [1, 'comment on the first import that mirrors legacy env vars'],
  'apps/tui-bin/build.mjs': [4, 'legacy patch markers and the alias-specifier mapping'],
  'scripts/install': [3, 'removes a pre-rename installed binary and reports a stale pre-rename PATH entry'],
  'scripts/uninstall.sh': [1, 'removes a pre-rename dev symlink'],
}

function walk(path: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path)) {
    const full = join(path, entry)
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      walk(full, out)
    } else if (/\.(ts|tsx|mjs|js|json|sh)$/.test(entry) || entry === 'install') {
      out.push(full)
    }
  }
  return out
}

function surfaceFiles(): string[] {
  const files: string[] = []
  for (const entry of SURFACE) {
    const full = join(REPO, entry)
    if (statSync(full).isDirectory()) walk(full, files)
    else files.push(full)
  }
  return files
}

describe('no shipped path keeps the old name', () => {
  test('every directory and file under the repo is spelled qialike', () => {
    const offenders: string[] = []
    const walkPaths = (path: string): void => {
      for (const entry of readdirSync(path)) {
        if (SKIP_DIRS.has(entry)) continue
        const full = join(path, entry)
        if (/dsh-tui/i.test(entry)) offenders.push(relative(REPO, full))
        if (statSync(full).isDirectory()) walkPaths(full)
      }
    }
    walkPaths(REPO)
    expect(offenders).toEqual([])
  })
})

describe('legacy strings survive only in the allowlist', () => {
  test('each allowed file matches its recorded count, and nothing else appears', () => {
    const seen = new Map<string, number>()
    for (const full of surfaceFiles()) {
      const source = readFileSync(full, 'utf8')
      const hits = source.match(/dsh-tui|DSH_TUI/g)?.length ?? 0
      if (hits > 0) seen.set(relative(REPO, full), hits)
    }
    for (const [file, [count, reason]] of Object.entries(LEGACY_ALLOWLIST)) {
      expect(seen.get(file), `${file} (${reason})`).toBe(count)
    }
    const unexpected = [...seen.keys()].filter((file) => !(file in LEGACY_ALLOWLIST))
    expect(unexpected, 'new legacy strings need a reason in the allowlist').toEqual([])
  })

  test('the old binary, config, log, and dist names are gone from the shipped code', () => {
    // The allowlisted files name the legacy spellings ON PURPOSE (that is what
    // the count check above pins); everywhere else none of them may appear.
    for (const full of surfaceFiles()) {
      if (relative(REPO, full) in LEGACY_ALLOWLIST) continue
      const source = readFileSync(full, 'utf8')
      for (const gone of ['dist/dsh-tui', 'dsh-tui.log', 'dsh-tui.json', '@yourname/dsh-tui-app/']) {
        expect(source.includes(gone), `${relative(REPO, full)} must not reference ${gone}`).toBe(false)
      }
    }
  })
})

describe('product identity', () => {
  const pkg = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(REPO, path), 'utf8')) as Record<string, unknown>

  test('packages carry the new name, and the root bin points at dist/qialike', () => {
    expect(pkg('package.json').name).toBe('@yourname/qialike-root')
    expect(pkg('package.json').bin).toEqual({ qialike: 'dist/qialike' })
    expect(pkg('packages/qialike-app/package.json').name).toBe('@yourname/qialike-app')
    expect(pkg('apps/tui-bin/package.json').name).toBe('@yourname/qialike-bin')
    const versions = ['package.json', 'packages/qialike-app/package.json', 'apps/tui-bin/package.json']
      .map((f) => pkg(f).version)
    expect(new Set(versions).size, 'three versions stay in lockstep').toBe(1)
  })

  test('both process entries call the product qialike', () => {
    for (const file of ['apps/tui-bin/src/bin.ts', 'apps/tui-bin/src/main.ts']) {
      expect(readFileSync(join(REPO, file), 'utf8')).toContain("const NAME = 'qialike'")
    }
  })

  test('the build emits dist/qialike and qialike-<target> packages', () => {
    const build = readFileSync(join(REPO, 'apps/tui-bin/build.mjs'), 'utf8')
    expect(build).toContain("return join(OUT_DIR, name, `qialike${exe}`)")
    // The host-only artifact (`--single`, i.e. `name === null`) lands at dist/qialike.
    expect(build).toContain("name === null ? join(OUT_DIR, 'qialike')")
    expect(build).toContain('`qialike-${name}.tar.gz`')
    expect(build).toContain('`qialike-${name}.zip`')
    // The app package the farm links and the bundles import.
    expect(build).toContain("link('@yourname/qialike-app', join(ROOT, 'packages/qialike-app'))")
  })

  test('the docs and the export filters follow the new package path', () => {
    expect(readFileSync(join(REPO, 'README.md'), 'utf8')).toStartWith('# qialike —')
    expect(readFileSync(join(REPO, '.gitattributes'), 'utf8')).toContain('/packages/qialike-app/repro-*.mjs')
  })
})
