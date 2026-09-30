/**
 * Plan-review flow tests (harness `exit_plan_mode`):
 *   - a plan tool call becomes a labelled transcript block ABOVE its tool row
 *     (Store.toolCall, same source the resume fold replays from);
 *   - the dock presents the review as a bare Approve / Keep planning confirm/decline:
 *     Chinese display labels only — the committed answers keep the ORIGINAL
 *     harness English option labels ('Approve' / 'Keep planning') because the
 *     harness compares `selected[0] === approve` on those labels;
 *   - plan-review has no "Other" row and no free-text editor.
 *
 * Run with `bun test tests/plan-review.test.ts`.
 *
 * @module qialike/plan-review-test
 */

import { describe, expect, test } from 'bun:test'
import { Store, type PendingQuestion } from '../packages/qialike-app/src/index.tsx'
import {
  EXIT_PLAN_TOOL,
  extractPlanMarkdown,
  isPlanReview,
  PLAN_REVIEW_QUESTION,
  planReviewOptionLabel,
  questionPresentation,
} from '../packages/qialike-app/src/plan-review.ts'
import { questionBody, questionDockRows } from '../packages/qialike-app/src/question-layout.ts'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

const PLAN_MD = '# Ship v0.3\n\n1. bump version\n2. run tests\n'

function planReviewItem(overrides: Partial<AskUserQuestionItem> = {}): AskUserQuestionItem {
  return {
    id: 'plan-review',
    question: 'Approve this plan and leave plan mode?',
    detail: PLAN_MD,
    options: [
      { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
      { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
    ],
    intent: { kind: 'plan-review', approve: 'Approve' },
    ...overrides,
  }
}

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

describe('extractPlanMarkdown', () => {
  test('parses the plan field of a raw exit_plan_mode arguments JSON', () => {
    expect(extractPlanMarkdown(JSON.stringify({ plan: PLAN_MD }))).toBe(PLAN_MD)
  })
  test('returns undefined for malformed / empty / non-plan payloads', () => {
    expect(extractPlanMarkdown(undefined)).toBeUndefined()
    expect(extractPlanMarkdown('not json')).toBeUndefined()
    expect(extractPlanMarkdown(JSON.stringify({}))).toBeUndefined()
    expect(extractPlanMarkdown(JSON.stringify({ plan: '' }))).toBeUndefined()
    expect(extractPlanMarkdown(JSON.stringify({ plan: '   ' }))).toBeUndefined()
  })
})

describe('plan block injection (Store.toolCall)', () => {
  test('an exit_plan_mode call inserts a plan block above its tool row', () => {
    const store = new Store()
    store.append('user', 'hi')
    store.toolCall(EXIT_PLAN_TOOL, JSON.stringify({ plan: PLAN_MD }))
    expect(store.items.length).toBe(3)
    expect(store.items[1]?.kind).toBe('plan')
    expect(store.items[1]?.text).toBe(PLAN_MD)
    expect(store.items[2]?.kind).toBe('tool')
    expect(store.items[2]?.text).toBe(`│ ${EXIT_PLAN_TOOL}`)
  })
  test('the tool row still settles to ✓ via toolResult with the plan block above', () => {
    const store = new Store()
    store.toolCall(EXIT_PLAN_TOOL, JSON.stringify({ plan: PLAN_MD }))
    store.toolResult({ ok: true, text: 'Plan approved — plan mode exited.' })
    expect(store.items.map((i) => i.kind)).toEqual(['plan', 'tool'])
    expect(store.items[1]?.kind).toBe('tool')
    expect(store.items[1]?.text).toBe(`✓ ${EXIT_PLAN_TOOL}`)
    expect(store.items[1]?.tool?.state).toBe('ok')
  })
  test('other tools keep their plain tool row (no plan block)', () => {
    const store = new Store()
    store.toolCall('bash', JSON.stringify({ command: 'echo hi' }))
    expect(store.items.length).toBe(1)
    expect(store.items[0]?.kind).toBe('tool')
  })
  test('exit_plan_mode without a parseable plan still appends its tool row', () => {
    const store = new Store()
    store.toolCall(EXIT_PLAN_TOOL, 'garbage')
    expect(store.items.length).toBe(1)
    expect(store.items[0]?.kind).toBe('tool')
  })
})

describe('questionPresentation', () => {
  test('plan-review presents Chinese confirm/decline with no body and no Other', () => {
    const item = planReviewItem()
    expect(isPlanReview(item)).toBe(true)
    const pres = questionPresentation(item)
    expect(pres.question).toBe(PLAN_REVIEW_QUESTION)
    expect(pres.detail).toBeUndefined() // plan already reads as the transcript block
    expect(pres.options.map((o) => o.label)).toEqual(['Approve', 'Keep planning'])
    expect(pres.showOther).toBe(false)
    expect(planReviewOptionLabel(item, 0)).toBe('Approve')
    expect(planReviewOptionLabel(item, 1)).toBe('Keep planning')
  })
  test('a generic question passes through verbatim (with Other)', () => {
    const item: AskUserQuestionItem = {
      id: 'q', question: 'Pick?', detail: 'ctx', options: [{ label: 'a' }, { label: 'b' }],
    }
    expect(isPlanReview(item)).toBe(false)
    const pres = questionPresentation(item)
    expect(pres.question).toBe('Pick?')
    expect(pres.detail).toBe('ctx')
    expect(pres.options.map((o) => o.label)).toEqual(['a', 'b'])
    expect(pres.showOther).toBe(true)
  })
})

describe('dock body excludes Other for plan-review (question-layout includeOther)', () => {
  test('questionBody with includeOther=false has no other row', () => {
    const body = questionBody(undefined, [{ label: 'Approve' }, { label: 'Keep planning' }], 80, false)
    expect(body.some((r) => r.kind === 'other')).toBe(false)
    expect(body.filter((r) => r.kind === 'option').length).toBeGreaterThan(0)
    expect(body.map((r) => r.option).every((o) => o === 0 || o === 1)).toBe(true)
  })
  test('questionBody default keeps the Other row (existing callers unchanged)', () => {
    const body = questionBody('ctx', [{ label: 'a' }], 80)
    expect(body.some((r) => r.kind === 'other')).toBe(true)
  })
  test('questionDockRows includeOther=false is one row shorter than the default', () => {
    const base = questionDockRows('Approve?', 'ctx', [{ label: 'a' }, { label: 'b' }], false, '', 100, 40)
    const noOther = questionDockRows('Approve?', 'ctx', [{ label: 'a' }, { label: 'b' }], false, '', 100, 40, false, false)
    expect(base).toBeGreaterThan(noOther)
  })
})

describe('plan-review store behavior', () => {
  test('answers encode the ORIGINAL harness option labels, not the Chinese display', () => {
    const store = new Store()
    const item = planReviewItem()
    let answered: AskUserQuestionAnswerItem[] | null = null
    ask(store, [item], (a) => { answered = a }, () => {})
    // Default highlight = option 0 (Approve → displayed Approve).
    store.questionEnter()
    expect(store.question).toBeNull()
    expect(answered?.[0]?.selected).toEqual(['Approve'])
  })
  test('the decline option submits the non-approve harness label', () => {
    const store = new Store()
    let answered: AskUserQuestionAnswerItem[] | null = null
    ask(store, [planReviewItem()], (a) => { answered = a }, () => {})
    store.bumpQuestionIndex(1) // 继续规划 (protocol 'Keep planning')
    store.questionEnter()
    expect(answered?.[0]?.selected).toEqual(['Keep planning'])
  })
  test('↑/↓ selection wraps between the two options only (no Other row)', () => {
    const store = new Store()
    ask(store, [planReviewItem()], () => {}, () => {})
    expect(store.question?.index).toBe(0)
    store.bumpQuestionIndex(1)
    expect(store.question?.index).toBe(1)
    store.bumpQuestionIndex(1) // wraps — no Other row to land on
    expect(store.question?.index).toBe(0)
  })
  test('typed text cannot open the free-text editor in plan-review', () => {
    const store = new Store()
    ask(store, [planReviewItem()], () => {}, () => {})
    // Printable chars route through setQuestionCustom (questionKey guards the
    // non-custom arm with `!review`); the store method itself also refuses.
    store.setQuestionCustom('my opinion', true)
    expect(store.question?.custom).toBe('')
    expect(store.question?.customMode).toBe(false)
    // No bump can land on the "Other" row (index wraps 0↔1), so Enter answers
    // an option — the inline editor never opens.
    store.bumpQuestionIndex(1)
    expect(store.question?.index).toBe(1)
    expect(store.question?.customMode).toBe(false)
    store.bumpQuestionIndex(1)
    expect(store.question?.index).toBe(0)
    expect(store.question?.customMode).toBe(false)
  })
  test('Esc still cancels the ask', () => {
    const store = new Store()
    const errors: Error[] = []
    ask(store, [planReviewItem()], () => {}, (e) => errors.push(e))
    store.cancelQuestion()
    expect(store.question).toBeNull()
    expect(errors.length).toBe(1)
  })
})
