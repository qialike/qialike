/**
 * The post-exit notice channel, and the wiring that makes it the LAST thing on
 * the terminal.
 *
 * P2: a fatal reason written while the alternate screen is up is discarded when
 * the buffer is left. The rule this module owns is "notices queued here are
 * written after the leave sequence", which rests on `'exit'` listeners running
 * in registration order — so that ordering is asserted here rather than assumed.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  armPostExitNotices,
  flushPostExitNotices,
  postExitNotice,
  resetPostExitNotices,
} from '../packages/qialike-app/src/post-exit-notice.ts'

const written: string[] = []
const capture = (text: string): void => {
  written.push(text)
}

afterEach(() => {
  resetPostExitNotices()
  written.length = 0
})

describe('post-exit notices', () => {
  test('before the channel is armed a notice is written straight away', () => {
    // A failure that never reached the exit registration has nothing to drain
    // it, and happens before any frame — so the buffer is not up and this write
    // is visible.
    resetPostExitNotices(capture)
    postExitNotice('immediate\n')
    expect(written).toEqual(['immediate\n'])
  })

  test('once armed, notices wait for the flush and keep their order', () => {
    resetPostExitNotices(capture)
    armPostExitNotices(flushPostExitNotices)
    postExitNotice('first\n')
    postExitNotice('second\n')
    expect(written).toEqual([]) // nothing may be written before the leave
    flushPostExitNotices()
    expect(written).toEqual(['first\n', 'second\n'])
    flushPostExitNotices() // idempotent: nothing is written twice
    expect(written).toEqual(['first\n', 'second\n'])
  })

  test('the flush listener runs AFTER a leave writer registered earlier', () => {
    // The load-bearing guarantee: arming after the leave writer makes the notice
    // outlive the alternate screen.
    resetPostExitNotices(capture)
    const leave = (): void => { written.push('LEAVE\n') }
    process.once('exit', leave)
    const flush = (): void => { flushPostExitNotices() }
    armPostExitNotices(flush)
    const order = process.listeners('exit')
    expect(order.indexOf(leave)).toBeGreaterThan(-1)
    expect(order.indexOf(flush)).toBeGreaterThan(order.indexOf(leave))
    process.removeListener('exit', leave)
  })

  test('a second arming is ignored (one flush listener owns the queue)', () => {
    resetPostExitNotices(capture)
    const first = (): void => { flushPostExitNotices() }
    armPostExitNotices(first)
    armPostExitNotices(flushPostExitNotices)
    expect(process.listeners('exit').filter((l) => l === first)).toHaveLength(1)
    expect(process.listeners('exit')).not.toContain(flushPostExitNotices)
  })
})

describe('the wiring in index.tsx', () => {
  const appSource = readFileSync(new URL('../packages/qialike-app/src/index.tsx', import.meta.url), 'utf8')
  const noticesSource = readFileSync(
    new URL('../packages/qialike-app/src/post-exit-notice.ts', import.meta.url), 'utf8',
  )

  // The leave WRITE expression, anchored on `writeSync(1, '…1049l')` rather than
  // on a frozen prefix: the sequence legitimately grows (it now also closes the
  // synchronized-output mode, see `__dshFrameEnvelope`), and pinning the whole
  // literal made an added mode look like a missing write. The regex still cannot
  // match the P2 comment above, which has no `writeSync(1, '`.
  const LEAVE_WRITE_RE = /writeSync\(1, '[^']*\\x1b\[\?1049l'\)/

  test('the channel is armed immediately after the leave WRITE', () => {
    const m = LEAVE_WRITE_RE.exec(appSource)
    expect(m, 'the leave write exists').not.toBeNull()
    const armed = appSource.indexOf('armPostExitNotices(flushPostExitNotices)')
    expect(armed).toBeGreaterThan(m!.index)
  })

  test('both the leave and the notice are written synchronously', () => {
    // The order only holds because BOTH writes are sync: an async leave (a
    // Windows TTY, a POSIX pipe) could be overtaken by the sync notice.
    expect(appSource, 'the leave is a sync write').toMatch(LEAVE_WRITE_RE)
    // …and it must not ALSO be written asynchronously anywhere.
    expect(appSource).not.toContain("process.stdout.write('\\x1b[0 q")
    expect(appSource).not.toContain("process.stdout.write('\\x1b[?2026l")
    // Every mode the leave opens/closes must be reset in that same write: the
    // synchronized-output mode would leave a supporting terminal buffering.
    const leave = LEAVE_WRITE_RE.exec(appSource)![0]
    expect(leave, 'closes synchronized output').toContain('\\x1b[?2026l')
    expect(leave, 'restores the cursor shape').toContain('\\x1b[0 q')
    expect(leave, 're-shows the cursor').toContain('\\x1b[?25h')
    expect(noticesSource).toContain('writeSync(2, text)')
  })

  test('the fatal start path queues the notice instead of writing stderr directly', () => {
    // Writing stderr directly is the P2 bug: while the read-only screen is up,
    // that line lands in the alternate buffer and is discarded with it.
    expect(appSource).toContain('postExitNotice(`qialike: ${message}\\n`)')
    expect(appSource).not.toContain('process.stderr.write(`qialike: ${message}\\n`)')
  })

  test('the hard-crash handler queues its one line too, and keeps the stack in the file', () => {
    const from = appSource.indexOf("process.on('uncaughtException'")
    const to = appSource.indexOf("process.on('unhandledRejection'", from)
    const handler = appSource.slice(from, to)
    expect(from).toBeGreaterThan(-1)
    expect(handler).toContain('postExitNotice(')
    expect(handler).toContain("logErrorFileOnly('uncaughtException'")
    expect(handler).not.toContain("logError('uncaughtException'")
  })

  test('the unhandled-rejection handler queues its line too (fatal in this launcher)', () => {
    // Our own handler does not exit, but bin.ts installs the harness's fail-loud
    // handler, which does — so this is a fatal path in this launcher, and the
    // line has to survive the alternate screen like any other.
    const from = appSource.indexOf("process.on('unhandledRejection'")
    const to = appSource.indexOf('// Capture console.error', from)
    const handler = appSource.slice(from, to)
    expect(from).toBeGreaterThan(-1)
    expect(handler).toContain('postExitNotice(')
    expect(handler).toContain("logErrorFileOnly('unhandledRejection'")
    expect(handler).not.toContain("logError('unhandledRejection'")
  })
})
