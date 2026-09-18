/**
 * Baseline for the composer's caret row (`composerCaretGlobalRow`) BEFORE the
 * bounded-layout refactor touches it: the row the caret sits on must stay the
 * one the painted wrap produces, since the hardware-cursor cell, the mouse→index
 * mapping and the selection bounds all derive from it.
 *
 * Run with `bun test tests/composer-caret-row.test.ts`.
 *
 * @module qialike/composer-caret-row-test
 */
import { describe, expect, test } from 'bun:test'
import wrapAnsi from 'wrap-ansi'
import { composerCaretGlobalRow } from '../packages/qialike-app/src/panels/conversation.tsx'

/** Reference: rows of the whole draft, then the caret's index among them. */
function referenceRow(input: string, cursor: number, usable: number): number {
  const caret = Math.max(0, Math.min(cursor, input.length))
  const before = input.slice(0, caret)
  return Math.max(0, wrapAnsi(before, usable, { trim: false, hard: true }).split('\n').length - 1)
}

describe('composerCaretGlobalRow agrees with the painted wrap', () => {
  const corpus = [
    ['', 0], ['a', 0], ['a', 1], ['hello world', 5], ['hello world', 11],
    ['a\nb\nc', 4], ['a\nb\nc', 2], ['one two three four five', 12],
    ['中文草稿换行测试', 4], ['🙂🙂🙂', 2], ['x'.repeat(300), 150], ['x'.repeat(300), 300],
    ['line one is quite long\nsecond line also long here', 30],
  ] as const

  test('every caret position in the corpus lands on the reference row', () => {
    for (const usable of [10, 20, 40, 120]) {
      for (const [input, cursor] of corpus) {
        expect(composerCaretGlobalRow(input as string, cursor as number, usable),
          `${JSON.stringify(input).slice(0, 24)}… caret=${cursor} usable=${usable}`)
          .toBe(referenceRow(input as string, cursor as number, usable))
      }
    }
  })

  test('the caret is clamped and never off the draft', () => {
    expect(composerCaretGlobalRow('abc', -5, 20)).toBe(0)
    expect(composerCaretGlobalRow('abc', 99, 20)).toBe(referenceRow('abc', 3, 20))
    // An empty draft still has one row.
    expect(composerCaretGlobalRow('', 0, 20)).toBe(0)
  })
})
