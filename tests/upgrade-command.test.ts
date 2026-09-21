/**
 * Tests for `upgrade-command.ts` — the launcher side of automatic update.
 *
 * Two properties matter and neither is observable from a running TUI:
 *
 *  - the automatic check actually SPAWNS `upgrade --auto` and relays what the
 *    child reports (the TUI's only channel for it is `tui.notify`);
 *  - a disabled check spawns NOTHING. That is the promise the test harnesses rely
 *    on, and "spawns a process that does nothing" would not keep it.
 *
 * The child is replaced by a script through the injectable `execPath`, so these
 * run offline and deterministically — polling `ps` for a process that exits in
 * milliseconds is a race, not a test.
 *
 * `runUpgrade`'s own argument handling is covered with an explicit version, which
 * is the form that resolves no release over the network.
 *
 * Run with `bun test tests/upgrade-command.test.ts`.
 *
 * @module qialike/upgrade-command-test
 */

import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runUpgrade, scheduleAutoCheck, updateNotice, UPGRADE_HELP } from '../apps/tui-bin/src/upgrade-command.ts'
import { DEFAULT_RELEASES_URL, MIRROR_RELEASES_URL, assetFor, detectTarget } from '../packages/qialike-app/src/self-update.ts'

const temporaries: string[] = []
process.on('exit', () => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaries.push(dir)
  return dir
}

/** Collects `out`/`err` lines and a version, for driving `runUpgrade` offline. */
function io(installed = '0.6.0') {
  const out: string[] = []
  const err: string[] = []
  return { out, err, sink: { installed, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}

describe('the automatic check spawns the launcher mode and relays its report', () => {
  test('the child is invoked as `upgrade --auto --json` and its notice becomes notifications', async () => {
    const dir = tempDir('qialike-autocheck-')
    const record = join(dir, 'args.txt')
    const script = join(dir, 'fake-qialike')
    // The report line goes LAST, exactly as the launcher prints it — the relay must
    // keep it out of the user's notices whether it is acted on or not.
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" > ${record}\necho "updated to qialike 9.9.9 — restart to use it"\necho '{"decision":"install","installed":"0.6.0","newest":"9.9.9","relation":"minor","canSelfInstall":true,"downloads":[],"ok":true}'\n`)
    chmodSync(script, 0o755)

    const notified: string[] = []
    // `env` is passed EXPLICITLY, and empty: without it the check reads the
    // ambient environment, so a shell (or the release gate) that exports
    // QIALIKE_DISABLE_AUTOUPDATE would switch the spawn off — correctly — and this
    // test would then fail for a reason that has nothing to do with the relay.
    scheduleAutoCheck({ execPath: script, notify: (m) => notified.push(m), delayMs: 10, env: {} })

    // Poll rather than sleep a fixed amount: the relay is asynchronous.
    const deadline = Date.now() + 5_000
    while (notified.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    // An install that landed is announced as text (the child already did the work),
    // and the machine-readable report is NOT shown to the user.
    expect(notified).toEqual(['updated to qialike 9.9.9 — restart to use it'])
    // The child is what applies the policy; the parent must not second-guess it.
    expect(readFileSync(record, 'utf8').trim()).toBe('upgrade --auto --json')
  })

  test('a newer release on Windows becomes the status-line hint, not a notice', async () => {
    // Windows cannot install the release itself, so the answer is the one-line hint
    // the TUI paints (hero row / docked status bar). `notify` must stay silent —
    // otherwise the same release is announced twice, once as a hint and once as a
    // transcript line the user has to act on.
    const dir = tempDir('qialike-autocheck-')
    const script = join(dir, 'fake-qialike')
    const url = 'https://github.com/qialike/qialike/releases/download/9.9.9/qialike-windows-x64.zip'
    writeFileSync(
      script,
      `#!/bin/sh\necho "qialike 9.9.9 is available (you have 0.6.0) — download it and replace the file by hand:"\necho "  ${url}"\necho '{"decision":"notify","installed":"0.6.0","newest":"9.9.9","relation":"minor","canSelfInstall":false,"downloads":["${url}"]}'\n`,
    )
    chmodSync(script, 0o755)

    const notified: string[] = []
    const hinted: { installed: string; version: string; urls: readonly string[] }[] = []
    scheduleAutoCheck({
      execPath: script,
      notify: (m) => notified.push(m),
      onUpdate: (offer) => hinted.push(offer),
      platform: 'win32',
      delayMs: 10,
      env: {},
    })

    const deadline = Date.now() + 5_000
    while (hinted.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(hinted).toEqual([{ installed: '0.6.0', version: '9.9.9', urls: [url] }])
    expect(notified).toEqual([])
  })

  test('the SAME answer on linux/macOS stays a notice (the auto-update path is untouched)', async () => {
    // The requirement this pins: the hint is Windows-specific handling. A POSIX copy
    // — including one no installer manages, which is what `canSelfInstall: false`
    // describes there too — must keep the pre-existing behaviour word for word.
    const dir = tempDir('qialike-autocheck-')
    const script = join(dir, 'fake-qialike')
    writeFileSync(
      script,
      `#!/bin/sh\necho "qialike 9.9.9 is available (you have 0.6.0) — download it and replace the file by hand:"\necho '{"decision":"notify","installed":"0.6.0","newest":"9.9.9","relation":"minor","canSelfInstall":false,"downloads":["https://x"]}'\n`,
    )
    chmodSync(script, 0o755)

    const notified: string[] = []
    const hinted: unknown[] = []
    scheduleAutoCheck({
      execPath: script,
      notify: (m) => notified.push(m),
      onUpdate: (offer) => hinted.push(offer),
      platform: 'linux',
      delayMs: 10,
      env: {},
    })

    const deadline = Date.now() + 5_000
    while (notified.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(hinted).toEqual([])
    expect(notified).toHaveLength(1)
    expect(notified[0]).toContain('download it and replace the file by hand')
  })

  test('without a hint sink Windows still reaches the user as a notice', async () => {
    // The launcher must not go silent just because nobody wired the status line.
    const dir = tempDir('qialike-autocheck-')
    const script = join(dir, 'fake-qialike')
    writeFileSync(
      script,
      `#!/bin/sh\necho "qialike 9.9.9 is available (you have 0.6.0) — download it and replace the file by hand:"\necho '{"decision":"notify","installed":"0.6.0","newest":"9.9.9","relation":"minor","canSelfInstall":false,"downloads":["https://x"]}'\n`,
    )
    chmodSync(script, 0o755)

    const notified: string[] = []
    scheduleAutoCheck({ execPath: script, notify: (m) => notified.push(m), platform: 'win32', delayMs: 10, env: {} })

    const deadline = Date.now() + 5_000
    while (notified.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(notified).toHaveLength(1)
    expect(notified[0]).toContain('download it and replace the file by hand')
  })

  test('a disabled check spawns nothing at all', async () => {
    const dir = tempDir('qialike-autocheck-')
    const record = join(dir, 'args.txt')
    const script = join(dir, 'fake-qialike')
    writeFileSync(script, `#!/bin/sh\nprintf 'ran\\n' > ${record}\n`)
    chmodSync(script, 0o755)

    const notified: string[] = []
    scheduleAutoCheck({
      execPath: script,
      notify: (m) => notified.push(m),
      delayMs: 10,
      env: { QIALIKE_DISABLE_AUTOUPDATE: '1' } as NodeJS.ProcessEnv,
    })

    await new Promise((resolve) => setTimeout(resolve, 300))
    // No process AND no output: the check returns before the spawn, not inside it.
    expect(existsSync(record)).toBe(false)
    expect(notified).toEqual([])
  })

  test('every truthy spelling disables it', async () => {
    const dir = tempDir('qialike-autocheck-')
    for (const value of ['1', 'true', 'yes', 'on']) {
      const record = join(dir, `args-${value}.txt`)
      const script = join(dir, `fake-${value}`)
      writeFileSync(script, `#!/bin/sh\nprintf 'ran\\n' > ${record}\n`)
      chmodSync(script, 0o755)
      scheduleAutoCheck({
        execPath: script,
        notify: () => { /* nothing should arrive */ },
        delayMs: 10,
        env: { QIALIKE_DISABLE_AUTOUPDATE: value } as NodeJS.ProcessEnv,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    for (const value of ['1', 'true', 'yes', 'on']) {
      expect(existsSync(join(dir, `args-${value}.txt`)), `${value} should not spawn`).toBe(false)
    }
  })
})

describe('runUpgrade argument handling (offline forms)', () => {
  test('--help explains itself and touches nothing', () => {
    const { out, err, sink } = io()
    expect(runUpgrade(['--help'], sink)).toBe(0)
    expect(out.join('\n')).toBe(UPGRADE_HELP)
    expect(err).toEqual([])
  })

  test('an unknown flag is refused with the hint', () => {
    const { out, err, sink } = io()
    expect(runUpgrade(['--bogus'], sink)).toBe(1)
    expect(out).toEqual([])
    expect(err.join('\n')).toContain("unknown option '--bogus'")
    expect(err.join('\n')).toContain('--help')
  })

  test('--check with an explicit version reports the relation without any network', () => {
    // `flags.version` short-circuits release resolution, so this is offline.
    const upToDate = io('0.6.0')
    expect(runUpgrade(['--check', '0.6.0'], upToDate.sink)).toBe(0)
    expect(upToDate.out.join('\n')).toContain('up to date')

    const minor = io('0.6.0')
    expect(runUpgrade(['--check', '0.7.0'], minor.sink)).toBe(0)
    expect(minor.out.join('\n')).toContain('minor update available')

    const major = io('0.6.0')
    expect(runUpgrade(['--check', '1.0.0'], major.sink)).toBe(0)
    expect(major.out.join('\n')).toContain('major update available')
  })

  test('--check names a lagging source as such, never as an available update', () => {
    // When GitHub is unreachable the newest tag comes from a mirror that can be
    // behind, so `newest` is sometimes OLDER than the install. Reporting "patch
    // update available" there would send the user to a downgrade.
    const older = io('0.6.1')
    expect(runUpgrade(['--check', '0.6.0'], older.sink)).toBe(0)
    expect(older.out.join('\n')).toContain('older than installed')
    expect(older.out.join('\n')).not.toContain('update available')
  })

  test('an extra positional is refused rather than silently ignored', () => {
    const { err, sink } = io()
    expect(runUpgrade(['0.6.0', '0.7.0'], sink)).toBe(1)
    expect(err.join('\n')).toContain("unexpected extra argument '0.7.0'")
  })

  test('--check --json answers with one renderable line', () => {
    // Offline: the explicit version short-circuits release resolution. This is the
    // TUI `/upgrade` contract — the kernel parses this line rather than the human
    // report, so its shape is pinned here. The asset name follows the HOST, because
    // the check reports the links for the platform it runs on.
    const { out, err, sink } = io('0.6.1')
    expect(runUpgrade(['--check', '0.6.2', '--json'], sink)).toBe(0)
    expect(err).toEqual([])
    expect(out).toHaveLength(1)
    const asset = assetFor(detectTarget() as string) as string
    expect(JSON.parse(out[0] as string)).toEqual({
      decision: 'check',
      installed: '0.6.1',
      newest: '0.6.2',
      relation: 'patch',
      canSelfInstall: false,
      downloads: [`${DEFAULT_RELEASES_URL}/download/0.6.2/${asset}`, `${MIRROR_RELEASES_URL}/download/0.6.2/${asset}`],
    })
  })

  test('--json without --check or --auto is refused rather than silently ignored', () => {
    // The flag exists for the read-only report and the policy run; accepting it
    // beside an install would make a typo look like it worked.
    const { err, sink } = io()
    expect(runUpgrade(['0.6.2', '--json'], sink)).toBe(1)
    expect(err.join('\n')).toContain('--json requires --check or --auto')
  })

  test('--auto --json reports a refusal as a decision, offline', () => {
    // The startup relay branches on this line, so a deliberate stand-down has to be
    // distinguishable from "no release": the kill switch costs no network at all and
    // still answers.
    const { out, sink } = io('0.6.0')
    expect(runUpgrade(['--auto', '--json'], { ...sink, env: { QIALIKE_DISABLE_AUTOUPDATE: '1' } as NodeJS.ProcessEnv })).toBe(0)
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0] as string)).toEqual({
      decision: 'skip',
      reason: 'disabled',
      installed: '0.6.0',
      newest: null,
      relation: null,
      canSelfInstall: false,
      downloads: [DEFAULT_RELEASES_URL, MIRROR_RELEASES_URL],
    })
  })
})

describe('a newer release is announced in the shape this copy can act on', () => {
  test('a copy the updater can replace is told to run the command', () => {
    // Byte-for-byte the pre-existing notice: Linux behaviour must not move.
    expect(updateNotice({ installed: '0.6.0', version: '0.6.1', canSelfInstall: true, urls: ['https://x'] }))
      .toEqual([`qialike 0.6.1 is available (you have 0.6.0) — run 'qialike upgrade'`])
  })

  test('a copy it cannot replace gets the download links instead', () => {
    // This is the Windows notice (and the hand-placed-binary notice). Naming
    // `qialike upgrade` here would be a dead end: on Windows it refuses, and an
    // unmanaged install cannot replace itself either.
    const lines = updateNotice({
      installed: '0.6.1',
      version: '0.6.2',
      canSelfInstall: false,
      urls: ['https://github.com/qialike/qialike/releases/download/0.6.2/qialike-windows-x64.zip',
        'https://gitcode.com/qialike/qialike/releases/download/0.6.2/qialike-windows-x64.zip'],
    })
    expect(lines[0]).toBe('qialike 0.6.2 is available (you have 0.6.1) — download it and replace the file by hand:')
    expect(lines.slice(1).map((line) => line.trim())).toEqual([
      'https://github.com/qialike/qialike/releases/download/0.6.2/qialike-windows-x64.zip',
      'https://gitcode.com/qialike/qialike/releases/download/0.6.2/qialike-windows-x64.zip',
    ])
    expect(lines.join('\n')).not.toContain("run 'qialike upgrade'")
  })

  test('--check on Windows names the downloads and never the self-update command', () => {
    // Offline: the explicit version short-circuits release resolution, so this is
    // the read-only report plus the links the platform needs.
    const windows = io('0.6.1')
    expect(runUpgrade(['--check', '0.6.2'], { ...windows.sink, platform: 'win32' })).toBe(0)
    const report = windows.out.join('\n')
    expect(report).toContain('patch update available')
    // The links are built from the HOST's asset table: `platform: 'win32'` decides
    // detect-versus-install, it does not make this process a Windows one, so the
    // Windows FILENAME can only be asserted by a run on Windows. What the notice
    // looks like with Windows URLs is pinned byte-for-byte by the pure `updateNotice`
    // case above; here the assertion is about which host each line names.
    const asset = assetFor(detectTarget() as string) as string
    expect(report).toContain(`download   ${DEFAULT_RELEASES_URL}/download/0.6.2/${asset}`)
    expect(report).toContain(`           ${MIRROR_RELEASES_URL}/download/0.6.2/${asset}`)
    // The whole point of the fork: a copy that cannot install is never told to run
    // the command that would refuse.
    expect(report).not.toContain("run 'qialike upgrade'")
  })

  test('an explicit upgrade on Windows refuses and points at the download', () => {
    // No network either: the version is given, and the platform is refused before
    // anything else. Exit 1 because the user asked for something impossible.
    const windows = io('0.6.1')
    expect(runUpgrade(['0.6.2'], { ...windows.sink, platform: 'win32' })).toBe(1)
    const told = windows.err.join('\n')
    expect(told).toContain('Windows has no automatic update')
    const asset = assetFor(detectTarget() as string) as string
    expect(told).toContain(`${DEFAULT_RELEASES_URL}/download/0.6.2/${asset}`)
    expect(told).toContain(MIRROR_RELEASES_URL)
    // Nothing was reported as done.
    expect(windows.out).toEqual([])
  })
})
