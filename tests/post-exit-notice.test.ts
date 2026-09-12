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
} from '../packages/dsh-tui-app/src/post-exit-notice.ts'

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
  const appSource = readFileSync(new URL('../packages/dsh-tui-app/src/index.tsx', import.meta.url), 'utf8')

  test('the channel is armed immediately after the leave write', () => {
    const leave = appSource.indexOf('\\x1b[?1049l')
    const armed = appSource.indexOf('armPostExitNotices(flushPostExitNotices)')
    expect(leave).toBeGreaterThan(-1)
    expect(armed).toBeGreaterThan(leave)
  })

  test('the fatal start path queues the notice instead of writing stderr directly', () => {
    // Writing stderr directly is the P2 bug: while the read-only screen is up,
    // that line lands in the alternate buffer and is discarded with it.
    expect(appSource).toContain('postExitNotice(`dsh-tui: ${message}\\n`)')
    expect(appSource).not.toContain('process.stderr.write(`dsh-tui: ${message}\\n`)')
  })
})
