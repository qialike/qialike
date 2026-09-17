/**
 * Card-logic tests for the multi-question ask dock (question-dock
 * semantics): one PendingQuestion holds the whole batch; answering commits a
 * question and advances, answers persist across back-navigation, the "Other"
 * row opens an INLINE editor (no second dialog), and the batch submits once
 * every question is answered (Esc cancels the whole ask).
 *
 * Run with `bun test tests/question-card.test.ts`.
 *
 * @module dsh-tui/question-card-test
 */

import { describe, expect, test } from 'bun:test'
import { Store, type PendingQuestion } from '../packages/dsh-tui-app/src/index.tsx'
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
  })
}

describe('multi-question ask card', () => {
  test('answering advances through questions and submits the batch once all answered', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'one', options: [{ label: 'a' }, { label: 'b' }] },
      { id: 'q2', question: 'two', options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] },
      { id: 'q3', question: 'three', options: [{ label: 'm' }] },
    ]
    let answered: AskUserQuestionAnswerItem[] | null = null
    ask(store, questions, (a) => { answered = a }, () => {})

    // q1: default highlight is option 0 ("a") — Enter answers and advances.
    expect(store.question?.active).toBe(0)
    store.questionEnter()
    expect(answered).toBeNull() // not done yet
    expect(store.question?.active).toBe(1)
    expect(store.question?.answers[0]).toEqual({ kind: 'option', label: 'a' })

    // q2: pick option 2 ("z") by highlight then Enter.
    store.setQuestionIndex(2)
    store.questionEnter()
    expect(store.question?.active).toBe(2)
    expect(store.question?.answers[1]).toEqual({ kind: 'option', label: 'z' })

    // Back to q2: its restored highlight is the committed option.
    store.questionGo(-1)
    expect(store.question?.active).toBe(1)
    expect(store.question?.index).toBe(2)

    // Forward again without re-answering lands on q3; answering it submits.
    store.questionGo(1)
    store.questionEnter()
    expect(store.question).toBeNull()
    expect(answered).not.toBeNull()
    expect(answered?.map((a) => a.id)).toEqual(['q1', 'q2', 'q3'])
    expect(answered?.[0]).toEqual({ id: 'q1', selected: ['a'] })
    expect(answered?.[1]).toEqual({ id: 'q2', selected: ['z'] })
    expect(answered?.[2]).toEqual({ id: 'q3', selected: ['m'] })
  })

  test('unanswered earlier questions are jumped to before the batch can submit', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'one', options: [{ label: 'a' }] },
      { id: 'q2', question: 'two', options: [{ label: 'x' }] },
      { id: 'q3', question: 'three', options: [{ label: 'm' }] },
    ]
    let answered: AskUserQuestionAnswerItem[] | null = null
    ask(store, questions, (a) => { answered = a }, () => {})
    // Jump straight to q3 by navigation, answer it: must bounce to q1 (first unanswered).
    store.questionGo(1)
    store.questionGo(1)
    expect(store.question?.active).toBe(2)
    store.questionEnter()
    expect(answered).toBeNull()
    expect(store.question?.active).toBe(0)
    // Answer q1 and q2 → now everything answered → submits.
    store.questionEnter()
    store.questionEnter()
    expect(store.question).toBeNull()
    expect(answered?.length).toBe(3)
  })

  test('"Other" opens an inline editor; Enter commits it without closing the dock', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'one', options: [{ label: 'a' }, { label: 'b' }] },
    ]
    let answered: AskUserQuestionAnswerItem[] | null = null
    ask(store, questions, (a) => { answered = a }, () => {})
    const q0 = store.question!
    // Move highlight to the Other row (index == options.length) and press Enter.
    store.setQuestionIndex(2)
    store.questionEnter()
    expect(store.question?.customMode).toBe(true) // editor opened, nothing submitted
    expect(answered).toBeNull()
    // Typing a letter then Enter commits the custom answer (single question → submit).
    store.questionType('my own')
    expect(q0.custom).toBe('my own')
    store.questionEnter()
    expect(store.question).toBeNull()
    expect(answered?.[0]).toEqual({ id: 'q1', selected: [], custom: 'my own' })
  })

  test('an empty inline answer does not advance; Esc closes the editor and cancels the ask', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'one', options: [{ label: 'a' }] },
    ]
    let answered: AskUserQuestionAnswerItem[] | null = null
    let rejected: Error | null = null
    ask(store, questions, (a) => { answered = a }, (e) => { rejected = e })
    store.setQuestionIndex(1) // Other row
    store.questionEnter() // opens editor
    expect(store.question?.customMode).toBe(true)
    store.questionEnter() // empty text: stays editing, nothing submitted
    expect(store.question?.customMode).toBe(true)
    expect(answered).toBeNull()
    // Esc first closes the editor; a second cancel aborts the whole ask.
    store.questionCloseEditor()
    expect(store.question?.customMode).toBe(false)
    store.cancelQuestion()
    expect(store.question).toBeNull()
    expect(rejected).toBeInstanceOf(Error)
  })
})

describe('question tab bar (dock)', () => {
  test('questionJump opens any question directly without committing', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'one', options: [{ label: 'a' }, { label: 'b' }] },
      { id: 'q2', question: 'two', options: [{ label: 'x' }] },
      { id: 'q3', question: 'three', header: 'done?', options: [{ label: 'm' }] },
    ]
    let answered: AskUserQuestionAnswerItem[] | null = null
    ask(store, questions, (a) => { answered = a }, () => {})
    store.questionJump(2)
    expect(store.question?.active).toBe(2)
    expect(store.question?.item.question).toBe('three')
    store.questionJump(0)
    expect(store.question?.active).toBe(0)
    expect(store.question?.answers).toEqual([null, null, null]) // nothing committed
    expect(answered).toBeNull()
    // Same-tab jump is a no-op (still open).
    store.questionJump(0)
    expect(store.question?.active).toBe(0)
  })

  test('jumping to an answered custom question reopens its inline editor', () => {
    const store = new Store()
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', question: 'one', options: [{ label: 'a' }] },
      { id: 'q2', question: 'two', options: [{ label: 'x' }] },
    ]
    ask(store, questions, () => {}, () => {})
    // Answer q1 via Other: open editor, type, commit (moves to q2).
    store.setQuestionIndex(1)
    store.questionEnter()
    store.questionType('hello')
    store.questionEnter()
    expect(store.question?.active).toBe(1)
    // Jump back: q1's custom answer reopens the inline editor with the text.
    store.questionJump(0)
    expect(store.question?.active).toBe(0)
    expect(store.question?.customMode).toBe(true)
    expect(store.question?.custom).toBe('hello')
  })
})
