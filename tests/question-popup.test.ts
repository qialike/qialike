/**
 * Design/verification tests for the MULTI-QUESTION popup (the "card" dock):
 *  - dock ROW math: the dock's height estimate (questionDockRows — the rows
 *    the in-flow dock reserves in the message column) must count the tab-bar
 *    row for multi-question asks and the inline Other editor block exactly as
 *    the dock paints them;
 *  - TAB BAR pagination: when the question tabs overflow the dock width the
 *    pure window function must detect overflow, expose a paged slice whose
 *    segments stay contiguous/clickable, clamp the first-visible index, and
 *    fall back to showing every tab when they fit.
 * Store-level card behavior (answer/advance/submit/cancel) lives in
 * tests/question-card.test.ts.
 *
 * Run with `bun test tests/question-popup.test.ts`.
 *
 * @module dsh-tui/question-popup-test
 */

import { describe, expect, test } from 'bun:test'
import type { PendingQuestion } from '../packages/dsh-tui-app/src/index.tsx'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { questionDockRows } from '../packages/dsh-tui-app/src/question-layout.ts'
import { questionTabWindow } from '../packages/dsh-tui-app/src/panels/question.tsx'

/** A plausible multi-question ask with `n` questions (numbered headers). */
function ask(qs: AskUserQuestionItem[]): PendingQuestion {
  return {
    questions: qs,
    resolve: () => {},
    reject: () => {},
    active: 0,
    answers: qs.map(() => null),
    highlights: qs.map(() => 0),
    drafts: qs.map(() => ''),
    draftOpen: qs.map(() => false),
    picks: qs.map(() => []),
    item: qs[0]!,
    index: 0,
    custom: '',
    customMode: false,
    customCursor: 0,
    sel: null,
  }
}

const numbered = (n: number): AskUserQuestionItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `q${i + 1}`,
    question: `question ${i + 1}`,
    header: String(i + 1),
    options: [{ label: 'yes' }, { label: 'no' }],
  }))

describe('multi-question dock row math (questionDockRows)', () => {
  test('the tab-bar row is counted exactly once for a multi-question ask', () => {
    const single = ask([numbered(1)[0]!])
    const multi = ask(numbered(3))
    const opts = multi.item.options ?? []
    const terminalRows = 40
    const noTabs = questionDockRows(
      multi.item.question, multi.item.detail, opts, false, '', 60, terminalRows, false)
    const withTabs = questionDockRows(
      multi.item.question, multi.item.detail, opts, false, '', 60, terminalRows, true)
    // A single-question ask (no tab bar) matches the multi-question body math
    // without the +1 tab row.
    const singleRows = questionDockRows(
      single.item.question, single.item.detail, single.item.options ?? [], false, '', 60, terminalRows, false)
    expect(withTabs).toBe(noTabs + 1)
    expect(singleRows).toBe(noTabs)
  })

  test('the inline Other editor adds its label + caret window under the options body', () => {
    const q = ask(numbered(2))
    const opts = q.item.options ?? []
    const closed = questionDockRows(q.item.question, q.item.detail, opts, false, '', 60, 40, true)
    const openEmpty = questionDockRows(q.item.question, q.item.detail, opts, true, '', 60, 40, true)
    const openText = questionDockRows(q.item.question, q.item.detail, opts, true, 'hello', 60, 40, true)
    // Editor adds: label 1 + the caret window rows (2 for an empty draft,
    // 1 for a short one-line draft — the window's own row accounting).
    expect(openEmpty).toBe(closed + 3)
    expect(openText).toBe(closed + 2)
  })

  test('tab row + editor are additive (multi-question + Other)', () => {
    const q = ask(numbered(2))
    const opts = q.item.options ?? []
    const noTabsNoEditor = questionDockRows(q.item.question, q.item.detail, opts, false, '', 60, 40, false)
    const tabsNoEditor = questionDockRows(q.item.question, q.item.detail, opts, false, '', 60, 40, true)
    const tabsEditor = questionDockRows(q.item.question, q.item.detail, opts, true, 'x', 60, 40, true)
    expect(tabsNoEditor).toBe(noTabsNoEditor + 1)
    expect(tabsEditor).toBe(tabsNoEditor + 2)
  })
})

describe('multi-question tab bar pagination (questionTabWindow)', () => {
  test('tabs that fit are all shown, from 0, segments contiguous from column 0', () => {
    const q = ask(numbered(3))
    const tw = questionTabWindow(q, 200, 0)
    expect(tw.overflow).toBe(false)
    expect(tw.from).toBe(0)
    expect(tw.visible).toBe(3)
    expect(tw.total).toBe(3)
    expect(tw.segs.length).toBe(3)
    expect(tw.segs[0]!.from).toBe(0)
    for (let i = 1; i < tw.segs.length; i++) {
      expect(tw.segs[i]!.from).toBe(tw.segs[i - 1]!.to + 2) // two-cell separator
    }
    expect(tw.segs.at(-1)!.to).toBeGreaterThan(0)
  })

  test('a narrow dock pages the bar: overflow, visible < total, clamped first index', () => {
    const q = ask(numbered(12)) // 12 one/two-char tabs
    const tw = questionTabWindow(q, 30, 0)
    expect(tw.overflow).toBe(true)
    expect(tw.visible).toBeLessThan(12)
    expect(tw.visible).toBeGreaterThanOrEqual(1)
    expect(tw.from).toBe(0)
    expect(tw.segs.length).toBe(tw.visible)

    // A page in the middle keeps the window inside [0, total - visible].
    const mid = questionTabWindow(q, 30, 5)
    expect(mid.from).toBeLessThanOrEqual(12 - mid.visible)
    expect(mid.from).toBeGreaterThanOrEqual(0)
    // A page beyond the end clamps to the last possible window start.
    const end = questionTabWindow(q, 30, 100)
    expect(end.from).toBe(12 - end.visible)
    expect(end.from + end.visible).toBeLessThanOrEqual(12)

    // Segment geometry stays contiguous inside the paged slice.
    for (let i = 1; i < end.segs.length; i++) {
      expect(end.segs[i]!.from).toBe(end.segs[i - 1]!.to + 2)
    }
  })

  test('segments of a middle page make room for the leading … marker', () => {
    const q = ask(numbered(12))
    const mid = questionTabWindow(q, 30, 3)
    if (mid.from > 0) {
      expect(mid.segs[0]!.from).toBe(2) // the two-cell `… ` marker column
    }
  })

  test('answered questions are ticked on their tab label', () => {
    const q = ask(numbered(3))
    q.answers[1] = { kind: 'option', label: 'yes' }
    const tw = questionTabWindow(q, 200, 0)
    expect(tw.labels[0]).not.toMatch(/^✓/)
    expect(tw.labels[1]).toMatch(/^✓/)
    // Active tab is bracketed: window segment width includes the brackets.
    const active = questionTabWindow(q, 200, 0)
    expect(active.labels[0]).toBe('1')
  })
})
