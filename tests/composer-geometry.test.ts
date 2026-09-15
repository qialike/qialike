/**
 * The composer's PURE geometry: click→draft index, the hardware caret cell and
 * the selection bounds. These are the three mappings the bounded-layout refactor
 * moved off "wrap the prefix again" onto the shared row model, so they are
 * pinned against the reference formula (wrap the prefix, take the last row) for
 * a fuzz batch — a drift here is what silently misplaces the caret or selects
 * the wrong text.
 *
 * Run with `bun test tests/composer-geometry.test.ts`.
 *
 * @module dsh-tui/composer-geometry-test
 */
import { describe, expect, test } from 'bun:test'
import stringWidth from 'string-width'
import {
  composerCaretCellIn, composerInputIndexIn, composerSelectionBounds,
} from '../packages/dsh-tui-app/src/panels/conversation.tsx'
import { composerRows, composerRowsReference, resetComposerRowsCache } from '../packages/dsh-tui-app/src/composer-rows.ts'

const BAND_TOP = 5
const BAND_LEFT = 1
const LEAD = 0

/**
 * Reference hardware caret cell, from an independent linear scan of the FULL
 * painted rows (the paint is the authority — see `composer-rows.test.ts` for why
 * the old "wrap the prefix" formula could disagree with it).
 */
function referenceCaretCell(
  input: string, caret: number, usable: number, first: number,
): { row: number; col: number } {
  const rows = composerRowsReference(input, usable)
  const at = Math.max(0, Math.min(caret, input.length))
  let caretRow = Math.max(0, rows.length - 1)
  if (at < input.length) for (let r = 0; r < rows.length; r++) {
    const start = rows[r]!.start
    const end = start + rows[r]!.text.length
    if (at < start) { caretRow = Math.max(0, r - 1); break }
    if (at > end) continue
    if (at === start) {
      const newline = r === 0 || start - (rows[r - 1]!.start + rows[r - 1]!.text.length) === 1
      caretRow = newline ? r : Math.max(0, r - 1)
    } else {
      caretRow = r
    }
    break
  }
  const lastLine = rows[caretRow]!.text.slice(0, at - rows[caretRow]!.start)
  const visRow = Math.max(0, caretRow - first)
  return { row: BAND_TOP + 1 + LEAD + visRow, col: BAND_LEFT + 2 + stringWidth(lastLine) }
}

function prng(seed: number): () => number {
  let s = seed
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
}

const ALPHABET = ['a', 'b', ' ', ' ', '\n', '世', '🙂', '-', 'e\u0301']

describe('composerCaretCellIn matches the prefix wrap it replaced', () => {
  test('fuzz: 300 drafts × every caret × 3 widths × window offset', () => {
    const rand = prng(424242)
    for (let t = 0; t < 300; t++) {
      let draft = ''
      const parts = Math.floor(rand() * 12)
      for (let i = 0; i < parts; i++) draft += ALPHABET[Math.floor(rand() * ALPHABET.length)]
      for (const usable of [8, 15, 40]) {
        resetComposerRowsCache()
        const rows = composerRows(draft, usable)
        const total = rows.length
        for (const first of [0, Math.max(0, total - 3)]) {
          for (let caret = 0; caret <= draft.length; caret++) {
            expect(composerCaretCellIn(rows, draft, caret, BAND_TOP, BAND_LEFT, LEAD, first))
              .toEqual(referenceCaretCell(draft, caret, usable, first))
          }
        }
      }
    }
  })

  test('the image chip shifts the caret one row down', () => {
    resetComposerRowsCache()
    const rows = composerRows('hi', 20)
    const without = composerCaretCellIn(rows, 'hi', 2, BAND_TOP, BAND_LEFT, 0, 0)
    const withChip = composerCaretCellIn(rows, 'hi', 2, BAND_TOP, BAND_LEFT, 1, 0)
    expect(withChip.row).toBe(without.row + 1)
    expect(withChip.col).toBe(without.col)
  })
})

describe('composerInputIndexIn maps a painted cell to a draft index', () => {
  test('the left padding is the row start; a cell right of it is the next char', () => {
    resetComposerRowsCache()
    const rows = composerRows('abc\ndef', 20)
    // Row 0 of the window is painted at bandTop + 1 (the ▄ edge is bandTop).
    expect(composerInputIndexIn(rows, 0, BAND_TOP, BAND_LEFT, 0, BAND_TOP + 1, BAND_LEFT + 2)).toBe(0)
    expect(composerInputIndexIn(rows, 0, BAND_TOP, BAND_LEFT, 0, BAND_TOP + 1, BAND_LEFT + 3)).toBe(1)
    expect(composerInputIndexIn(rows, 0, BAND_TOP, BAND_LEFT, 0, BAND_TOP + 2, BAND_LEFT + 2)).toBe(rows[1]!.start)
    // Past the end of a row clamps to the row's end, as the render does.
    expect(composerInputIndexIn(rows, 0, BAND_TOP, BAND_LEFT, 0, BAND_TOP + 1, BAND_LEFT + 50)).toBe(3)
  })

  test('clicks on the card chrome / outside the window are null', () => {
    resetComposerRowsCache()
    const rows = composerRows('abc', 20)
    expect(composerInputIndexIn(rows, 0, BAND_TOP, BAND_LEFT, 0, BAND_TOP, BAND_LEFT + 2)).toBeNull()
    expect(composerInputIndexIn(rows, 0, BAND_TOP, BAND_LEFT, 0, BAND_TOP + 2, BAND_LEFT + 2)).toBeNull()
    // A scrolled window: the first VISIBLE row is global row `first`.
    const first = rows.length - 1
    expect(composerInputIndexIn(rows, first, BAND_TOP, BAND_LEFT, 0, BAND_TOP + 1, BAND_LEFT + 2)).toBe(rows[first]!.start)
  })
})

describe('composerSelectionBounds normalizes a drag', () => {
  test('order-independent, null endpoints collapse to an edge, empty is null', () => {
    expect(composerSelectionBounds(3, 9, 20)).toEqual({ start: 3, end: 9 })
    expect(composerSelectionBounds(9, 3, 20)).toEqual({ start: 3, end: 9 })
    expect(composerSelectionBounds(null, 7, 20)).toEqual({ start: 0, end: 7 })
    expect(composerSelectionBounds(7, null, 20)).toEqual({ start: 7, end: 20 })
    expect(composerSelectionBounds(null, null, 20)).toBeNull()
    expect(composerSelectionBounds(5, 5, 20)).toBeNull()
    expect(composerSelectionBounds(12, 4, 20)).toEqual({ start: 4, end: 12 })
  })
})
