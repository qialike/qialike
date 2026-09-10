/**
 * Tests for the host-mode prompt gate (host-prompt-queue.ts), plus the wiring
 * guard that keeps the two host-attach paths honest.
 *
 * The wiring guard is source-level on purpose: the bug it pins (a non-file
 * launch leaving every prompt queued forever) came from WHERE the gate was
 * opened — a behavioural test would have to boot the whole runtime to see it,
 * while the invariant is a single call site.
 *
 * Run with `bun test tests/host-prompt-queue.test.ts`.
 *
 * @module dsh-tui/host-prompt-queue-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createPromptQueue } from '../packages/dsh-tui-app/src/host-prompt-queue.ts'

/** Collect what a release sent. */
function collector(): { sent: unknown[][]; send: (blocks: readonly unknown[]) => void } {
  const sent: unknown[][] = []
  return { sent, send: (blocks) => { sent.push([...blocks]) } }
}

describe('PromptQueue', () => {
  test('holds prompts until the host attaches, then sends them in order', () => {
    const queue = createPromptQueue()
    expect(queue.ready).toBe(false)
    expect(queue.enqueue([{ type: 'text', text: 'first' }])).toBe(true)
    expect(queue.enqueue([{ type: 'text', text: 'second' }])).toBe(true)
    expect(queue.size).toBe(2)

    const { sent, send } = collector()
    queue.release(send)
    expect(queue.ready).toBe(true)
    expect(queue.size).toBe(0)
    expect(sent).toEqual([[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]])
  })

  test('sends straight through once ready, and a second release sends nothing', () => {
    const queue = createPromptQueue()
    queue.release(() => {})
    expect(queue.enqueue([{ type: 'text', text: 'now' }])).toBe(false)
    const { sent, send } = collector()
    queue.release(send)
    expect(sent).toEqual([])
  })

  test('holding again re-queues (a switch in flight)', () => {
    const queue = createPromptQueue()
    queue.release(() => {})
    queue.hold()
    expect(queue.ready).toBe(false)
    // Prompts typed while the host still serves the OLD session are held…
    expect(queue.enqueue([{ type: 'text', text: 'for the new session' }])).toBe(true)
    const { sent, send } = collector()
    queue.release(send)
    // …and delivered once the host confirms the new one.
    expect(sent).toEqual([[{ type: 'text', text: 'for the new session' }]])
  })

  test('copies the blocks ARRAY it holds (a later push cannot change a queued prompt)', () => {
    // Block objects are shared by reference on purpose: they are plain JSON by
    // the protocol's contract and are not mutated after submit, so the queue
    // pays nothing for a defensive deep copy on the hot path.
    const queue = createPromptQueue()
    const blocks = [{ type: 'text', text: 'draft' }]
    queue.enqueue(blocks)
    blocks.push({ type: 'text', text: 'appended after submit' })
    const { sent, send } = collector()
    queue.release(send)
    expect(sent).toEqual([[{ type: 'text', text: 'draft' }]])
  })

  test('re-entrant send during release still sees an emptied queue', () => {
    const queue = createPromptQueue()
    queue.enqueue([{ type: 'text', text: 'one' }])
    const seen: number[] = []
    queue.release(() => { seen.push(queue.size) })
    expect(seen).toEqual([0])
  })
})

describe('host prompt gate wiring (regression guard)', () => {
  const source = readFileSync(new URL('../packages/dsh-tui-app/src/index.tsx', import.meta.url), 'utf8')

  test('every host attach path opens the gate through one helper', () => {
    // `hostReady` is gone: readiness lives in the queue, opened by `releaseHostPrompts`.
    expect(source).not.toContain('hostReady')
    expect(source).not.toContain('pendingPrompts')
    expect(source).toContain('createPromptQueue()')
    expect(source).toContain('const releaseHostPrompts = ')
  })

  test('the host-paged path opens the gate too (the M6.1b regression)', () => {
    // A launch that renders from the host's pages instead of the log file must
    // still open the gate, or every prompt typed in a new session queues forever.
    const serve = source.slice(source.indexOf('const serveHostSession = async ('))
    const body = serve.slice(0, serve.indexOf('\n  /**'))
    expect(body).toContain('releaseHostPrompts(')
  })

  test('the file-backed path still opens it after the host catches up', () => {
    const opens = source.split('releaseHostPrompts(').length - 1
    // helper definition + serveHostSession + both phase-2 warm-ups … at least 3 call sites.
    expect(opens).toBeGreaterThanOrEqual(3)
  })
})
