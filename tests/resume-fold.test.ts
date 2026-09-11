/**
 * Tests for the chunked-resume fold planner (`resume-fold.ts`, the L1 giant-
 * session fast-start fix).
 *
 * Folding a very long durable event log synchronously freezes the first frame
 * for seconds, so a large resume now paints only the newest tail immediately
 * and folds the older ranges in background slices. The planner must cut the
 * log ONLY at "safe" boundaries: places where no tool call is still awaiting
 * its result and we are not inside a reasoning-delta run — otherwise a
 * `tool/result` in a later slice would find no tool row to settle, or one
 * Think row would render as two.
 *
 * Run with `bun test tests/resume-fold.test.ts`.
 *
 * @module dsh-tui/resume-fold-test
 */

import { describe, expect, test } from 'bun:test'
import {
  describeResumeFailure,
  isCorruptLogMessage,
  planResumeFold,
  safeBoundaries,
  tailSlice,
} from '../packages/dsh-tui-app/src/resume-fold.ts'

/** Build one planner event. */
function ev(type: string): { type: string } {
  return { type }
}
/** A reasoning-delta chunk event. */
function rd(text = 'x'): { type: string; data: { chunk: { type: string; text: string } } } {
  return { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text } } }
}
/** A plain text-delta chunk (no item effect in the fold). */
function td(): { type: string; data: { chunk: { type: string } } } {
  return { type: 'assistant/chunk', data: { chunk: { type: 'text-delta' } } }
}

describe('safeBoundaries (a cut is only safe when the fold state is clean)', () => {
  test('nearly every position after a settled event is safe', () => {
    const events = [
      ev('session'),
      ev('user/message'),
      ev('assistant/message'),
      ev('tool/call'),
      ev('tool/result'),
      ev('assistant/message'),
    ]
    // Slices may start after any settled row (1, 2, 3), then only once the
    // tool call is resolved (5) and at the log end (6).
    expect(safeBoundaries(events)).toEqual([1, 2, 3, 5, 6])
  })

  test('never cuts inside an open tool chain (call and its result stay together)', () => {
    const events = [
      ev('user/message'),
      ev('tool/call'),
      ev('user/message'), // tool/result of a LATER call, but the first is open
      ev('assistant/chunk'), // (text-delta content of the running tool step)
      ev('tool/result'),
      ev('assistant/message'),
    ]
    const safe = safeBoundaries(events)
    // Starts 1..5 have an open call; only after the result resolves (6) is a
    // new slice allowed (plus the settled start at 2).
    expect(safe).toEqual([1, 5, 6])
  })

  test('never cuts inside a reasoning-delta run', () => {
    const events = [
      ev('user/message'),
      rd('a'),
      rd('b'),
      rd('c'),
      ev('assistant/message'),
    ]
    const safe = safeBoundaries(events)
    expect(safe).toEqual([1, 5]) // deltas stay whole: starts only before and after the run
  })

  test('interleaved open chains leave the safe set at the balanced points only', () => {
    // call A, call B, result A, result B: while either is open no cut is safe.
    const events = [
      ev('user/message'),
      ev('tool/call'), // A
      ev('tool/call'), // B
      ev('tool/result'), // A → B still open
      ev('tool/result'), // B → balanced again
      ev('assistant/message'),
    ]
    expect(safeBoundaries(events)).toEqual([1, 5, 6])
  })
})

describe('planResumeFold (fast single pass vs tail-first chunked)', () => {
  test('small logs keep the original single-pass fold', () => {
    const events = Array.from({ length: 8 }, () => ev('user/message'))
    expect(planResumeFold(events, { fastEvents: 10, tailEvents: 6, sliceEvents: 3 }))
      .toEqual({ mode: 'fast' })
  })

  test('chunked tail covers ≥ tailEvents events and starts at a safe boundary', () => {
    // 26 events: fill with user/message pairs (every position safe) but force a
    // mid-log unsafe region (an open tool chain) to prove the tail escapes it.
    const events: { type: string }[] = []
    events.push(ev('user/message'), ev('assistant/message'))
    for (let i = 0; i < 6; i++) events.push(ev('tool/call'))
    for (let i = 0; i < 6; i++) events.push(ev('tool/result'))
    while (events.length < 26) events.push(ev('user/message'), ev('assistant/message'))
    const plan = planResumeFold(events, { fastEvents: 10, tailEvents: 8, sliceEvents: 4 })
    expect(plan.mode).toBe('chunked')
    if (plan.mode !== 'chunked') return
    // Tail = events[tailStart..]: at least tailEvents long.
    expect(26 - plan.tailStart).toBeGreaterThanOrEqual(8)
    // tailStart itself is a safe boundary (never inside the open-tool region).
    const safe = new Set(safeBoundaries(events))
    expect(safe.has(plan.tailStart)).toBe(true)
  })

  test('olderRanges cover [0, tailStart) contiguously, ascending, size-bounded, safe', () => {
    // A fully-safe stream (alternating user/assistant messages): every cut is
    // safe, so slices land exactly on the budget.
    const events: { type: string }[] = []
    while (events.length < 30) events.push(ev('user/message'), ev('assistant/message'))
    const plan = planResumeFold(events, { fastEvents: 10, tailEvents: 12, sliceEvents: 5 })
    if (plan.mode !== 'chunked') { expect(plan.mode).toBe('chunked'); return }
    const safe = safeBoundaries(events)
    let cursor = 0
    for (const [from, to] of plan.olderRanges) {
      expect(from).toBe(cursor) // contiguous ascending coverage
      expect(to).toBeGreaterThan(from)
      expect(to - from).toBeLessThanOrEqual(5) // slice budget
      expect(from === 0 || safe.includes(from)).toBe(true) // endpoints safe
      expect(safe.includes(to)).toBe(true)
      cursor = to
    }
    expect(cursor).toBe(plan.tailStart)
  })

  test('the background fill order is oldest-last: fold ranges newest first', () => {
    const events = Array.from({ length: 25 }, (_, i) => i % 2 === 0 ? ev('user/message') : ev('assistant/message'))
    const plan = planResumeFold(events, { fastEvents: 10, tailEvents: 8, sliceEvents: 4 })
    if (plan.mode !== 'chunked') { expect(plan.mode).toBe('chunked'); return }
    expect(plan.olderRanges.length).toBeGreaterThan(1)
    // Reversed processing order yields strictly decreasing range starts, so each
    // fold result is prepended directly before the previously painted rows.
    const starts = plan.olderRanges.map(([from]) => from).reverse()
    for (let i = 1; i < starts.length; i++) expect(starts[i]!).toBeLessThan(starts[i - 1]!)
  })

  test('a log with no early safe boundary degrades to the single-pass fold', () => {
    // 40 events where the first 20 are one open chain: no safe boundary exists
    // early enough for a tail, so the plan must fall back to `fast` rather than
    // paint an empty first frame.
    const events: { type: string }[] = []
    for (let i = 0; i < 20; i++) events.push(ev('tool/call'))
    for (let i = 0; i < 20; i++) events.push(ev('tool/result'))
    expect(planResumeFold(events, { fastEvents: 5, tailEvents: 10, sliceEvents: 7 }).mode)
      .toBe('fast')
  })
})

describe('describeResumeFailure (corrupt-log class gets an actionable hint)', () => {
  test('recognizes the seq-gap corrupt-log signature', () => {
    expect(isCorruptLogMessage(
      'corrupt session log: seq gap in committed region at line 93359 (expected 1719888, got 1719875)',
    )).toBe(true)
  })

  test('recognizes the unparsable-record corrupt-log signature', () => {
    expect(isCorruptLogMessage('corrupt session log: unparsable committed event at line 5')).toBe(true)
  })

  test('non-corrupt resume errors pass through unchanged with the resume: prefix', () => {
    expect(isCorruptLogMessage('no agent factory registered (load an agent-loop plugin)')).toBe(false)
    expect(describeResumeFailure(new Error('boom'))).toBe('resume: boom')
    expect(describeResumeFailure('string failure')).toBe('resume: string failure')
  })

  test('a corrupt log explains the possible causes instead of the raw harness text', () => {
    const text = describeResumeFailure(new Error(
      'corrupt session log: seq gap in committed region at line 93359 (expected 1719888, got 1719875)',
    ))
    expect(text).not.toContain('seq gap')
    expect(text).toContain('resume:')
    // Both possible causes are stated — transient concurrent-write reads (already
    // retried) and real mid-log seq damage — with actionable next steps.
    expect(text).toContain('another process is appending to the same session')
    expect(text).toContain('real seq damage')
    expect(text).toContain('delete and rebuild')
  })
})

describe('tailSlice: which events form the first painted frame', () => {
  const log = Array.from({ length: 100 }, (_, i) => ({ type: 'assistant/chunk', seq: i }))
  const plan = { mode: 'chunked', tailStart: 70, olderRanges: [[0, 70]] } as const

  test('the whole log is cut at the plan tailStart', () => {
    expect(tailSlice(plan, log).map((e) => (e as { seq: number }).seq)).toEqual(
      Array.from({ length: 30 }, (_, i) => 70 + i),
    )
  })

  test('a fast plan has no tail cut at all', () => {
    expect(tailSlice({ mode: 'fast' }, log)).toHaveLength(100)
  })
})

