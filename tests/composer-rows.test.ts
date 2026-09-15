/**
 * The composer's cached row model (`packages/dsh-tui-app/src/composer-rows.ts`).
 *
 * Two things must hold or the whole bounded-layout refactor is a regression:
 *   1. the cached model is EXACTLY the old full wrap (`composerRowsReference`),
 *      so the card height, the caret window, the hardware caret cell, the
 *      click→index mapping and the selection bounds cannot drift from the paint;
 *   2. repeated calls reuse one list — the property that makes a repaint with an
 *      unchanged draft cost no wrap at all.
 *
 * The caret row is the one number that stopped being computed by wrapping the
 * whole prefix, so it gets a fuzz comparison against the old prefix wrap.
 *
 * Run with `bun test tests/composer-rows.test.ts`.
 *
 * @module dsh-tui/composer-rows-test
 */
import { describe, expect, test } from 'bun:test'
import {
  composerCaretGlobalRow, composerCaretMoveVisual, composerCells, composerRowBuilds, composerRows,
  composerRowsReference, composerWindow, resetComposerRowBuilds, resetComposerRowsCache, resetComposerWidthCache,
} from '../packages/dsh-tui-app/src/composer-rows.ts'

/**
 * Independent reference caret row: linear scan of the FULL painted row list.
 *
 * It is deliberately NOT the old "wrap the prefix" formula. That formula could
 * disagree with the rows the render paints, because `wrap-ansi`'s hard-word path
 * does not push a row when a word ends exactly on the column — so a prefix that
 * ends exactly at that seam wraps to FEWER rows than the full draft's prefix
 * (measured: `'🙂-🙂🇨🇳'` at usable 7 is one row, while the same text inside a
 * longer draft paints as two). The caret must follow the PAINT, so the full row
 * list is the reference.
 */
function referenceCaretRow(input: string, caret: number, usable: number): number {
  const rows = composerRowsReference(input, usable)
  const at = Math.max(0, Math.min(caret, input.length))
  // The caret at the very end sits on the LAST painted row (a trailing '\n'
  // paints an empty row the caret rests on).
  if (at >= input.length) return Math.max(0, rows.length - 1)
  for (let r = 0; r < rows.length; r++) {
    const start = rows[r]!.start
    const end = start + rows[r]!.text.length
    // Between two rows sits the '\n' that separated them: a caret there is at
    // the END of the preceding row.
    if (at < start) return Math.max(0, r - 1)
    if (at > end) continue
    if (at === start) {
      // A caret on a row seam belongs to the row STARTING there when a '\n'
      // separates them, and to the row ENDING there at a hard wrap.
      const newline = r === 0 || start - (rows[r - 1]!.start + rows[r - 1]!.text.length) === 1
      return newline ? r : Math.max(0, r - 1)
    }
    return r
  }
  return Math.max(0, rows.length - 1)
}

/** Deterministic PRNG so a failure is reproducible. */
function prng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

const ALPHABET = [
  'a', 'b', 'Z', ' ', ' ', '  ', '\n', '\n', '-', '.', '世界', 'é', 'e\u0301', '🙂', '👨‍👩‍👧', '🇨🇳', '\t',
]

function randomDraft(rand: () => number, maxParts: number): string {
  const parts = Math.floor(rand() * maxParts)
  let out = ''
  for (let i = 0; i < parts; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)]
  return out
}

describe('the row model is exactly the full wrap', () => {
  test('the cached list is the reference list, entry for entry', () => {
    const drafts = ['', 'a', 'hello world', 'a\nb\n\nc', 'a'.repeat(200), '世界世界世界', '🙂'.repeat(30), 'x y z\n\nq']
    for (const draft of drafts) {
      for (const usable of [10, 20, 41]) {
        resetComposerRowsCache()
        expect(composerRows(draft, usable)).toEqual(composerRowsReference(draft, usable))
      }
    }
  })

  test('repeated calls share one list; a new draft rebuilds; reset clears', () => {
    resetComposerRowsCache()
    const a = composerRows('cache-me', 12)
    expect(composerRows('cache-me', 12)).toBe(a) // identity, not just equality
    expect(composerRows('cache-me', 13)).not.toBe(a)
    resetComposerRowsCache()
    expect(composerRows('cache-me', 12)).not.toBe(a)
    // An equal-but-distinct string is still a hit (value equality is correct).
    expect(composerRows('cache-' + 'me', 12)).toBe(composerRows('cache-me', 12))
  })

  test('the display-width memo answers by value', () => {
    resetComposerWidthCache()
    expect(composerCells('')).toBe(0)
    expect(composerCells('abc')).toBe(3)
    expect(composerCells('世界')).toBe(4)
    expect(composerCells('abc')).toBe(3)
  })
})

describe('the end-edit fast path is exact on ASCII and is actually taken', () => {
  test('append / shrink sequences equal the full wrap, with NO extra full builds', () => {
    const rand = prng(777001)
    const alpha = ['a', 'b', 'c', ' ', ' ', '\n', '-', '.', 'word', 'x'.repeat(40)]
    for (let t = 0; t < 400; t++) {
      let draft = ''
      let usable = [4, 7, 13, 30][Math.floor(rand() * 4)]!
      resetComposerRowsCache()
      resetComposerRowBuilds()
      composerRows(draft, usable) // seed the cache
      const buildsAfterSeed = composerRowBuilds()
      for (let k = 0; k < 25; k++) {
        if (rand() < 0.6) {
          let add = ''
          const n = 1 + Math.floor(rand() * 20)
          for (let i = 0; i < n; i++) add += alpha[Math.floor(rand() * alpha.length)]
          draft += add
        } else if (draft.length > 1) {
          // Never shrink to empty: that is the one end edit the cache rebuilds
          // (there is nothing left to extend from).
          draft = draft.slice(0, 1 + Math.floor(rand() * (draft.length - 1)))
        }
        expect(composerRows(draft, usable)).toEqual(composerRowsReference(draft, usable))
      }
      // Every step was an end edit on ASCII → the reference ran exactly once.
      expect(composerRowBuilds()).toBe(buildsAfterSeed)
    }
  })

  test('a non-ASCII or tab edit falls back to a full rebuild (still exact)', () => {
    for (const nonAscii of ['世界', '🙂', 'e\u0301', '👨‍👩‍👧', '\t']) {
      resetComposerRowsCache()
      resetComposerRowBuilds()
      composerRows('hello', 10)
      expect(composerRowBuilds()).toBe(1)
      const draft = 'hello ' + nonAscii + ' tail'
      expect(composerRows(draft, 10)).toEqual(composerRowsReference(draft, 10))
      expect(composerRowBuilds()).toBe(2)
    }
  })

  test('a middle insert falls back to a full rebuild (still exact)', () => {
    resetComposerRowsCache()
    resetComposerRowBuilds()
    composerRows('alpha beta gamma', 8)
    expect(composerRowBuilds()).toBe(1)
    const edited = 'alpha X beta gamma'
    expect(composerRows(edited, 8)).toEqual(composerRowsReference(edited, 8))
    expect(composerRowBuilds()).toBe(2)
  })
})

describe('the caret row matches the prefix wrap it replaced', () => {
  test('hand-picked boundaries: caret at start, row seams, after a newline, at the end', () => {
    const cases: Array<[string, number[]]> = [
      ['', [0]],
      ['abc', [0, 1, 2, 3]],
      ['a\nb', [0, 1, 2, 3]],
      ['a\n\nb', [0, 1, 2, 3, 4]],
      ['aaaaaaaaaaa', [0, 5, 10, 11]], // hard-wrap seam at 10 for usable 10
      ['a b c d e f g h', [0, 7, 16]],
    ]
    for (const [input, carets] of cases) {
      for (const usable of [10, 5]) {
        for (const caret of carets) {
          expect(composerCaretGlobalRow(input, caret, usable)).toBe(referenceCaretRow(input, caret, usable))
        }
      }
    }
  })

  test('fuzz: 500 drafts × every caret × 3 widths', () => {
    const rand = prng(20260915)
    for (let t = 0; t < 500; t++) {
      const draft = randomDraft(rand, 14)
      for (const usable of [7, 12, 31]) {
        resetComposerRowsCache()
        for (let caret = 0; caret <= draft.length; caret++) {
          expect(composerCaretGlobalRow(draft, caret, usable)).toBe(referenceCaretRow(draft, caret, usable))
        }
      }
    }
  })

  test('the caret follows the PAINT when a prefix would wrap to fewer rows', () => {
    // `wrap-ansi` does not push a row when a hard word ends exactly on the
    // column, so the prefix `'🙂-🙂🇨🇳'` is ONE row while the full draft paints
    // the regional-indicator pair across TWO. The caret must use the paint.
    const draft = '🙂-🙂🇨🇳-🇨🇳'
    expect(composerRowsReference(draft, 7).map((r) => r.text)).toEqual(['🙂-🙂🇨', '🇳-🇨🇳'])
    expect(composerCaretGlobalRow(draft, 9, 7)).toBe(1) // just before the second '-'
    expect(composerCaretGlobalRow(draft, 7, 7)).toBe(0) // hard-wrap seam -> the row ENDING there
    expect(composerCaretGlobalRow(draft, 10, 7)).toBe(1) // inside the second row
  })
})

describe('the visible window keeps the old clamp', () => {
  const oldWindow = (input: string, usable: number, caretRow: number, textArea: number) => {
    const rows = composerRowsReference(input, usable)
    const total = rows.length
    const area = Math.max(1, textArea)
    const first = total <= area ? 0 : Math.max(0, Math.min(caretRow - (area - 1), total - area))
    const lastRow = rows[Math.min(total - 1, first + area - 1)]!
    return { first, start: rows[first]!.start, end: lastRow.start + lastRow.text.length }
  }

  test('matches the pre-refactor window over a batch of drafts and areas', () => {
    const drafts = ['', 'one line', 'a'.repeat(80), 'l1\nl2\nl3\nl4\nl5', '世界'.repeat(40), '🙂 '.repeat(30)]
    for (const draft of drafts) {
      for (const usable of [10, 24, 60]) {
        const total = composerRowsReference(draft, usable).length
        for (const caretRow of [0, Math.floor(total / 2), Math.max(0, total - 1)]) {
          for (const area of [1, 3, 10, 100]) {
            const got = composerWindow(draft, usable, caretRow, area)
            expect({ first: got.first, start: got.start, end: got.end }).toEqual(oldWindow(draft, usable, caretRow, area))
            expect(got.rows).toBe(composerRows(draft, usable))
          }
        }
      }
    }
  })
})

describe('visual caret moves keep the exact row boundaries', () => {
  test('a move lands on the neighbouring row start / same cell column', () => {
    // usable 10, one long line: rows are 0..9, 10..19, ...
    expect(composerCaretMoveVisual('a'.repeat(30), 0, 10, 1)).toBe(10)
    // Row 1 (10..19) keeps cell column 2 → row 2 start 20 + 2.
    expect(composerCaretMoveVisual('a'.repeat(30), 12, 10, 1)).toBe(22)
    expect(composerCaretMoveVisual('a'.repeat(30), 22, 10, -1)).toBe(12)
    // First / last row clamp instead of wrapping around.
    expect(composerCaretMoveVisual('a'.repeat(30), 3, 10, -1)).toBe(3)
    expect(composerCaretMoveVisual('a'.repeat(30), 28, 10, 1)).toBe(28)
    // A draft that fits on one row never moves.
    expect(composerCaretMoveVisual('short', 2, 40, 1)).toBe(2)
  })
})
