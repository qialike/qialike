/**
 * Tests for `self-update.ts` — install detection, version probing and the
 * concurrency guard.
 *
 * Everything runs offline and without bash: the process runner is injected, so a
 * test states exactly what each child would have said. The one test that does
 * shell out is the asset-table sync check, which runs the installer's own
 * platform module to prove the two tables agree.
 *
 * Run with `bun test tests/self-update.test.ts`.
 *
 * @module qialike/self-update-test
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireLock,
  assetFor,
  detectTarget,
  installDir,
  installMethod,
  installedVersion,
  latestVersion,
  lockPath,
  parseTagFromRedirect,
  releaseLock,
  upgrade,
  withUpgradeLock,
  type Runner,
} from '../packages/qialike-app/src/self-update.ts'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

const temporaries: string[] = []
process.on('exit', () => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaries.push(dir)
  return dir
}

/** A runner that answers from a table and records what it was asked. */
function fakeRunner(answers: Record<string, { status: number; stdout?: string; stderr?: string }>) {
  const calls: { cmd: string; args: readonly string[]; input?: string; env?: NodeJS.ProcessEnv }[] = []
  const run: Runner = (cmd, args, options) => {
    calls.push({ cmd, args, input: options?.input, env: options?.env })
    const answer = answers[`${cmd} ${args.join(' ')}`] ?? answers[cmd] ?? { status: 1 }
    return { status: answer.status, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return { run, calls }
}

describe('which install this is', () => {
  test('a binary in ~/.dsh/bin is ours to replace', () => {
    const home = '/home/someone'
    expect(installMethod(join(installDir(home), 'qialike'), home)).toBe('curl')
  })

  test('a checkout or ~/.local/bin build is never touched', () => {
    const home = '/home/someone'
    // A dev build running from the repository, from dist/, or from the legacy
    // ~/.local/bin symlink must all read as unmanaged.
    for (const execPath of [
      join(REPO, 'dist', 'qialike'),
      '/home/someone/.local/bin/qialike',
      '/usr/local/bin/qialike',
    ]) {
      expect(installMethod(execPath, home), execPath).toBe('unknown')
    }
  })

  test('the install dir is not derived from $DSH_HOME', () => {
    // uninstall scans exactly $HOME/.dsh/bin, so a DSH_HOME override here would
    // place the binary out of its reach.
    expect(installDir('/home/someone')).toBe('/home/someone/.dsh/bin')
  })
})

describe('platform naming', () => {
  test('known platform/arch pairs map, unknown ones return undefined', () => {
    expect(detectTarget('linux', 'x64')).toBe('linux-x64')
    expect(detectTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(detectTarget('win32', 'x64')).toBe('windows-x64')
    expect(detectTarget('freebsd', 'x64')).toBeUndefined()
    expect(detectTarget('linux', 'ia32')).toBeUndefined()
  })

  test('the asset table agrees with the installer’s own module', () => {
    // The TS side needs the asset name to read the release redirect, and the
    // shell side needs it to download. A silent divergence would show up only as
    // "could not resolve the latest version" — the updater would simply stop
    // seeing releases — so the two are compared by RUNNING the shell module.
    for (const target of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64', 'windows-arm64']) {
      const shell = spawnSync(
        'bash',
        [
          '-c',
          'source "$1/scripts/install.d/00-common.sh"; source "$1/scripts/install.d/20-platform.sh"; qialike_asset_for "$2"',
          'bash',
          REPO,
          target,
        ],
        { encoding: 'utf8' },
      )
      expect(shell.status, `shell refused ${target}: ${shell.stderr}`).toBe(0)
      expect(assetFor(target), `${target} disagrees with 20-platform.sh`).toBe(shell.stdout.trim())
    }
    expect(assetFor('plan9-mips')).toBeUndefined()
  })
})

describe('version probing', () => {
  test('the tag comes out of the redirect, not the API', () => {
    expect(parseTagFromRedirect('https://github.com/qialike/qialike/releases/download/0.6.1/qialike-linux-x64.tar.gz')).toBe('0.6.1')
    expect(parseTagFromRedirect('  https://mirror.example/download/v1.2.3/file.zip\n')).toBe('v1.2.3')
    expect(parseTagFromRedirect('')).toBeUndefined()
    expect(parseTagFromRedirect('https://example.com/latest')).toBeUndefined()
  })

  test('latest is read from the redirect and needs no API', () => {
    const { run, calls } = fakeRunner({
      curl: { status: 0, stdout: 'https://github.com/qialike/qialike/releases/download/0.6.1/qialike-linux-x64.tar.gz' },
    })
    expect(latestVersion({ target: 'linux-x64', releases: 'https://example.test/rel', run })).toBe('0.6.1')
    // `%{redirect_url}` with no `-L`: reading the recipe, not downloading 52 MB.
    expect(calls[0]?.args).toContain('%{redirect_url}')
    expect(calls[0]?.args).not.toContain('-L')
  })

  test('an unpublished platform or a failed curl yields undefined, not a throw', () => {
    const { run } = fakeRunner({ curl: { status: 0, stdout: '' } })
    expect(latestVersion({ target: 'darwin-arm64', run })).toBeUndefined()
    expect(latestVersion({ target: 'plan9-mips', run })).toBeUndefined()

    const failing = fakeRunner({ curl: { status: 6 } })
    expect(latestVersion({ target: 'linux-x64', run: failing.run })).toBeUndefined()
  })

  test('the installed version is the last word of --version', () => {
    const { run } = fakeRunner({ [join('/home/x/.dsh/bin', 'qialike')]: { status: 0, stdout: 'qialike 0.6.0\n' } })
    expect(installedVersion({ dir: '/home/x/.dsh/bin', run })).toBe('0.6.0')

    const broken = fakeRunner({ [join('/home/x/.dsh/bin', 'qialike')]: { status: 1 } })
    expect(installedVersion({ dir: '/home/x/.dsh/bin', run: broken.run })).toBeUndefined()
  })
})

describe('the concurrency guard', () => {
  test('a second holder is refused, and the lock is released afterwards', () => {
    const path = join(tempDir('qialike-lock-'), '.upgrade.lock')

    expect(acquireLock(path)).toBe(true)
    // Same process, second attempt: still held (the guard is about concurrent
    // upgrades, and a nested one would double-install).
    expect(acquireLock(path)).toBe(false)
    expect(withUpgradeLock(path, () => 'ran')).toBeUndefined()

    releaseLock(path)
    expect(withUpgradeLock(path, () => 'ran')).toBe('ran')
    // Released on the way out.
    expect(existsSync(path)).toBe(false)
  })

  test('a lock whose owner died is stolen, so a crash cannot wedge updates', () => {
    const path = join(tempDir('qialike-lock-'), '.upgrade.lock')
    // PID 1 exists; a pid far outside the range does not.
    writeFileSync(path, '999999999')
    expect(acquireLock(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(String(process.pid))
    releaseLock(path)
  })

  test('a lock held by a live process is respected', () => {
    const path = join(tempDir('qialike-lock-'), '.upgrade.lock')
    // Our own pid is alive, so this must NOT be treated as stale.
    writeFileSync(path, String(process.pid))
    expect(acquireLock(path)).toBe(false)
    releaseLock(path)
  })

  test('the default lock lives beside the binary', () => {
    expect(lockPath('/home/someone')).toBe('/home/someone/.dsh/bin/.upgrade.lock')
  })
})

describe('upgrading runs the installer', () => {
  test('the script is piped to bash with the pinned version', () => {
    const dir = join(tempDir('qialike-upg-'), '.dsh', 'bin')
    const { run, calls } = fakeRunner({
      'bash --version': { status: 0 },
      [`curl -fsSL https://install.test/install`]: { status: 0, stdout: '#!/usr/bin/env bash\necho hi\n' },
      'bash ': { status: 0 },
      [join(dir, 'qialike')]: { status: 0, stdout: 'qialike 0.6.1\n' },
    })
    // The binary must exist for the guard that refuses to install over nothing.
    spawnSync('mkdir', ['-p', dir])
    writeFileSync(join(dir, 'qialike'), '#!/bin/sh\n')

    const result = upgrade('0.6.1', { installUrl: 'https://install.test/install', dir, run })
    expect(result).toEqual({ ok: true, version: '0.6.1' })

    const piped = calls.find((call) => call.cmd === 'bash' && call.args.length === 0)
    expect(piped?.input).toContain('#!/usr/bin/env bash')
    // The installer resolves nothing itself: the policy's version is pinned.
    expect(piped?.env?.QIALIKE_VERSION).toBe('0.6.1')
  })

  test('a failed fetch and a missing bash are reported, not thrown', () => {
    const dir = join(tempDir('qialike-upg-'), '.dsh', 'bin')
    spawnSync('mkdir', ['-p', dir])
    writeFileSync(join(dir, 'qialike'), '#!/bin/sh\n')

    const noFetch = fakeRunner({ 'bash --version': { status: 0 }, curl: { status: 22, stderr: '404' } })
    expect(upgrade('0.6.1', { dir, run: noFetch.run }).error).toContain('could not fetch the installer')

    const noBash = fakeRunner({ 'bash --version': { status: 127 } })
    expect(upgrade('0.6.1', { dir, run: noBash.run }).error).toContain('bash is required')

    const empty = join(tempDir('qialike-upg-'), '.dsh', 'bin')
    expect(upgrade('0.6.1', { dir: empty, run: noFetch.run }).error).toContain('not installed at')
  })

  test('an installer failure reports the last line of its stderr', () => {
    const dir = join(tempDir('qialike-upg-'), '.dsh', 'bin')
    spawnSync('mkdir', ['-p', dir])
    writeFileSync(join(dir, 'qialike'), '#!/bin/sh\n')
    const { run } = fakeRunner({
      'bash --version': { status: 0 },
      'curl -fsSL https://install.test/install': { status: 0, stdout: 'script\n' },
      'bash ': { status: 1, stderr: 'noise\nqialike: download failed: https://x\n' },
    })
    expect(upgrade('0.6.1', { installUrl: 'https://install.test/install', dir, run }).error)
      .toBe('installer failed: qialike: download failed: https://x')
  })

  test('a held lock means another upgrade is already running', () => {
    const dir = join(tempDir('qialike-upg-'), '.dsh', 'bin')
    spawnSync('mkdir', ['-p', dir])
    writeFileSync(join(dir, 'qialike'), '#!/bin/sh\n')
    const lock = join(dir, '.upgrade.lock')
    writeFileSync(lock, String(process.pid))

    const { run } = fakeRunner({
      'bash --version': { status: 0 },
      curl: { status: 0, stdout: 'script\n' },
      'bash ': { status: 0 },
    })
    expect(upgrade('0.6.1', { dir, lock, run }).error).toBe('another upgrade is already running')
  })
})
