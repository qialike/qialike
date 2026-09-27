/**
 * Guards the npm channel's three templates against the one edit that fails silently.
 *
 * WHY THIS EXISTS. `packages/npm/<dir>/package.json` are templates, not publishable
 * manifests: the version is the placeholder `0.0.0-template` and the binary is not
 * in the directory at all (it is absent until a build produces it, and
 * `scripts/release/publish-npm.sh` stages a copy). `npm publish` run straight
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
 * The channel ships the **two Windows architectures** (x64, arm64) under the
 * scoped main package `@qialike/cli`; npm picks the matching platform package from
 * `os`/`cpu`, which is why that pairing is asserted per architecture. Linux and
 * macOS are served by the shell installer and the release archives instead.
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
const MAIN = '@qialike/cli'

/** The platform packages, in the order `publish-npm.sh` publishes them. */
const PLATFORMS = [
  { name: '@qialike/cli-win32-x64', os: 'win32', cpu: 'x64', binary: 'qialike.exe' },
  { name: '@qialike/cli-win32-arm64', os: 'win32', cpu: 'arm64', binary: 'qialike.exe' },
]

/** Every package on the channel, main first. */
const ALL = [MAIN, ...PLATFORMS.map((p) => p.name)]

/**
 * Package name to template directory: the scope prefix is dropped and the slash
 * becomes a dash, so no directory name carries an `@` or a nested path.
 */
function dirOf(name: string): string {
  return name.replace(/^@/, '').replace(/\//g, '-')
}

/** Read and parse one template's manifest. */
function manifest(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${REPO}/packages/npm/${dirOf(name)}/package.json`, 'utf8'))
}

describe('the npm channel templates are not publishable as they stand', () => {
  for (const name of ALL) {
    test(`${name} is private, so a bare npm publish fails with EPRIVATE`, () => {
      // Removing this field is the silent regression this whole file exists for.
      expect(manifest(name).private).toBe(true)
    })

    test(`${name} carries the placeholder version, not a real one`, () => {
      // A real version here means the release version lives in three more places;
      // the placeholders keep `package.json` the single source of truth.
      expect(manifest(name).version).toBe(PLACEHOLDER)
    })
  }

  test('the main package pins both platform dependencies to the placeholder', () => {
    // These are rewritten to the exact release version at publish time. A range
    // (^ / ~) would let npm resolve an older published platform package, which
    // installs a launcher with no binary behind it.
    expect(manifest(MAIN).optionalDependencies).toEqual(
      Object.fromEntries(PLATFORMS.map(({ name }) => [name, PLACEHOLDER])),
    )
  })
})

describe('the channel keeps bin in the parent and the payload in the platform package', () => {
  test('only the main package declares bin', () => {
    // The shape esbuild, Biome, SWC, sharp and @opencode/cli all use. A launcher
    // can name the exact reinstall command when an optionalDependency is missing;
    // a bare exec of the binary would just report a missing file.
    expect(manifest(MAIN).bin).toEqual({ qialike: 'bin/qialike.js' })
    for (const { name } of PLATFORMS) {
      expect(manifest(name).bin).toBeUndefined()
    }
  })

  for (const { name, os, cpu, binary } of PLATFORMS) {
    test(`${name} restricts itself to ${os}/${cpu} and carries ${binary}`, () => {
      // `os`/`cpu` are what make npm download exactly one payload per machine
      // instead of both; without them every architecture is installed.
      expect(manifest(name).os).toEqual([os])
      expect(manifest(name).cpu).toEqual([cpu])
      expect(manifest(name).files).toEqual([binary])
    })
  }

  test('the launcher script exists and is the module the bin field names', () => {
    const launcher = readFileSync(`${REPO}/packages/npm/${dirOf(MAIN)}/bin/qialike.js`, 'utf8')
    expect(launcher.startsWith('#!/usr/bin/env node')).toBe(true)
    // The wrapper is the only place that can explain a missing platform package,
    // so it must actually resolve one rather than exec a path it assumes.
    expect(launcher).toContain('require.resolve')
    expect(launcher).toContain("join(dirname(manifestPath), binaryName)")
  })

  test('the launcher covers exactly the two published targets', () => {
    // Cross-check: a target added to the templates but not to the launcher (or the
    // reverse) installs a package no `qialike` command can ever reach, and nothing
    // else in the repo compares those two lists.
    const launcher = readFileSync(`${REPO}/packages/npm/${dirOf(MAIN)}/bin/qialike.js`, 'utf8')
    for (const { os, cpu } of PLATFORMS) {
      expect(launcher).toContain(`'${os}-${cpu}':`)
    }
    const declared = launcher.match(/^ {2}'[a-z0-9]+-[a-z0-9]+':/gm) ?? []
    expect(declared).toHaveLength(PLATFORMS.length)
    // The package name is derived from the same key, so the two can never drift.
    expect(launcher).toContain('`@qialike/cli-${key}`')
  })
})
