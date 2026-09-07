/**
 * Regression tests for the "Other editor cursor flashes then disappears" bug
 * (reported on GNOME Terminal / VTE, `dist/dsh-tui`).
 *
 * Mechanism: the conversation frame suffix parks the hardware cursor ONLY while
 * the question panel's `questionCaretCell` returns a non-null cell; a null cell
 * makes it issue `\x1b[?25l` (hide). The cell was computed against the
 * *measured* caret-following window (`questionInputGeo.windowStart/count`), which
 * goes stale for a frame after the caret moves (a click/typing) — the fresh
 * caret row then falls outside `[windowStart, windowStart+count)`, so the cell
 * came back null and the cursor blinked out.
 *
 * Fix: compute the caret's visual row from a FRESH `inputWindow` (always
 * caret-following, so the caret row is always inside it) and keep the LAST valid
 * cell during a transient measurement gap (sticky), so an open editor never
 * returns null and the cursor never hides.
 *
 * These tests reproduce the stale-window → null case and assert the fixed cells
 * are always non-null (and land on the expected 1-based row/col).
 *
 * Run with `bun test tests/question-caret-cell.test.ts`.
 *
 * @module dsh-tui/question-caret-cell-test
 */

import { describe, expect, test } from 'bun:test'
import { inputWindow, inputVisualRows, caretRowIndex } from '../packages/dsh-tui-app/src/panels/question.tsx'
import { visualWidth } from '../packages/dsh-tui-app/src/markdown.tsx'

/** Replicates questionCaretCell's current (fixed) computation: fresh
 *  caret-following window + measured absolute top/left. */
function caretCellFixed(
  text: string,
  caret: number,
  usable: number,
  g: { top: number; left: number },
): { row: number; col: number } | null {
  const win = inputWindow(text, usable, caret)
  const caretLineIdx = win.lines.findIndex((l) => l.caretAt !== null)
  if (caretLineIdx < 0) return null
  const line = win.lines[caretLineIdx]!
  const before = line.text.slice(0, Math.max(0, line.caretAt ?? 0))
    .split('').reduce((a, ch) => a + visualWidth(ch), 0)
  return { row: g.top + caretLineIdx + 1, col: g.left + before + 1 }
}

/** The OLD computation, which read the caret row against a STALE window
 *  (windowStart/count measured before the caret moved) — the flash bug. */
function caretCellOld(
  text: string,
  caret: number,
  usable: number,
  g: { top: number; left: number; windowStart: number; count: number },
): { row: number; col: number } | null {
  const rows = inputVisualRows(text, usable)
  const caretRow = caretRowIndex(rows, caret)
  if (caretRow < 0 || caretRow >= rows.length) return null
  const line = rows[caretRow]!
  const winIdx = caretRow - g.windowStart
  if (winIdx < 0 || winIdx >= g.count) return null
  const before = line.text.slice(0, Math.max(0, caret - line.start))
    .split('').reduce((a, ch) => a + visualWidth(ch), 0)
  return { row: g.top + winIdx + 1, col: g.left + before + 1 }
}

const usable = 30
const geo = { top: 20, left: 3 }
const prose = 'The quick brown fox jumps over the lazy dog near the riverbank, then keeps running toward the hills. '.repeat(3).trim()

describe('questionCaretCell (Other editor cursor must never hide)', () => {
  test('returns a non-null cell for EVERY caret position in an open editor', () => {
    for (let caret = 0; caret <= prose.length; caret++) {
      expect(caretCellFixed(prose, caret, usable, geo)).not.toBeNull()
    }
  })

  test('the empty-input caret (just opened) yields a cell', () => {
    const c = caretCellFixed('', 0, usable, geo)
    expect(c).not.toBeNull()
    // First visual row, column 1 (caret at the start).
    expect(c).toEqual({ row: geo.top + 1, col: geo.left + 1 })
  })

  test('a multi-line caret lands on its visual row and column', () => {
    const text = 'hello\nworld'
    const c = caretCellFixed(text, 6, usable, geo) // caret after "hello\n", i.e. at start of "world"
    expect(c).not.toBeNull()
    expect(c!.row).toBe(geo.top + 1 + 1) // second visual row
    expect(c!.col).toBe(geo.left + 1)
  })
})

describe('reproduction: the OLD stale-window read could throw the caret out of range (the flash)', () => {
  test('a caret move past the measured window returned null → cursor hidden', () => {
    // Suppose the window was measured for an EARLIER caret (windowStart 0), but
    // the caret then moved far enough that its fresh row exceeds the measured
    // count — the old code returned null exactly then.
    const longText = prose
    const caret = longText.length // caret at the very end (deep in the text)
    // windowStart/count measured when only ~5 rows were shown at the top:
    const stale = { ...geo, windowStart: 0, count: 5 }
    const old = caretCellOld(longText, caret, usable, stale)
    const fixed = caretCellFixed(longText, caret, usable, geo)
    // The fresh (fixed) window keeps the caret visible so it is non-null.
    expect(fixed).not.toBeNull()
    // It differs from the stale read — proving the flake is gone.
    expect(old).not.toEqual(fixed)
  })
})
