import { describe, expect, test } from 'bun:test'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import {
  Store,
  compactionFailureText,
  compactionStatusText,
  formatCompactTokens,
  type CompactionState,
} from '../packages/qialike-app/src/index.tsx'

/** One compaction state with defaults a test can override. */
function state(over: Partial<CompactionState> = {}): CompactionState {
  return { startedAt: 0, phase: 'summarizing', tokens: 0, estimated: true, queued: 0, ...over }
}

describe('compaction status text', () => {
  test('the selecting phase carries a label but NEVER a clock', () => {
    // The harness walks the session surface synchronously here (measured: 4.04 s
    // holding the only JS thread), so seconds would freeze and read as a hang.
    const line = compactionStatusText(state({ phase: 'selecting', startedAt: 0 }), 12_000, true)
    expect(line).toBe('Compacting:  selecting older history…')
    expect(line).not.toContain('s ·')
    expect(line).not.toMatch(/[0-9]/)
  })

  test('summarizing shows the estimate against the harness budget', () => {
    const line = compactionStatusText(state({ tokens: 1234, budget: 8192 }), 12_400, true)
    expect(line).toBe('Compacting:  summarizing · ~1.2k/8.2k tokens · 12.4s')
  })

  test('provider usage replaces the estimate (no tilde)', () => {
    const line = compactionStatusText(state({ tokens: 2048, estimated: false, budget: 8192 }), 30_000, true)
    expect(line).toContain('· 2.0k/8.2k tokens')
    expect(line).not.toContain('~')
  })

  test('no token tail before the first delta, and no clock before the ticker fired', () => {
    expect(compactionStatusText(state(), 12_400, false)).toBe('Compacting:  summarizing')
    expect(compactionStatusText(state(), 12_400, true)).toBe('Compacting:  summarizing · 12.4s')
  })

  test('a budget-less stream still reports its raw count', () => {
    expect(compactionStatusText(state({ tokens: 950 }), 5000, true))
      .toBe('Compacting:  summarizing · ~950 tokens · 5.0s')
  })

  test('committing is a labelled phase with the same clock rule', () => {
    expect(compactionStatusText(state({ phase: 'committing' }), 9_000, false)).toBe('Compacting:  committing…')
    expect(compactionStatusText(state({ phase: 'committing' }), 9_000, true)).toBe('Compacting:  committing… · 9.0s')
  })

  test('queued submits are announced (the harness holds waking input)', () => {
    expect(compactionStatusText(state({ queued: 2 }), 1000, false)).toBe('Compacting:  summarizing · 2 queued')
    expect(compactionStatusText(state({ phase: 'selecting', queued: 1 }), 1000, false))
      .toBe('Compacting:  selecting older history… · 1 queued')
  })

  test('compact token formatting', () => {
    expect(formatCompactTokens(0)).toBe('0')
    expect(formatCompactTokens(-5)).toBe('0')
    expect(formatCompactTokens(950)).toBe('950')
    expect(formatCompactTokens(1234)).toBe('1.2k')
    expect(formatCompactTokens(8192)).toBe('8.2k')
  })
})

describe('compaction failure text', () => {
  test('shows the harness reason next to the generic per-code sentence', () => {
    // The real report: two /compact runs failed after ~14 s with only the
    // generic sentence, hiding the actual refusal.
    const text = compactionFailureText(new ManualCompactionError(
      'summary',
      'summary is not smaller than the shadowed content (8123 estimated framed tokens >= 5120)',
    ))
    expect(text).toContain('Compaction could not produce a useful summary.')
    expect(text).toContain('summary is not smaller than the shadowed content')
    expect(text).toContain('8123 estimated framed tokens >= 5120')
  })

  test('cancellation keeps the harness sentence and drops the abort artifact', () => {
    // Esc aborts through the fetch seam, whose message is `abort@[native code]`
    // — noise, not a reason (observed on a real terminal run).
    const text = compactionFailureText(new ManualCompactionError('cancelled', 'abort@[native code]'))
    expect(text).toBe('Compaction cancelled.')
    expect(text).not.toContain('native code')
  })

  test('our own abort reads as a cancellation, not a failure', () => {
    // Measured: the harness rethrows the raw abort reason verbatim, so Esc
    // surfaced as `compaction: The operation was aborted.` — the caller knows
    // it cancelled, so the harness's cancelled sentence is the honest text.
    expect(compactionFailureText(new Error('The operation was aborted.'), true))
      .toBe('Compaction cancelled.')
    expect(compactionFailureText(new Error('The operation was aborted.')))
      .toBe('compaction: The operation was aborted.')
  })

  test('a reason already inside the generic text is not repeated', () => {
    const base = 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.'
    expect(compactionFailureText(new ManualCompactionError('busy', base))).toBe(base)
  })

  test('unclassified errors and empty messages stay one line', () => {
    expect(compactionFailureText(new Error('boom'))).toBe('compaction: boom')
    expect(compactionFailureText(new Error(''))).toBe('compaction: unknown error')
    expect(compactionFailureText('plain string')).toBe('compaction: plain string')
    const clipped = compactionFailureText(new Error('x'.repeat(500)))
    expect(clipped.length).toBeLessThan(280)
    expect(clipped.endsWith('…')).toBe(true)
  })
})

describe('Store compaction state', () => {
  test('begin → phases → token reports → end', () => {
    const store = new Store()
    expect(store.compactionActive).toBe(false)
    store.beginCompaction(1000)
    expect(store.compactionActive).toBe(true)
    expect(store.compaction?.phase).toBe('selecting')
    expect(store.compactionTicked).toBe(false)

    store.noteCompactionPhase('summarizing')
    store.noteCompactionTokens(1200, true, 8192)
    store.noteCompactionQueued()
    store.tickCompaction()
    expect(store.compaction).toEqual({
      startedAt: 1000, phase: 'summarizing', tokens: 1200, estimated: true, budget: 8192, queued: 1,
    })
    expect(store.compactionTicked).toBe(true)

    store.endCompaction()
    expect(store.compaction).toBeNull()
    expect(store.compactionActive).toBe(false)
    expect(store.compactionTicked).toBe(false)
  })

  test('the token readout never goes backwards and needs an active run', () => {
    const store = new Store()
    store.noteCompactionTokens(500, true, 8192) // no run → dropped
    expect(store.compaction).toBeNull()
    store.beginCompaction(0)
    store.noteCompactionTokens(900, true, 8192)
    store.noteCompactionTokens(120, true, 8192) // a later, smaller report
    expect(store.compaction?.tokens).toBe(900)
    store.noteCompactionTokens(900, false, 8192) // provider usage confirms it
    expect(store.compaction?.estimated).toBe(false)
  })

  test('Esc is wired to the harness abort seam', () => {
    const store = new Store()
    let aborts = 0
    store.beginCompaction(0)
    store.setCompactionCancel(() => { aborts += 1 })
    store.cancelCompaction()
    expect(aborts).toBe(1)
    store.setCompactionCancel(null)
    expect(() => store.cancelCompaction()).not.toThrow()
    expect(aborts).toBe(1)
  })

  test('phases are idempotent and ignored after the run ends', () => {
    const store = new Store()
    store.beginCompaction(0)
    store.noteCompactionPhase('committing')
    store.noteCompactionPhase('committing')
    expect(store.compaction?.phase).toBe('committing')
    store.endCompaction()
    store.noteCompactionPhase('summarizing')
    store.noteCompactionQueued()
    store.tickCompaction()
    expect(store.compaction).toBeNull()
  })
})
