/**
 * Artifact-level invariants for `scripts/install`.
 *
 * Two things about the installer cannot be checked by reading it once, and both
 * have already been wrong in this repository:
 *
 *  1. **The committed artifact must equal a fresh assembly.** `scripts/install`
 *     is generated from `scripts/install.d/*.sh` and committed (a clean checkout
 *     and the source tarball have to run it without a build step). A committed
 *     generated file drifts: edit a module, forget to re-run the builder, and the
 *     repository keeps shipping the old installer with nothing to notice.
 *
 *  2. **Placement must be a `mv`, never a `cp`.** `cp` onto a path that is
 *     currently executing fails with ETXTBSY ("Text file busy"), which is exactly
 *     the automatic-upgrade case — the running qialike replacing itself. The
 *     previous installer used `cp` and so could not upgrade a running binary at
 *     all. The control assertion below reproduces the ETXTBSY failure on the same
 *     path, so this test cannot pass vacuously on a filesystem where the
 *     distinction does not exist.
 *
 * Run with `bun test tests/install-bundle.test.ts`.
 *
 * @module qialike/install-bundle-test
 */

import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SCRIPT = join(REPO, 'scripts', 'install')
const BUILDER = join(REPO, 'scripts', 'build-install.sh')

/** A binary long-lived enough to still be executing when we replace it. */
const LONG_RUNNING = '/bin/sleep'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('the committed installer is a fresh assembly of its modules', () => {
  test('rebuilding reproduces scripts/install byte for byte', () => {
    const dir = tempDir('qialike-bundle-')
    try {
      const out = join(dir, 'install')
      const built = spawnSync('bash', [BUILDER, out], { encoding: 'utf8', timeout: 30_000 })

      expect(built.status, `builder failed: ${built.stderr}`).toBe(0)

      const fresh = readFileSync(out, 'utf8')
      const committed = readFileSync(SCRIPT, 'utf8')

      // Name the remedy in the failure, since the fix is a single command.
      expect(
        fresh === committed,
        'scripts/install is stale — re-run: bash scripts/build-install.sh',
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the builder output carries the shebang and the strict-mode header', () => {
    const text = readFileSync(SCRIPT, 'utf8')
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true)
    expect(text).toContain('set -euo pipefail')
    // A generated artifact must say so, or the next reader edits it directly and
    // their change is silently reverted by the next build.
    expect(text).toContain('GENERATED FILE — do not edit by hand.')
  })

  test('every module is represented in the artifact', () => {
    const modules = readdirSync(join(REPO, 'scripts', 'install.d')).filter((f) => f.endsWith('.sh'))
    const text = readFileSync(SCRIPT, 'utf8')
    expect(modules.length).toBeGreaterThan(0)
    for (const module of modules) {
      expect(text, `${module} is missing from the artifact`).toContain(`# ${module}\n`)
    }
  })
})

describe('replacing a running binary requires rename(2)', () => {
  // ETXTBSY is a POSIX behaviour, and the installer only supports linux-x64, so
  // the premise is only guaranteed here.
  test.skipIf(process.platform !== 'linux' || !existsSync(LONG_RUNNING))(
    'qialike_place replaces an executing binary, and cp demonstrably cannot',
    async () => {
      const home = tempDir('qialike-place-home-')
      const work = tempDir('qialike-place-work-')
      const installDir = join(home, '.dsh', 'bin')
      const dest = join(installDir, 'qialike')
      const incoming = join(work, 'incoming')

      mkdirSync(installDir, { recursive: true })
      copyFileSync(LONG_RUNNING, dest)
      chmodSync(dest, 0o755)
      writeFileSync(incoming, '#!/bin/sh\necho replaced\n')
      chmodSync(incoming, 0o755)

      const child = spawn(dest, ['30'], { stdio: 'ignore' })
      try {
        // Wait until the child is ACTUALLY executing `dest`, rather than assuming
        // a fixed delay is enough. A bare `setTimeout(400)` is a race: under load
        // (this suite runs right after `tsc` in the release gate) the exec may not
        // have landed yet, `cp` then succeeds, and the control assertion below
        // fails for reasons that have nothing to do with the code under test.
        // The kernel reports the executing image per pid, so this is exact.
        const expected = realpathSync(dest)
        const deadline = Date.now() + 10_000
        let executing = false
        while (!executing && Date.now() < deadline) {
          try {
            executing = readlinkSync(`/proc/${String(child.pid)}/exe`) === expected
          } catch {
            // Not exec'd yet (or already gone) — keep waiting.
          }
          if (!executing) await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(executing, `child ${String(child.pid)} never began executing ${dest}`).toBe(true)

        // Control: prove the premise on THIS path. Without this the test would
        // pass on a filesystem that never returns ETXTBSY, proving nothing.
        const control = spawnSync('cp', [incoming, dest], { encoding: 'utf8' })
        expect(
          control.status,
          'control failed: cp over a running binary unexpectedly succeeded, so this ' +
            'test cannot distinguish mv from cp on this filesystem',
        ).not.toBe(0)
        expect(`${control.stderr}`).toMatch(/Text file busy|ETXTBSY/i)

        // The real thing: the module's own placement.
        const placed = spawnSync(
          'bash',
          [
            '-c',
            // HOME drives INSTALL_DIR, which 00-common.sh derives from it.
            'source "$1/scripts/install.d/00-common.sh"; source "$1/scripts/install.d/50-place.sh"; qialike_place "$2"',
            'bash',
            REPO,
            incoming,
          ],
          { encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: home } },
        )

        expect(placed.status, `qialike_place failed: ${placed.stderr}`).toBe(0)
        expect(readFileSync(dest, 'utf8')).toBe('#!/bin/sh\necho replaced\n')
      } finally {
        child.kill('SIGKILL')
        rmSync(home, { recursive: true, force: true })
        rmSync(work, { recursive: true, force: true })
      }
    },
  )
})
