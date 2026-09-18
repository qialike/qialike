/**
 * Notices that must outlive the alternate screen.
 *
 * The TUI paints inside the alternate screen buffer, and its exit handler writes
 * `\x1b[?1049l` LAST on purpose: everything written while the buffer is up is
 * discarded when it is switched back, so no qialike frame is left above the
 * shell prompt. That rule is right for frames and wrong for a fatal reason the
 * user has to read — P2: the F4 attach-stage failure was written to stderr while
 * the read-only first screen had already entered the buffer, so the reason
 * vanished with it and the user was left with a TUI that simply disappeared.
 *
 * So a fatal path QUEUES its notice here instead of writing it, and the exit
 * sequence ARMS the channel at the exact point where it registers its leave
 * writer. `'exit'` listeners run in registration order, so arming after the
 * leave guarantees the notice reaches the terminal AFTER the leave — on the
 * restored normal screen, where it stays above the prompt.
 *
 * Its users are the FATAL paths whose reason a user must read: `start()`'s
 * top-level catch (a resume that cannot be honoured) and the
 * `uncaughtException` handler. Non-fatal diagnostics stay with `logError`: their
 * stderr mirror is invisible while the UI is mounted, but they do not exit, and
 * a notice would only be printed at exit — stale by then. The file log is their
 * record.
 *
 * The write is synchronous (`writeSync`), and so is the leave write in the exit
 * handler that precedes it: only POSIX TTYs are synchronous in that phase, so an
 * async write there can be dropped (Windows TTY, POSIX pipes) — and a sync
 * notice overtaking an async leave would land inside the alternate buffer and be
 * discarded after all. Ordered sync writes are what makes the guarantee hold on
 * every platform.
 *
 * @module @yourname/qialike-app/post-exit-notice
 */
import { writeSync } from 'node:fs'

/** How a notice reaches the terminal; injectable so the rule can be unit-tested. */
export type NoticeWriter = (text: string) => void

const defaultWriter: NoticeWriter = (text) => {
  writeSync(2, text)
}

let pending: string[] = []
let armedFlush: (() => void) | undefined
let writer: NoticeWriter = defaultWriter

/**
 * Arm the channel, called immediately AFTER the terminal-restoring exit handler
 * has been registered (never from inside that handler — the flush must be a
 * separate, later listener). Idempotent: only the first call wins.
 * @param flush - drains the queue; pass {@link flushPostExitNotices}.
 */
export function armPostExitNotices(flush: () => void): void {
  if (armedFlush !== undefined) return
  armedFlush = flush
  process.once('exit', flush)
}

/**
 * Deliver a notice that must survive the alternate screen.
 *
 * Queued once the channel is armed. Before that (a failure on a path that never
 * reached the exit registration) there is nothing to drain it, so it is written
 * straight away — such a failure happens before any frame, so the buffer is not
 * up and the write is visible.
 * @param text - the exact bytes to write, including the trailing newline.
 */
export function postExitNotice(text: string): void {
  if (armedFlush === undefined) {
    try { writer(text) } catch { /* the terminal is gone; nothing else to do */ }
    return
  }
  pending.push(text)
}

/**
 * Write every queued notice, in order, then forget them. Registered as the exit
 * listener that runs after the leave; safe to call more than once.
 */
export function flushPostExitNotices(): void {
  const queued = pending
  pending = []
  for (const text of queued) {
    try { writer(text) } catch { /* the terminal is gone; nothing else to do */ }
  }
}

/**
 * Test seam: disarm, drop queued notices and optionally replace the writer.
 * @param replacement - writer to use until the next reset; the default writes fd 2.
 */
export function resetPostExitNotices(replacement?: NoticeWriter): void {
  if (armedFlush !== undefined) process.removeListener('exit', armedFlush)
  armedFlush = undefined
  pending = []
  writer = replacement ?? defaultWriter
}
