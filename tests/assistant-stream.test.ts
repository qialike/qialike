/**
 * Pin the in-process live-delta wiring.
 *
 * Harness 0.1.5 removed the durable `assistant/chunk` events a transcript used
 * to stream from: token deltas now arrive as `agent/assistant-stream` frames,
 * and only the settled `assistant/message` reaches the session log. The P4c
 * host used to own that subscription and forward the chunks to the client; with
 * the two-process split removed the subscription has to live in the client
 * process or every turn would appear at once, at the end, with no streaming.
 *
 * Source-level, because the wiring is a cordis subscription inside `start()`
 * (there is no seam to call in a unit test).
 *
 * Run with `bun test tests/assistant-stream.test.ts`.
 *
 * @module dsh-tui/assistant-stream-test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(join(process.cwd(), 'packages/dsh-tui-app/src/index.tsx'), 'utf8')

describe('live model deltas reach the transcript in-process', () => {
  test('the client subscribes to `agent/assistant-stream` itself', () => {
    expect(source).toContain("ctx.on('agent/assistant-stream'")
  })

  test('only the shown session is streamed, and only chunk frames are applied', () => {
    const start = source.indexOf("ctx.on('agent/assistant-stream'")
    const bodyStart = source.indexOf('=> {', start) + '=> {'.length
    const body = source.slice(bodyStart, source.indexOf('\n  })', bodyStart))
    // Same session filter as the `agent/status` subscription: a switch must not
    // leak the previous agent's deltas into the new transcript.
    expect(body).toContain('if (payload.agent.id !== sessionId) return')
    expect(body).toContain("if (payload.frame?.type !== 'chunk') return")
    expect(body).toContain('applyModelDelta(payload.frame.chunk)')
    // The label must clear on the first delta, not only on the settled message.
    expect(body).toContain('store.endPreparingRequest()')
  })

  test('the legacy durable path is still accepted for old sessions', () => {
    expect(source).toContain("if (rawType === 'assistant/chunk')")
    expect(source).toContain('applyModelDelta((event as unknown as { data?: { chunk?:')
  })
})
