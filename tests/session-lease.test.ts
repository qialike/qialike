/**
 * Regression: the session write lease must be REAL, and `/sessions` must refuse
 * to delete a session that another process is still writing.
 *
 * Measured before this change: `apps/tui-bin/build.mjs` installed a no-op
 * `/flock` stub (`tryLockExclusive` granted immediately), mirroring the
 * harness's single-process browser worker. A qialike TUI does NOT own the
 * store — it shares `~/.dsh` with `dsh web` and with a second qialike — so the
 * harness's `SessionWriteLease` excluded nobody and two hosts could append ONE
 * log. That produced the `seq gap` (duplicate/rewound seq) and `torn JSONL
 * record` corruptions which made a session permanently unopenable, and it made
 * a `/sessions` delete silently strand a live writer on an unlinked inode.
 *
 * This test pins the four properties that keep that from coming back:
 *  1. the primitive really contends (two descriptions, one file),
 *  2. the probe answers free/busy without creating files,
 *  3. `deleteSession` refuses while leased and still deletes when free,
 *  4. the build no longer ships the no-op stub.
 *
 * Run with `bun test tests/session-lease.test.ts`.
 *
 * @module qialike/session-lease-test
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_LEASE_FILENAME, probeSessionLease } from '../packages/qialike-app/src/session-lease.ts'
import { flockBackend, isFlockContention, tryLockExclusive } from '../packages/qialike-app/src/flock.ts'
import { deleteSession, encodeSegment, SessionInUseError, sessionDir } from '../packages/qialike-app/src/session-files.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

const home = mkdtempSync(join(tmpdir(), 'qialike-session-lease-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

afterAll(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

const cwd = '/tmp/qialike-session-lease-workspace'
const id = 'session-lease-test' as SessionId

/** Create one session directory holding a log and (optionally) a lock file. */
function makeSession(withLock: boolean): string {
  const dir = sessionDir(cwd, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), '')
  if (withLock) writeFileSync(join(dir, SESSION_LEASE_FILENAME), '')
  return dir
}

describe('flock primitive', () => {
  test('resolves a real backend on POSIX (no silent no-op)', async () => {
    const backend = await flockBackend()
    if (process.platform === 'linux' || process.platform === 'darwin') {
      expect(backend).not.toBe('unavailable')
    }
  })

  test('a second description of one file contends', async () => {
    const dir = mkdtempSync(join(home, 'primitive-'))
    const path = join(dir, SESSION_LEASE_FILENAME)
    writeFileSync(path, '')
    const holder = openSync(path, 'a+')
    const other = openSync(path, 'a+')
    await tryLockExclusive(holder)
    let contended = false
    try {
      await tryLockExclusive(other)
    } catch (error) {
      contended = isFlockContention(error)
    }
    closeSync(other)
    closeSync(holder)
    if (process.platform === 'linux' || process.platform === 'darwin') expect(contended).toBe(true)
  })
})

describe('probeSessionLease', () => {
  test('no lock file means no holder', async () => {
    makeSession(false)
    expect(await probeSessionLease(sessionDir(cwd, id))).toBe('free')
    // The probe must not materialize a lock file: it opens read-only.
    expect(existsSync(join(sessionDir(cwd, id), SESSION_LEASE_FILENAME))).toBe(false)
  })

  test('an idle lock file is free, a held one is busy', async () => {
    const dir = makeSession(true)
    expect(await probeSessionLease(dir)).toBe('free')
    const holder = openSync(join(dir, SESSION_LEASE_FILENAME), 'a+')
    await tryLockExclusive(holder)
    expect(await probeSessionLease(dir)).toBe('busy')
    closeSync(holder)
    expect(await probeSessionLease(dir)).toBe('free')
  })

  test('a missing directory has no holder; an unopenable lock path is unavailable', async () => {
    // ENOENT on the lock file means no descriptor exists, so nobody can hold a
    // lease: the delete may proceed (and is a no-op for a missing directory).
    expect(await probeSessionLease(join(home, 'does-not-exist'))).toBe('free')
    // Anything else that keeps us from OPENING the lock file (here a symlink
    // loop -> ELOOP, the same path as an EACCES lock) is the "cannot tell"
    // case: callers keep their historical behaviour rather than block forever.
    const dir = join(home, 'unopenable')
    mkdirSync(dir, { recursive: true })
    try {
      symlinkSync(SESSION_LEASE_FILENAME, join(dir, SESSION_LEASE_FILENAME))
    } catch {
      return // no symlink support on this host: nothing to assert
    }
    expect(await probeSessionLease(dir)).toBe('unavailable')
  })
})

describe('deleteSession lease guard', () => {
  test('refuses while another holder owns the lease, then deletes after release', async () => {
    const dir = makeSession(true)
    const holder = openSync(join(dir, SESSION_LEASE_FILENAME), 'a+')
    await tryLockExclusive(holder)
    guard: {
      if (await flockBackend() === 'unavailable') break guard // no kernel lock here
      await expect(deleteSession(cwd, id)).rejects.toThrow(SessionInUseError)
      expect(existsSync(dir)).toBe(true)
    }
    closeSync(holder)
    await deleteSession(cwd, id)
    expect(existsSync(dir)).toBe(false)
  })

  test('refusal is actionable and names the other holder', async () => {
    const error = new SessionInUseError(id)
    expect(error.name).toBe('SessionInUseError')
    expect(error.message).toContain('is being written by another process')
    expect(error.message).toContain('close it there and retry')
  })

  test('an injected busy probe blocks deletion; unavailable does not', async () => {
    const dir = makeSession(true)
    await expect(deleteSession(cwd, id, { probe: async () => 'busy' })).rejects.toThrow(SessionInUseError)
    expect(existsSync(dir)).toBe(true)
    await deleteSession(cwd, id, { probe: async () => 'unavailable' })
    expect(existsSync(dir)).toBe(false)
  })
})

describe('build wiring', () => {
  test('the no-op flock stub is gone; the real primitive is re-exported', () => {
    const build = readFileSync(join(import.meta.dir, '..', 'apps', 'tui-bin', 'build.mjs'), 'utf8')
    expect(build).not.toContain('export async function tryLockExclusive(_fd)')
    expect(build).toContain("export { tryLockExclusive } from '@qialike/qialike-app/src/flock.ts'")
  })

  test('the deleted session directory name is the harness encoding', () => {
    expect(encodeSegment(id)).toBe(String(id))
  })
})
