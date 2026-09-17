/**
 * Multi-select tests for the ask-user question dock (`multiSelect: true`).
 *
 * Requirement: a question the caller flags `multiSelect` must accept SEVERAL
 * options. The dock paints an `[x]`/`[ ]` box on every option row, Space /
 * digits / a click TOGGLE the highlighted option (never committing — the
 * commit stays Enter), Enter submits the whole checked set, and the harness
 * answer carries the labels in `selected` (plus the typed "Other" text when
 * the editor was used). Single-select behavior must stay byte-identical:
 * digits and Enter still answer and advance immediately.
 *
 * Run with `bun test tests/question-multi-select.test.ts`.
 *
 * @module dsh-tui/question-multi-select-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store, type PendingQuestion } from '../packages/dsh-tui-app/src/index.tsx'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import {
  isMultiSelect,
  optionChecked,
  optionText,
  questionBody,
  questionDockRows,
} from '../packages/dsh-tui-app/src/question-layout.ts'
import { isPlanReview, questionPresentation } from '../packages/dsh-tui-app/src/plan-review.ts'

function ask(
  store: Store,
  questions: AskUserQuestionItem[],
  onAnswer: (a: AskUserQuestionAnswerItem[]) => void,
  onReject: (e: Error) => void,
): void {
  store.setQuestion({
    questions,
    resolve: onAnswer,
    reject: onReject,
    active: 0,
    answers: questions.map(() => null),
    highlights: questions.map(() => 0),
    drafts: questions.map(() => ''),
    draftOpen: questions.map(() => false),
    picks: questions.map(() => []),
    item: questions[0]!,
    index: 0,
    custom: '',
    customMode: false,
    customCursor: 0,
    sel: null,
  } satisfies PendingQuestion)
}

const pick = (store: Store, i: number): void => { store.toggleQuestionPick(i) }

describe('multi-select question (store)', () => {
  test('toggling checks and unchecks, and Enter commits the whole checked set', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'which?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    ]
    let answered: AskUserQuestionAnswerItem[] | null = null
    ask(store, questions, (a) => { answered = a }, () => {})

    // Enter alone cannot answer: an empty check set is not an answer.
    store.questionEnter()
    expect(answered).toBeNull()
    expect(store.question?.answers[0]).toBeNull()

    pick(store, 0)
    pick(store, 2)
    expect(store.question?.picks[0]).toEqual(['a', 'c'])
    expect(store.question?.index).toBe(2) // the toggle moves the highlight

    // Un-checking removes exactly that label.
    pick(store, 0)
    expect(store.question?.picks[0]).toEqual(['c'])

    pick(store, 1)
    store.questionEnter()
    expect(store.question).toBeNull()
    expect(answered?.[0]).toEqual({ id: 'q1', selected: ['c', 'b'] })
  })

  test('checks survive navigating away and back inside a multi-question card', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'one', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
      { id: 'q2', question: 'two', options: [{ label: 'x' }] },
    ]
    let answered: AskUserQuestionAnswerItem[] | null = null
    ask(store, questions, (a) => { answered = a }, () => {})

    pick(store, 1)
    store.questionGo(1)
    expect(store.question?.active).toBe(1)
    store.questionGo(-1)
    expect(store.question?.active).toBe(0)
    expect(store.question?.picks[0]).toEqual(['b'])
    expect(store.question?.index).toBe(1) // restored highlight = the checked row

    store.questionEnter() // commits ['b'] and advances to the unanswered q2
    expect(store.question?.active).toBe(1)
    expect(store.question?.answers[0]).toEqual({ kind: 'multi', labels: ['b'] })
    store.questionEnter() // q2 → submits the batch
    expect(answered?.map((a) => a.selected)).toEqual([['b'], ['x']])
  })

  test('changing a committed check set re-opens the question until Enter commits again', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'one', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
      { id: 'q2', question: 'two', options: [{ label: 'x' }] },
    ]
    let answered: AskUserQuestionAnswerItem[] | null = null
    ask(store, questions, (a) => { answered = a }, () => {})

    pick(store, 0)
    store.questionEnter()
    expect(store.question?.answers[0]).toEqual({ kind: 'multi', labels: ['a'] })
    store.questionGo(-1)
    pick(store, 1)
    // The draft and the committed answer disagree again → not answered.
    expect(store.question?.picks[0]).toEqual(['a', 'b'])
    expect(store.question?.answers[0]).toBeNull()

    store.questionEnter()
    expect(store.question?.answers[0]).toEqual({ kind: 'multi', labels: ['a', 'b'] })
    store.questionGo(1)
    store.questionEnter()
    expect(answered?.[0]).toEqual({ id: 'q1', selected: ['a', 'b'] })
  })

  test('the "Other" editor commits the checks AND the typed text together', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'which?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
    ]
    let answered: AskUserQuestionAnswerItem[] | null = null
    ask(store, questions, (a) => { answered = a }, () => {})

    pick(store, 0)
    store.setQuestionIndex(2) // the Other row
    store.questionEnter() // opens the inline editor
    expect(store.question?.customMode).toBe(true)
    store.questionType('a fourth way')
    store.questionEnter()
    expect(store.question).toBeNull()
    expect(answered?.[0]).toEqual({ id: 'q1', selected: ['a'], custom: 'a fourth way' })
  })

  test('single-select questions keep answering on the first Enter', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'one', options: [{ label: 'a' }, { label: 'b' }] },
      { id: 'q2', question: 'two', options: [{ label: 'x' }] },
    ]
    let answered: AskUserQuestionAnswerItem[] | null = null
    ask(store, questions, (a) => { answered = a }, () => {})
    store.questionEnter()
    expect(store.question?.answers[0]).toEqual({ kind: 'option', label: 'a' })
    expect(store.question?.picks[0]).toEqual([])
    store.questionEnter()
    expect(answered?.[0]).toEqual({ id: 'q1', selected: ['a'] })
  })

  test('revisiting a committed multi answer restores its checks (and its editor)', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'one', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
      { id: 'q2', question: 'two', options: [{ label: 'x' }] },
    ]
    ask(store, questions, () => {}, () => {})
    pick(store, 1)
    store.questionEnter()
    store.questionGo(-1)
    expect(store.question?.picks[0]).toEqual(['b'])
    expect(store.question?.index).toBe(1) // the checked row
    expect(store.question?.customMode).toBe(false) // no typed text → option list
    // A committed Other text reopens the editor with the checks kept.
    store.questionGo(1)
    store.questionGo(-1)
    store.setQuestionIndex(2)
    store.questionEnter()
    store.questionType('and this')
    store.questionEnter() // commits ['b'] + custom, advances to q2
    store.questionGo(-1)
    expect(store.question?.customMode).toBe(true)
    expect(store.question?.custom).toBe('and this')
    expect(store.question?.picks[0]).toEqual(['b'])
  })
})

describe('multi-select option rows (layout)', () => {
  test('optionText keeps single-select text unchanged and boxes multi-select rows', () => {
    expect(optionText(2, 'x')).toBe('3. x')
    expect(optionText(2, 'x', 'why')).toBe('3. x — why')
    expect(optionText(0, 'a', undefined, false)).toBe('[ ] 1. a')
    expect(optionText(0, 'a', 'why', true)).toBe('[x] 1. a — why')
  })

  test('questionBody boxes every option row but never the "Other…" row', () => {
    const options = [{ label: 'a' }, { label: 'b' }, { label: 'c' }]
    const rows = questionBody(undefined, options, 40, true, [true, false, false])
    expect(rows.map((r) => r.text)).toEqual(['[x] 1. a', '[ ] 2. b', '[ ] 3. c', '4. Other…'])
    expect(rows.map((r) => r.kind)).toEqual(['option', 'option', 'option', 'other'])
    expect(rows.map((r) => r.option)).toEqual([0, 1, 2, 3])
    // No checks passed (single-select) → the plain numbered rows.
    expect(questionBody(undefined, options, 40).map((r) => r.text))
      .toEqual(['1. a', '2. b', '3. c', '4. Other…'])
  })

  test('the [x]/[ ] box is 4 columns wide, so checking a row never re-wraps the body', () => {
    // 16 columns of label: with the box (`[ ] 1. ` = 7) the row is 23 > the
    // 20-column dock inner width and wraps, without it (`1. ` = 3) it is 19 and
    // fits. So the checked and unchecked states MUST keep the same box width —
    // a narrower box when unchecked would change the row count on every toggle
    // and the reserved transcript rows would jump.
    const options = [{ label: 'abcdefghijklmnop' }]
    const none = questionBody(undefined, options, 20, true, [false])
    const some = questionBody(undefined, options, 20, true, [true])
    const plain = questionBody(undefined, options, 20, true, undefined)
    expect(none.length).toBe(3) // 2 wrapped option rows + the Other row
    expect(some.length).toBe(none.length)
    expect(none[0]!.text).toBe('[ ] 1. abcdefghijklm') // exactly the 20 columns
    expect(some[0]!.text).toBe('[x] 1. abcdefghijklm')
    expect(none.slice(1).map((r) => r.text)).toEqual(['nop', '2. Other…'])
    expect(plain.length).toBe(2) // unboxed, the same label fits on one row
    // The conversation's dock-height estimate sees the same rows.
    expect(questionDockRows('q', undefined, options, false, '', 20, 40, false, true, [false]))
      .toBe(questionDockRows('q', undefined, options, false, '', 20, 40, false, true, [true]))
  })

  test('isMultiSelect requires the explicit true flag', () => {
    expect(isMultiSelect({ multiSelect: true })).toBe(true)
    expect(isMultiSelect({})).toBe(false)
    expect(isMultiSelect({ multiSelect: false })).toBe(false)
  })

  test('optionChecked matches rows by LABEL, in option order', () => {
    const options = [{ label: 'b' }, { label: 'a' }, { label: 'c' }]
    expect(optionChecked(options, ['a', 'c'])).toEqual([false, true, true])
    expect(optionChecked(options, [])).toEqual([false, false, false])
    expect(optionChecked(options, undefined)).toEqual([false, false, false])
  })
})

describe('multi-select plan-review guard', () => {
  const item: AskUserQuestionItem = {
    id: 'q1',
    question: 'Approve this plan and leave plan mode?',
    detail: '# plan',
    multiSelect: true,
    intent: { kind: 'plan-review', approve: 'Approve' },
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
  }

  test('a multi-select question is never presented as the bare review dock', () => {
    expect(isPlanReview(item)).toBe(false)
    const pres = questionPresentation(item)
    expect(pres.question).toBe(item.question) // verbatim, not the review wording
    expect(pres.detail).toBe('# plan') // the plan body stays in the dock
    expect(pres.showOther).toBe(true) // and so does the Other row
  })

  test('a single-select plan-review is unaffected', () => {
    const single = { ...item, multiSelect: undefined }
    expect(isPlanReview(single)).toBe(true)
    expect(questionPresentation(single).showOther).toBe(false)
  })
})

describe('multi-select key wiring (source guards)', () => {
  const read = (path: string): string => readFileSync(join(import.meta.dir, '..', path), 'utf8')

  test('space, digits and a click toggle instead of answering', () => {
    const src = read('packages/dsh-tui-app/src/panels/question.tsx')
    expect(src).toContain("else if (char === ' ' && isMultiSelect(question.item))")
    expect(src).toContain('if (question.index < optsLen) store.toggleQuestionPick(question.index)')
    expect(src).toContain('if (isMultiSelect(question.item) && digit <= optsLen) store.toggleQuestionPick(digit - 1)')
    expect(src).toContain('if (isMultiSelect(question.item) && owner < optsLen) store.toggleQuestionPick(owner)')
  })

  test('the dock-height estimate and the painted body share one checked state', () => {
    expect(read('packages/dsh-tui-app/src/panels/conversation.tsx')).toContain(
      'isMultiSelect(q.item) ? optionChecked(pres.options, q.picks[q.active]) : undefined')
    expect(read('packages/dsh-tui-app/src/panels/question.tsx')).toContain(
      'const checked = multi ? optionChecked(pres.options, q.picks[q.active]) : undefined')
  })

  test('the store submits checked labels as the answer\'s selected list', () => {
    const src = read('packages/dsh-tui-app/src/index.tsx')
    expect(src).toContain('q.answers[a] = { kind: \'multi\', labels: [...(q.picks[a] ?? [])]')
    expect(src).toContain('? { id: item.id, selected: [...ans.labels] }')
  })
})
