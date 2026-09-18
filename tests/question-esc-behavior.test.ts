/**
 * Regression tests for the question-dock Esc semantics:
 *  - Esc in the inline "Other" editor discards the typed text and returns to
 *    the options list (it does NOT keep the draft, and does NOT cancel the ask).
 *  - Esc in the options list cancels the whole ask AND aborts the running task
 *    (cancelQuestionAction is invoked so the agent's turn is stopped).
 *
 * Run with `bun test tests/question-esc-behavior.test.ts`.
 *
 * @module qialike/question-esc-behavior-test
 */

import { describe, expect, test } from 'bun:test'
import { Store, type PendingQuestion } from '../packages/qialike-app/src/index.tsx'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

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

describe('question dock Esc semantics', () => {
  test('Esc in the Other editor discards typed text and stays on the question', () => {
    const store = new Store()
    let resolved = false
    let rejected = false
    ask(store, [{ id: 'q1', question: 'pick', options: [{ label: 'a' }, { label: 'b' }] }], () => { resolved = true }, () => { rejected = true })

    // Select the "Other…" row (index === options.length) and open the editor.
    store.setQuestionIndex(2)
    store.questionEnter()
    expect(store.question?.customMode).toBe(true)

    // Type some text, then Esc (questionCloseEditor): it must be cleared.
    store.questionType('hello')
    expect(store.question?.custom).toBe('hello')
    store.questionCloseEditor()

    expect(store.question?.customMode).toBe(false)
    expect(store.question?.custom).toBe('')
    expect(store.question).not.toBeNull()
    // The ask is NOT cancelled: neither resolved nor rejected yet.
    expect(resolved).toBe(false)
    expect(rejected).toBe(false)
  })

  test('Esc in the options list cancels the ask AND aborts the task', () => {
    const store = new Store()
    let rejected = false
    let aborted = false
    store.cancelQuestionAction = () => { aborted = true }
    ask(store, [{ id: 'q1', question: 'pick', options: [{ label: 'a' }] }], () => {}, () => { rejected = true })

    store.cancelQuestion()

    expect(rejected).toBe(true)
    expect(aborted).toBe(true)
    expect(store.question).toBeNull()
  })

  test('cancelling when no question is pending is a no-op', () => {
    const store = new Store()
    let aborted = false
    store.cancelQuestionAction = () => { aborted = true }
    store.cancelQuestion()
    expect(aborted).toBe(false)
    expect(store.question).toBeNull()
  })
})
