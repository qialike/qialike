/**
 * Guards the npm channel's three templates against the one edit that fails silently.
 *
 * WHY THIS EXISTS. `packages/npm/<pkg>/package.json` are templates, not publishable
 * manifests: the version is the placeholder `0.0.0-template` and the Windows
 * binary is not in the directory at all (it is absent until a build produces it,
 * and `scripts/release/publish-npm.sh` stages a copy). `npm publish` run straight
 * from a template directory would therefore upload a `0.0.0-template` release —
 * and npm forbids deleting a version after 72 hours, so that junk would be
 * permanent. The templates carry `private: true` precisely so that command fails
 * instead: npm's upload layer (`libnpmpublish`) throws `EPRIVATE` unconditionally,
 * before any byte leaves the machine.
 *
 * That guard is a single field, and removing it turns a loud failure into a
 * silent one. Nothing else would notice, because:
 *   - `npm publish --dry-run` never reaches the upload layer and exits 0 even for
 *     a private package, so it cannot rehearse this check;
 *   - `publish-npm.sh` refuses a template whose version is not the placeholder,
 *     but that is a different field — dropping `private` leaves it happy.
 * So this file pins the field, the placeholder, and the split that keeps the
 * launcher in the parent package.
 *
 * Run with `bun test tests/npm-templates.test.ts`.
 *
 * @module qialike/npm-templates-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

/** The placeholder both the version and the optional ranges must carry. */
const PLACEHOLDER = '0.0.0-template'

/** The main package, whose `bin` is the only one on the channel. */
const MAIN = 'qialike'

/** The platform packages, in the order `publish-npm.sh` publishes them. */
const PLATFORMS = [
  { name: 'qialike-win32-x64', os: 'win32', cpu: 'x64' },
  { name: 'qialike-win32-arm64', os: 'win32', cpu: 'arm64' },
]

/** Every package on the channel, main first. */
const ALL = [MAIN, ...PLATFORMS.map((p) => p.name)]

/** Read and parse one template's manifest. */
function manifest(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${REPO}/packages/npm/${name}/package.json`, 'utf8'))
}

describe('the npm channel templates are not publishable as they stand', () => {
  for (const name of ALL) {
    test(`${name} is private, so a bare npm publish fails with EPRIVATE`, () => {
      // Removing this field is the silent regression this whole file exists for.
      expect(manifest(name).private).toBe(true)
    })

    test(`${name} carries the placeholder version, not a real one`, () => {
      // A real version here means the release version lives in four more places;
      // the placeholders keep `package.json` the single source of truth.
      expect(manifest(name).version).toBe(PLACEHOLDER)
    })
  }

  test('the main package pins its platform dependencies to the placeholder', () => {
    // These are rewritten to the exact release version at publish time. A range
    // (^ / ~) would let npm resolve an older published platform package, which
    // installs a launcher with no binary behind it.
    expect(manifest(MAIN).optionalDependencies).toEqual({
      'qialike-win32-x64': PLACEHOLDER,
      'qialike-win32-arm64': PLACEHOLDER,
    })
  })
})

describe('the channel keeps bin in the parent and the payload in the platform package', () => {
  test('only the main package declares bin', () => {
    // The shape esbuild, Biome, SWC and sharp all use. A launcher can name the
    // exact reinstall command when an optionalDependency is missing; a bare exec
    // of qialike.exe would just report a missing file.
    expect(manifest(MAIN).bin).toEqual({ qialike: 'bin/qialike.js' })
    for (const { name } of PLATFORMS) {
      expect(manifest(name).bin).toBeUndefined()
    }
  })

  for (const { name, os, cpu } of PLATFORMS) {
    test(`${name} restricts itself to ${os}/${cpu}`, () => {
      // `os`/`cpu` are what make npm download exactly one ~56 MB payload per
      // machine instead of both; without them the other target is installed too.
      expect(manifest(name).os).toEqual([os])
      expect(manifest(name).cpu).toEqual([cpu])
      expect(manifest(name).files).toEqual(['qialike.exe'])
    })
  }

  test('the launcher script exists and is the module the bin field names', () => {
    const launcher = readFileSync(`${REPO}/packages/npm/${MAIN}/bin/qialike.js`, 'utf8')
    expect(launcher.startsWith('#!/usr/bin/env node')).toBe(true)
    // The wrapper is the only place that can explain a missing platform package,
    // so it must actually resolve one rather than exec a path it assumes.
    expect(launcher).toContain('require.resolve')
    expect(launcher).toContain("join(dirname(manifestPath), 'qialike.exe')")
  })
})
