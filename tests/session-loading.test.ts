/**
 * Tests for the in-flight session SWITCH banner (`/sessions` Enter): the store
 * state the render and the key dispatcher read, and the honest one-line text
 * (no fake percentage — the harness session-open exposes no progress).
 *
 * Run with `bun test tests/session-loading.test.ts`.
 *
 * @module dsh-tui/session-loading-test
 */

import { describe, expect, test } from 'bun:test'
import { COMPACT_HINT_EVENTS, STATS_FULL_SCAN_MAX, Store, compactHintText, formatByteSize, sessionLoadBar, sessionLoadPercent, sessionLoadingStatusText, sessionLoadingText } from '../packages/dsh-tui-app/src/index.tsx'
import type { SessionLoadingState } from '../packages/dsh-tui-app/src/index.tsx'

const BASE: SessionLoadingState = { id: 'session-3c1c6602-1ddc-40ee-a295-f34348c87153', title: 'fix the tests', bytes: 19_300_000, startedAt: 1_000 }

describe('sessionLoadingText', () => {
  test('names the session, its log size and the live elapsed seconds', () => {
    expect(sessionLoadingText(BASE, 1_000)).toBe('fix the tests — 18.4 MB log · 0.0s')
    expect(sessionLoadingText(BASE, 4_250)).toBe('fix the tests — 18.4 MB log · 3.3s')
  })

  test('omits the clock until the loop proved alive (a blocked open must not read 0.0s)', () => {
    expect(sessionLoadingText(BASE, 3_300, false)).toBe('fix the tests — 18.4 MB log')
  })

  test('falls back to a compact id when there is no title, and drops the size when unknown', () => {
    const untitled = { ...BASE, title: undefined, bytes: undefined }
    expect(sessionLoadingText(untitled, 1_000)).toBe('session-…7153 · 0.0s')
    // A blank/whitespace title counts as no title.
    expect(sessionLoadingText({ ...BASE, title: '   ', bytes: undefined }, 1_000)).toContain('session-…7153')
  })

  test('never invents progress: only the elapsed clock moves', () => {
    const a = sessionLoadingText(BASE, 1_000)
    const b = sessionLoadingText(BASE, 60_000)
    expect(a.replace(/[\d.]+s$/, '')).toBe(b.replace(/[\d.]+s$/, ''))
    expect(b.endsWith('59.0s')).toBe(true)
  })
})

describe('formatByteSize', () => {
  test('scales B / KB / MB / GB and survives junk input', () => {
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(2048)).toBe('2.0 KB')
    expect(formatByteSize(1024 * 1024 * 3.5)).toBe('3.5 MB')
    expect(formatByteSize(1024 * 1024 * 1024 * 2)).toBe('2.00 GB')
    expect(formatByteSize(Number.NaN)).toBe('?')
    expect(formatByteSize(-1)).toBe('?')
  })
})

describe('store session-loading state', () => {
  test('begin / tick / end drive the banner and the key suppression flag', () => {
    const store = new Store()
    expect(store.sessionLoading).toBeNull()
    store.beginSessionLoading(BASE)
    expect(store.sessionLoading?.id).toBe(BASE.id)
    // tick only re-renders (state identity is preserved) and unlocks the clock
    const before = store.sessionLoading
    expect(store.sessionLoadingTicked).toBe(false)
    store.tickSessionLoading()
    expect(store.sessionLoading).toBe(before)
    expect(store.sessionLoadingTicked).toBe(true)
    store.endSessionLoading()
    expect(store.sessionLoading).toBeNull()
    expect(store.sessionLoadingTicked).toBe(false)
    // ending twice is a no-op
    store.endSessionLoading()
    expect(store.sessionLoading).toBeNull()
  })

  test('a second begin replaces the first (no stacked banners)', () => {
    const store = new Store()
    store.beginSessionLoading(BASE)
    store.beginSessionLoading({ ...BASE, id: 'session-other', title: 'other' })
    expect(store.sessionLoading?.id).toBe('session-other')
    store.endSessionLoading()
    expect(store.sessionLoading).toBeNull()
  })
})

describe('phase dialog model + progress bar', () => {
  test('percent clamps and survives a zero/undefined denominator', () => {
    expect(sessionLoadPercent({ done: 0, total: 0 })).toBe(0)
    expect(sessionLoadPercent({ done: 5, total: 0 })).toBe(0)
    expect(sessionLoadPercent({ done: 1, total: 4 })).toBe(25)
    expect(sessionLoadPercent({ done: 9, total: 4 })).toBe(100)
    expect(sessionLoadPercent({ done: Number.NaN, total: 10 })).toBe(0)
  })

  test('bar is width-exact and scales with the real counts', () => {
    expect(sessionLoadBar({ done: 0, total: 10 }, 10, false)).toBe('··········')
    expect(sessionLoadBar({ done: 5, total: 10 }, 10, false)).toBe('#####·····')
    expect(sessionLoadBar({ done: 10, total: 10 }, 10, false)).toBe('##########')
    expect(sessionLoadBar({ done: 1, total: 3 }, 9, false)).toHaveLength(9)
    expect([...sessionLoadBar({ done: 1, total: 3 }, 9, true)].every((c) => c === '█' || c === '·')).toBe(true)
    // never narrower than the floor (a 1-col bar is useless)
    expect(sessionLoadBar({ done: 0, total: 1 }, 1, false)).toHaveLength(4)
  })

  test('the step list is a stepper: begin/close/progress mutate in place', () => {
    const store = new Store()
    store.beginSessionLoading({ id: 'session-x', title: 't', bytes: 1024, startedAt: 0 })
    expect(store.sessionLoading?.steps.map((s) => s.phase)).toEqual(['opening'])
    expect(store.sessionLoading?.steps[0]?.ms).toBeUndefined()   // active
    store.beginSessionLoadStep('attaching', 3400)                // closes ① with its measured ms
    expect(store.sessionLoading?.steps.map((s) => [s.phase, s.ms])).toEqual([['opening', 3400], ['attaching', undefined]])
    store.beginSessionLoadStep('tail', 2, { done: 4_000, total: 20_000 })
    expect(store.sessionLoading?.steps.at(-1)?.progress).toEqual({ done: 4_000, total: 20_000 })
    // progress only ever touches the ACTIVE step
    store.setSessionLoadProgress(8_000, 20_000)
    expect(store.sessionLoading?.steps.at(-1)?.progress).toEqual({ done: 8_000, total: 20_000 })
    expect(store.sessionLoading?.steps[0]?.progress).toBeUndefined()
    store.beginSessionLoadStep('ready', 5)
    expect(store.sessionLoading?.steps.map((s) => s.phase)).toEqual(['opening', 'attaching', 'tail', 'ready'])
    store.endSessionLoading()
    expect(store.sessionLoading).toBeNull()
  })

  test('progress on a finished step is ignored (no resurrecting a closed row)', () => {
    const store = new Store()
    store.beginSessionLoading({ id: 'session-x', startedAt: 0 })
    store.beginSessionLoadStep('attaching', 10)
    store.beginSessionLoadStep('tail', 3)
    store.beginSessionLoadStep('ready', 1)     // 'tail' is closed now
    const before = store.sessionLoading?.steps
    store.setSessionLoadProgress(1, 2)
    // the ACTIVE step ('ready') takes the counts; the closed ones keep none
    expect(store.sessionLoading?.steps.map((s) => s.progress)).toEqual([undefined, undefined, undefined, { done: 1, total: 2 }])
    expect(before?.length).toBe(4)
  })
})

describe('older-history progress in the status bar', () => {
  test('historyProgressText mirrors the marker row and clears on finish', () => {
    const store = new Store()
    store.beginHistory([], [], 9_000)
    expect(store.olderLoading).toBe(true)
    expect(store.historyProgressText).toContain('Load session:')
    expect(store.historyProgressText).toContain('0/9000 events')
    store.setHistoryProgress(3_000, 9_000)
    expect(store.historyProgressText).toContain(' 33%')
    expect(store.historyProgressText).toContain('3000/9000 events')
    store.finishHistory()
    expect(store.olderLoading).toBe(false)
    expect(store.historyProgressText).toBe('')
  })
})

describe('older-history readout: folding vs resting', () => {
  test('a settled load flashes a completion line and hides the indicator', () => {
    const store = new Store()
    store.beginHistory([], [], 1_000)
    store.setHistoryProgress(1_000, 1_000)
    expect(store.historyLoadingVisible).toBe(true)
    store.settleHistoryLoad(1_000)
    // the bar is gone; the completion message rides the transient flash slot
    expect(store.historyLoadingVisible).toBe(false)
    expect(store.statusFlash?.text).toBe('Load session:  done · 1000 events loaded')
    // folding again (reader scrolled up) brings the indicator back
    store.unsettleHistoryLoad()
    expect(store.historyLoadingVisible).toBe(true)
  })

  test('holding swaps the bar for a truthful "scroll to top" line', () => {
    const store = new Store()
    store.beginHistory([], [], 10_000)
    store.setHistoryProgress(9_800, 10_000)
    expect(store.historyProgressText).toContain('████████████████')
    expect(store.historyProgressText).toContain('98%')
    // Reaching the tail budget parks the driver: the readout must stop
    // pretending a bar is still moving (the "stuck at 98%" report).
    store.setHistoryHolding(true)
    expect(store.historyProgressText).toBe('Load session:  9800/10000 events loaded · scroll to top to load more')
    // Scrolling back up resumes folding → the bar returns.
    store.setHistoryHolding(false)
    expect(store.historyProgressText).toContain('98%')
  })

  test('the counter never goes backwards (evict/re-fold churn)', () => {
    const store = new Store()
    store.beginHistory([], [], 1_000)
    store.setHistoryProgress(900, 1_000)
    store.setHistoryProgress(700, 1_000) // eviction churn
    expect(store.historyProgressText).toContain('900/1000 events')
    expect(store.historyProgressText).toContain(' 90%')
  })
})

describe('status-bar phase line + immediate docked view', () => {
  test('the status line names the ACTIVE phase and the target session', () => {
    const store = new Store()
    store.beginSessionLoading({ id: 'session-x', title: 'fix tests', bytes: 2_048, startedAt: 1_000 })
    const first = sessionLoadingStatusText(store.sessionLoading!, 1_000, false)
    expect(first).toBe('Load session:  opening session log · fix tests — 2.0 KB log')
    store.beginSessionLoadStep('tail', 5_400)
    expect(sessionLoadingStatusText(store.sessionLoading!, 6_400, false)).toBe('Load session:  folding recent tail · fix tests — 2.0 KB log')
    expect(sessionLoadingStatusText(store.sessionLoading!, 6_400, true)).toBe('Load session:  folding recent tail · fix tests — 2.0 KB log · 5.4s')
  })

  test('picking a session leaves the hero at once (docked chrome owns the wait)', () => {
    const store = new Store()
    // No session bound → hero, as before.
    expect(store.hero).toBe(true)
    store.beginSessionLoading({ id: 'session-x', startedAt: 0 })
    expect(store.hero).toBe(false)      // status bar exists from the first frame
    store.endSessionLoading()
    expect(store.hero).toBe(true)       // back to the unchanged predicate
  })
})

describe('oversized-session compaction hint (suggestion only)', () => {
  test('wording scales with the event count and names the cure', () => {
    expect(compactHintText(1_431_912)).toBe('Large session (1.4M events) — /compact is recommended to keep resume and turns fast')
    expect(compactHintText(250_000)).toBe('Large session (250k events) — /compact is recommended to keep resume and turns fast')
    expect(COMPACT_HINT_EVENTS).toBe(200_000)
  })
})

describe('P2: window-only stats for oversized sessions', () => {
  test('the flag is off by default, settable, and resets with the session', () => {
    const store = new Store()
    expect(store.statsWindowOnly).toBe(false)
    store.setStatsWindowOnly(true)
    expect(store.statsWindowOnly).toBe(true)
    // A new session starts from scratch (setSession → clear()).
    store.setSession({ id: 'session-y' } as never)
    expect(store.statsWindowOnly).toBe(false)
  })

  test('the threshold keeps small sessions exact', () => {
    expect(STATS_FULL_SCAN_MAX).toBe(200_000)
  })
})
