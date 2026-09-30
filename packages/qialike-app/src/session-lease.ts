/**
 * Read-only probe for the harness's per-session write lease.
 *
 * The harness excludes writers with `flock(2)` on `<session dir>/session.lock`
 * (see `@deepseek-ai/dsh-session-persistence-jsonl`, "lease" region): the lock
 * is held for the life of a write handle and the kernel drops it when the
 * holder's descriptor closes or its process dies. qialike's `/sessions` dialog
 * deletes a session by removing its directory directly (the persistence layer
 * exposes no delete API), which is safe only when nobody else has that session
 * open — under `dsh web` so much as a live *reader* is fine, but a live WRITER
 * would keep appending into an unlinked inode and lose everything it writes.
 *
 * The probe therefore asks the kernel the same question the harness asks:
 * open the lock file READ-ONLY (never creating one — no file means no lock can
 * exist, so the lease is free) and try a non-blocking exclusive `flock`.
 *
 *  · `free`        — no other holder; probing released our own lock immediately.
 *  · `busy`        — another process holds the lease; the caller must refuse.
 *  · `unavailable` — cannot tell (no lock file semantics, no flock backend,
 *                    unreadable directory). Callers decide; `/sessions` keeps
 *                    its historical behaviour rather than blocking forever.
 *
 * A NO-OP flock backend makes every probe answer `free`; that is exactly why
 * `flock.ts` replaces the no-op stub the build used to install.
 *
 * @module @qialike/qialike-app/session-lease
 */

import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isFlockContention, tryLockExclusive } from './flock.ts'

/** Base name of the harness's per-session lock file. */
export const SESSION_LEASE_FILENAME = 'session.lock'

/** What a probe learned about one session's write lease. */
export type SessionLeaseState = 'free' | 'busy' | 'unavailable'

/** One lease probe: a session directory in, a state out. */
export type SessionLeaseProbe = (dir: string) => Promise<SessionLeaseState>

/** The locking call a probe uses; injectable so tests can simulate holders. */
export type SessionLeaseLocker = (fd: number) => Promise<void>

/**
 * Ask the kernel whether another process holds this session's write lease.
 *
 * @param dir - the session's directory.
 * @param lock - locking call (defaults to the real `flock(2)` primitive).
 * @returns the lease state; never throws.
 */
export async function probeSessionLease(
  dir: string,
  lock: SessionLeaseLocker = tryLockExclusive,
): Promise<SessionLeaseState> {
  let handle: FileHandle
  try {
    handle = await open(join(dir, SESSION_LEASE_FILENAME), 'r')
  } catch (error) {
    // No lock file ⇒ no descriptor ⇒ nobody can hold an flock on this session.
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'free'
    return 'unavailable'
  }
  try {
    await lock(handle.fd)
    return 'free'
  } catch (error) {
    return isFlockContention(error) ? 'busy' : 'unavailable'
  } finally {
    // Closing releases the probe's own lock; the holder's is unaffected.
    await handle.close().catch(() => undefined)
  }
}
