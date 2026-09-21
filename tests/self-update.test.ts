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
  binaryName,
  CONNECT_TIMEOUT,
  DEFAULT_RELEASES_URL,
  detectTarget,
  downloadUrls,
  fastestSource,
  installDir,
  installMethod,
  installedVersion,
  latestVersion,
  lockPath,
  MEASURE_BYTES,
  MEASURE_TIMEOUT,
  measureSpeed,
  MIRROR_RELEASES_URL,
  nullDevice,
  parseTagFromJson,
  parseTagFromRedirect,
  PROBE_TIMEOUT,
  RELEASE_SOURCES,
  releaseSources,
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

describe('release sources', () => {
  test('the default list is GitHub first, then the mirror with its API', () => {
    const sources = releaseSources({})
    expect(sources.map((source) => source.base)).toEqual([DEFAULT_RELEASES_URL, MIRROR_RELEASES_URL])
    // GitHub is read through its redirect, so it must have NO API: adding one would
    // start counting against the 60/hour limit for no benefit.
    expect(sources[0]?.api).toBeUndefined()
    expect(sources[1]?.api).toBe('https://gitcode.com/api/v5/repos/qialike/qialike/releases/latest')
  })

  test('an explicit base URL is exactly ONE source', () => {
    // A configured host must not have the public fallbacks appended: a deliberately
    // unreachable fixture would then be papered over by a working mirror, and the
    // failure under test would never surface.
    expect(releaseSources({ QIALIKE_INSTALL_BASE_URL: 'https://mirror.test/rel/' })).toEqual([
      { base: 'https://mirror.test/rel' },
    ])
    // A bare gitcode base still gets its API, or nothing could resolve through it.
    expect(releaseSources({ QIALIKE_INSTALL_BASE_URL: MIRROR_RELEASES_URL })).toEqual([
      { base: MIRROR_RELEASES_URL, api: 'https://gitcode.com/api/v5/repos/qialike/qialike/releases/latest' },
    ])
  })

  test('a source list is parsed, deriving an API only where the host needs one', () => {
    expect(releaseSources({ QIALIKE_INSTALL_SOURCES: 'https://a.test/rel, https://gitcode.com/o/r/releases|' })).toEqual([
      { base: 'https://a.test/rel' },
      { base: 'https://gitcode.com/o/r/releases', api: 'https://gitcode.com/api/v5/repos/o/r/releases/latest' },
    ])
    // An explicit API is believed over the derivation.
    expect(releaseSources({ QIALIKE_INSTALL_SOURCES: 'https://gitcode.com/o/r/releases|https://elsewhere/api' })).toEqual([
      { base: 'https://gitcode.com/o/r/releases', api: 'https://elsewhere/api' },
    ])
  })

  test('the installer carries the same list as this module', () => {
    // The two are a copy of each other by necessity (one is bash, one is bundled TS),
    // so this is the check that keeps them from drifting — the same shape as the
    // asset-table check below, and it runs the installer's own parser.
    const shell = spawnSync(
      'bash',
      [
        '-c',
        'source "$1/scripts/install.d/00-common.sh"; source "$1/scripts/install.d/10-args.sh";' +
          ' qialike_parse_sources "$DEFAULT_SOURCES";' +
          ' for i in "${!SOURCE_BASES[@]}"; do printf \'%s|%s\\n\' "${SOURCE_BASES[$i]}" "${SOURCE_APIS[$i]}"; done',
        'bash',
        REPO,
      ],
      { encoding: 'utf8' },
    )
    expect(shell.status, shell.stderr).toBe(0)
    expect(shell.stdout.trim().split('\n')).toEqual(RELEASE_SOURCES.map((source) => `${source.base}|${source.api ?? ''}`))
  })

  test('the API tag is read out of the JSON without a parser', () => {
    expect(parseTagFromJson('{"tag_name":"0.6.0","assets":[{"name":"x"}]}')).toBe('0.6.0')
    expect(parseTagFromJson('{"assets":[]}')).toBeUndefined()
    expect(parseTagFromJson('')).toBeUndefined()
  })

  test('a reachable primary needs no API call at all', () => {
    const { run, calls } = fakeRunner({
      curl: { status: 0, stdout: 'https://github.com/qialike/qialike/releases/download/0.6.1/qialike-linux-x64.tar.gz' },
    })
    expect(latestVersion({ target: 'linux-x64', run })).toBe('0.6.1')
    expect(calls).toHaveLength(1)
  })

  test('a source that cannot answer falls through to the next, API included', () => {
    const asked: string[] = []
    const run: Runner = (cmd, args) => {
      const line = `${cmd} ${args.join(' ')}`
      asked.push(line)
      // The primary is blackholed: 28 is curl's exit for a timeout.
      if (line.includes('github.com')) return { status: 28, stdout: '', stderr: '' }
      if (line.includes('/api/v5/repos/')) return { status: 0, stdout: '{"tag_name":"0.6.0"}', stderr: '' }
      // The mirror's own `/latest/download/…` answers with a page and no redirect.
      return { status: 0, stdout: '', stderr: '' }
    }

    expect(latestVersion({ target: 'linux-x64', run })).toBe('0.6.0')
    expect(asked[0]).toContain(DEFAULT_RELEASES_URL)
    expect(asked[0]).toContain('%{redirect_url}')
    expect(asked[1]).toContain(MIRROR_RELEASES_URL)
    expect(asked[1]).toContain('%{redirect_url}')
    // Only the mirror gets asked for JSON — GitHub has no API in the list.
    expect(asked[2]).toContain('/api/v5/repos/')
    expect(asked).toHaveLength(3)
    // Both probes are bounded, so a blackholed host cannot hang the check.
    for (const line of asked) {
      expect(line).toContain(CONNECT_TIMEOUT)
      expect(line).toContain(PROBE_TIMEOUT)
    }
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

  test('the probe discards the body through the platform null device', () => {
    // Measured on Windows with the shipped curl 8.21.0: `-o /dev/null` answers
    // 302 and then exits 23 — curl does NOT map the POSIX spelling onto the null
    // device, it tries to create the literal `<drive>:\dev\null` and fails — while
    // every caller here requires exit 0 before it believes the tag. The primary
    // (GitHub) probe therefore always threw its tag away on Windows, and updates
    // were resolved only through the mirror's API call (which passes no `-o`).
    expect(nullDevice('win32')).toBe('NUL')
    expect(nullDevice('linux')).toBe('/dev/null')
    expect(nullDevice('darwin')).toBe('/dev/null')

    const { run, calls } = fakeRunner({ curl: { status: 0, stdout: 'https://host/download/0.6.1/qialike-linux-x64.tar.gz' } })
    expect(latestVersion({ target: 'linux-x64', releases: 'https://example.test/rel', run })).toBe('0.6.1')
    expect(calls[0]?.args).toContain(nullDevice())
    // ...and never the POSIX spelling that broke Windows. Guarded by platform
    // because the probe passes the HOST's device: on Linux `nullDevice()` IS
    // `/dev/null`, so an unconditional `not.toContain` here asserted a
    // contradiction and made this test pass on Windows only. The three assertions
    // above are what pins the Windows spelling.
    if (process.platform === 'win32') {
      expect(calls[0]?.args).not.toContain('/dev/null')
    }
  })

  test('the manual download links name every source, or the releases page', () => {
    // This is what a Windows notice is built from, so it has to point at real
    // download URLs for the platform's own asset: GitHub first, mirror second,
    // because the user who needs it most is the one whose GitHub is blocked.
    expect(downloadUrls('0.8.0', { target: 'windows-x64', sources: RELEASE_SOURCES })).toEqual([
      `${DEFAULT_RELEASES_URL}/download/0.8.0/qialike-windows-x64.zip`,
      `${MIRROR_RELEASES_URL}/download/0.8.0/qialike-windows-x64.zip`,
    ])
    // With no version resolved yet, or no asset for the platform, the releases
    // page is the honest answer — a guessed asset name would 404.
    expect(downloadUrls(undefined, { target: 'windows-x64', sources: RELEASE_SOURCES })).toEqual([
      DEFAULT_RELEASES_URL,
      MIRROR_RELEASES_URL,
    ])
    expect(downloadUrls('0.8.0', { target: 'plan9-mips', sources: RELEASE_SOURCES })).toEqual([
      DEFAULT_RELEASES_URL,
      MIRROR_RELEASES_URL,
    ])
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
    // The platform is named explicitly so the expectation does not depend on the
    // host running the suite: the binary's file name differs on Windows.
    expect(installedVersion({ dir: '/home/x/.dsh/bin', run, platform: 'linux' })).toBe('0.6.0')

    const broken = fakeRunner({ [join('/home/x/.dsh/bin', 'qialike')]: { status: 1 } })
    expect(installedVersion({ dir: '/home/x/.dsh/bin', run: broken.run, platform: 'linux' })).toBeUndefined()
  })

  test('the installed binary is asked for under its own platform name', () => {
    // `.exe` is not decoration on Windows: the released asset carries that name,
    // and the guard in `upgrade()` looked for the bare one — so a perfectly
    // installed Windows copy was reported as "not installed".
    expect(binaryName('win32')).toBe('qialike.exe')
    expect(binaryName('linux')).toBe('qialike')
    expect(binaryName('darwin')).toBe('qialike')

    const dir = 'C:\\Users\\x\\.dsh\\bin'
    const { run, calls } = fakeRunner({ [join(dir, 'qialike.exe')]: { status: 0, stdout: 'qialike 0.6.1\n' } })
    expect(installedVersion({ dir, run, platform: 'win32' })).toBe('0.6.1')
    expect(calls[0]?.args).toEqual(['--version'])
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

    const result = upgrade('0.6.1', { installUrl: 'https://install.test/install', dir, run, platform: 'linux' })
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
    expect(upgrade('0.6.1', { dir, run: noFetch.run, platform: 'linux' }).error).toContain('could not fetch the installer')

    const noBash = fakeRunner({ 'bash --version': { status: 127 } })
    expect(upgrade('0.6.1', { dir, run: noBash.run, platform: 'linux' }).error).toContain('bash is required')

    const empty = join(tempDir('qialike-upg-'), '.dsh', 'bin')
    expect(upgrade('0.6.1', { dir: empty, run: noFetch.run, platform: 'linux' }).error).toContain('not installed at')
  })

  test('Windows is refused before anything is spawned', () => {
    // Neither fact is a preference: a running `.exe` cannot be replaced (the `mv`
    // that saves a running ELF on POSIX does not work there), and the installer is
    // bash, which Windows does not ship. The refusal has to come FIRST too — a
    // Windows run that answered "bash is required" would send the user hunting for
    // a shell instead of downloading the release.
    const { run, calls } = fakeRunner({})
    const result = upgrade('0.6.1', { dir: tempDir('qialike-win-'), run, platform: 'win32' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Windows')
    expect(calls).toEqual([])
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
    expect(upgrade('0.6.1', { installUrl: 'https://install.test/install', dir, run, platform: 'linux' }).error)
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
    expect(upgrade('0.6.1', { dir, lock, run, platform: 'linux' }).error).toBe('another upgrade is already running')
  })
})

describe('choosing the host by throughput', () => {
  /** The exact command `measureSpeed` runs, so `fakeRunner` can answer per host. */
  const measureKey = (base: string) =>
    `curl -fsSL -r 0-${MEASURE_BYTES - 1} --connect-timeout ${CONNECT_TIMEOUT} --max-time ${MEASURE_TIMEOUT}` +
    ` -o ${nullDevice()} -w %{speed_download} ${base}/download/0.6.1/qialike-linux-x64.tar.gz`

  test('a source is measured by what it can actually deliver', () => {
    // Reachability says nothing about a 55 MB body: GitHub answers the small redirect
    // from github.com and serves the body from release-assets.githubusercontent.com.
    const { run, calls } = fakeRunner({ [measureKey(DEFAULT_RELEASES_URL)]: { status: 0, stdout: '437207.000' } })
    expect(measureSpeed({ base: DEFAULT_RELEASES_URL }, '0.6.1', { target: 'linux-x64', run })).toBe(437207)
    // A range request: a 256 KB sample, not the whole release.
    expect(calls[0]?.args).toContain(`0-${MEASURE_BYTES - 1}`)
    expect(calls[0]?.args).toContain(MEASURE_TIMEOUT)
  })

  test('a source that cannot serve the tag is not a candidate', () => {
    // A 404 (a mirror behind the tag) or a dead host: curl exits non-zero AND reports
    // zero bytes, and that is what disqualifies it.
    const missing = fakeRunner({ curl: { status: 22, stdout: '0.000' } })
    expect(measureSpeed({ base: MIRROR_RELEASES_URL }, '0.6.1', { target: 'linux-x64', run: missing.run })).toBeUndefined()

    const dead = fakeRunner({ curl: { status: 7, stdout: '' } })
    expect(measureSpeed({ base: MIRROR_RELEASES_URL }, '0.6.1', { target: 'linux-x64', run: dead.run })).toBeUndefined()
  })

  test('an aborted sample still counts: the slow source is the one that times out', () => {
    // Measured with the real curl: a trickling source answers `200 131072 16380` and
    // exits 28. Reading the exit status would throw away exactly the measurement that
    // matters, so only the number is read.
    const { run } = fakeRunner({ curl: { status: 28, stdout: '16380.000' } })
    expect(measureSpeed({ base: DEFAULT_RELEASES_URL }, '0.6.1', { target: 'linux-x64', run })).toBe(16380)
  })

  test('the fastest source wins, and ties keep the earlier one', () => {
    const { run } = fakeRunner({
      [measureKey(DEFAULT_RELEASES_URL)]: { status: 0, stdout: '12000.000' },
      [measureKey(MIRROR_RELEASES_URL)]: { status: 0, stdout: '890000.000' },
    })
    expect(fastestSource(RELEASE_SOURCES, '0.6.1', { target: 'linux-x64', run })?.base).toBe(MIRROR_RELEASES_URL)

    const tied = fakeRunner({ curl: { status: 0, stdout: '5000.000' } })
    expect(fastestSource(RELEASE_SOURCES, '0.6.1', { target: 'linux-x64', run: tied.run })?.base).toBe(DEFAULT_RELEASES_URL)
  })

  test('nothing to compare means no choice is made', () => {
    const { run, calls } = fakeRunner({ curl: { status: 0, stdout: '900000.000' } })
    expect(fastestSource([RELEASE_SOURCES[0] as { base: string }], '0.6.1', { target: 'linux-x64', run })).toBeUndefined()
    expect(calls).toEqual([])

    // Every source 404s this tag (or none answers): the probe's order stands.
    const none = fakeRunner({ curl: { status: 22, stdout: '0.000' } })
    expect(fastestSource(RELEASE_SOURCES, '0.6.1', { target: 'linux-x64', run: none.run })).toBeUndefined()
  })

  test('upgrade pins the measured host, and retries without it when that fails', () => {
    const dir = join(tempDir('qialike-upg-'), '.dsh', 'bin')
    spawnSync('mkdir', ['-p', dir])
    writeFileSync(join(dir, 'qialike'), '#!/bin/sh\n')

    // First bash attempt fails, the second succeeds — the shape of "the fast host died
    // mid-download, fall back to the installer's own list".
    let attempts = 0
    const { run, calls } = fakeRunner({
      'bash --version': { status: 0 },
      'curl -fsSL https://install.test/install': { status: 0, stdout: 'script\n' },
      [measureKey(DEFAULT_RELEASES_URL)]: { status: 0, stdout: '11000.000' },
      [measureKey(MIRROR_RELEASES_URL)]: { status: 0, stdout: '900000.000' },
      'bash ': { status: 0 },
      [join(dir, 'qialike')]: { status: 0, stdout: 'qialike 0.6.1\n' },
    })
    const counting: Runner = (cmd, args, options) => {
      // Delegate FIRST so the call (and its env) is recorded, then force the first
      // installer attempt to fail.
      const result = run(cmd, args, options)
      if (cmd === 'bash' && args.length === 0) {
        attempts += 1
        if (attempts === 1) return { status: 1, stdout: '', stderr: 'qialike: download failed\n' }
      }
      return result
    }

    const result = upgrade('0.6.1', {
      installUrl: 'https://install.test/install', dir, run: counting, platform: 'linux', env: {},
    })
    expect(result).toEqual({ ok: true, version: '0.6.1' })

    const piped = calls.filter((call) => call.cmd === 'bash' && call.args.length === 0)
    expect(piped).toHaveLength(2)
    // The winner is handed over as `QIALIKE_INSTALL_BASE_URL`, which every installer
    // version understands — including the ones deployed before the measurement existed.
    expect(piped[0]?.env?.QIALIKE_INSTALL_BASE_URL).toBe(MIRROR_RELEASES_URL)
    // ...and it says "do not compare again", since the comparison already happened.
    expect(piped[0]?.env?.QIALIKE_INSTALL_MEASURE).toBe('0')
    // The retry drops the pin so the installer's own list (and its own fallback) applies.
    expect(piped[1]?.env?.QIALIKE_INSTALL_BASE_URL).toBeUndefined()
  })

  test('an explicit configuration is never overridden by the comparison', () => {
    const dir = join(tempDir('qialike-upg-'), '.dsh', 'bin')
    spawnSync('mkdir', ['-p', dir])
    writeFileSync(join(dir, 'qialike'), '#!/bin/sh\n')

    const key = `curl -fsSL -r 0-${MEASURE_BYTES - 1} --connect-timeout ${CONNECT_TIMEOUT} --max-time ${MEASURE_TIMEOUT} -o ${nullDevice()} -w %{speed_download}`
    let measured = 0
    const { run, calls } = fakeRunner({
      'bash --version': { status: 0 },
      'curl -fsSL https://install.test/install': { status: 0, stdout: 'script\n' },
      [join(dir, 'qialike')]: { status: 0, stdout: 'qialike 0.6.1\n' },
    })
    const watching: Runner = (cmd, args, options) => {
      if (cmd === 'curl' && args.join(' ').startsWith(key)) measured += 1
      return run(cmd, args, options)
    }

    // A user-chosen host is exactly that host, and nothing is sampled.
    upgrade('0.6.1', {
      installUrl: 'https://install.test/install', dir, run: watching, platform: 'linux',
      env: { QIALIKE_INSTALL_BASE_URL: 'https://mirror.test/rel' },
    })
    expect(measured).toBe(0)
    const pinned = calls.find((call) => call.cmd === 'bash' && call.args.length === 0)
    // The user's own value is forwarded untouched, and the updater does not force the
    // installer to skip its own comparison — nothing here was decided for them.
    expect(pinned?.env?.QIALIKE_INSTALL_BASE_URL).toBe('https://mirror.test/rel')
    expect(pinned?.env?.QIALIKE_INSTALL_MEASURE).toBeUndefined()

    // And `QIALIKE_INSTALL_MEASURE=0` is the documented way to refuse the comparison.
    upgrade('0.6.1', {
      installUrl: 'https://install.test/install', dir, run: watching, platform: 'linux',
      env: { QIALIKE_INSTALL_MEASURE: '0' },
    })
    expect(measured).toBe(0)
  })
})
