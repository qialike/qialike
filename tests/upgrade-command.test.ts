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
import { runUpgrade, scheduleAutoCheck, UPGRADE_HELP } from '../apps/tui-bin/src/upgrade-command.ts'

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
  test('the child is invoked as `upgrade --auto` and its stdout becomes notifications', async () => {
    const dir = tempDir('qialike-autocheck-')
    const record = join(dir, 'args.txt')
    const script = join(dir, 'fake-qialike')
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" > ${record}\necho "updated to qialike 9.9.9 — restart to use it"\n`)
    chmodSync(script, 0o755)

    const notified: string[] = []
    scheduleAutoCheck({ execPath: script, notify: (m) => notified.push(m), delayMs: 10 })

    // Poll rather than sleep a fixed amount: the relay is asynchronous.
    const deadline = Date.now() + 5_000
    while (notified.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(notified).toEqual(['updated to qialike 9.9.9 — restart to use it'])
    // The child is what applies the policy; the parent must not second-guess it.
    expect(readFileSync(record, 'utf8').trim()).toBe('upgrade --auto')
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

  test('an extra positional is refused rather than silently ignored', () => {
    const { err, sink } = io()
    expect(runUpgrade(['0.6.0', '0.7.0'], sink)).toBe(1)
    expect(err.join('\n')).toContain("unexpected extra argument '0.7.0'")
  })
})
