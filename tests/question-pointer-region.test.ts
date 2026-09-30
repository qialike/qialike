/**
 * Unit tests for the question-dock pointer-region routing
 * (`questionPointerRegion` in panels/question.tsx). While a question / plan
 * dock is up, what a mouse or wheel event means depends on where the pointer
 * sits:
 *   · on the dock rows (over the message column)      → 'dock'
 *   · on the COMPOSER's rows (the box at the very bottom of the message
 *     column, below the dock)                        → 'composer'
 *   · on the message column outside dock & composer   → 'message'
 *   · outside the message column (Steps sidebar, …)   → 'none'
 * The composer strip never overlaps the dock (in-flow siblings) and its
 * geometry is deterministic, so it is classified even before the dock's first
 * measurement lands; a MEASURED dock still wins if it ever painted over the
 * strip (overflow).
 *
 * Run with `bun test tests/question-pointer-region.test.ts`.
 *
 * @module qialike/question-pointer-region-test
 */

import { describe, expect, test } from 'bun:test'
import { questionPointerRegion, composerStripRows } from '../packages/qialike-app/src/panels/question.tsx'

/** A measured dock occupying screen rows 12..20 (9 rows). */
const dock = { top: 12, height: 9 }
/** The composer box: 5 rows at the bottom of the message column. */
const composer = { top: 22, height: 5 }
const MSG_RIGHT = 80 // no sidebar

describe('questionPointerRegion (dock / composer / message / none)', () => {
  test('a cell inside the dock rows over the message column → dock', () => {
    expect(questionPointerRegion(12, 1, dock, MSG_RIGHT, composer)).toBe('dock')
    expect(questionPointerRegion(20, 40, dock, MSG_RIGHT, composer)).toBe('dock')
    expect(questionPointerRegion(16, MSG_RIGHT, dock, MSG_RIGHT, composer)).toBe('dock')
  })

  test('a cell inside the composer box rows → composer', () => {
    expect(questionPointerRegion(22, 1, dock, MSG_RIGHT, composer)).toBe('composer')
    expect(questionPointerRegion(25, 40, dock, MSG_RIGHT, composer)).toBe('composer')
    expect(questionPointerRegion(26, MSG_RIGHT, dock, MSG_RIGHT, composer)).toBe('composer')
  })

  test('the composer strip is classified even before the dock is measured', () => {
    expect(questionPointerRegion(23, 3, null, MSG_RIGHT, composer)).toBe('composer')
    expect(questionPointerRegion(26, 40, null, MSG_RIGHT, composer)).toBe('composer')
  })

  test('the message column above the dock → message', () => {
    expect(questionPointerRegion(1, 1, dock, MSG_RIGHT, composer)).toBe('message')
    expect(questionPointerRegion(11, MSG_RIGHT, dock, MSG_RIGHT, composer)).toBe('message')
  })

  test('the row just below the dock / above the composer → message', () => {
    // Row 21: dock rows end at 20 (exclusive boundary), composer rows start at
    // 22 → the blank strip between them is ordinary message-column space.
    expect(questionPointerRegion(21, 5, dock, MSG_RIGHT, composer)).toBe('message')
  })

  test('outside the message column (sidebar) → none, even over dock rows', () => {
    // Sidebar visible: message column ends at column 80; cols 81+ are the Steps
    // sidebar.
    expect(questionPointerRegion(16, 81, dock, MSG_RIGHT, composer)).toBe('none')
    expect(questionPointerRegion(1, 200, dock, MSG_RIGHT, composer)).toBe('none')
    expect(questionPointerRegion(24, MSG_RIGHT + 1, dock, MSG_RIGHT, composer)).toBe('none')
  })

  test('a measured dock wins over the composer strip if they overlap (overflow)', () => {
    const tallDock = { top: 18, height: 9 } // reaches into composer rows 22..26
    expect(questionPointerRegion(23, 3, tallDock, MSG_RIGHT, composer)).toBe('dock')
    expect(questionPointerRegion(20, 3, tallDock, MSG_RIGHT, composer)).toBe('dock')
  })

  test('before the dock is measured (null span) rows outside the composer count as dock', () => {
    expect(questionPointerRegion(5, 3, null, MSG_RIGHT, composer)).toBe('dock')
    expect(questionPointerRegion(15, 40, null, MSG_RIGHT, composer)).toBe('dock')
    expect(questionPointerRegion(21, 5, null, MSG_RIGHT, composer)).toBe('dock')
    expect(questionPointerRegion(5, MSG_RIGHT + 10, null, MSG_RIGHT, composer)).toBe('none')
  })

  test('no composer strip (null span) → its rows fall back to message/dock rules', () => {
    // Callers always pass a computed composer span, but the pure function is
    // null-tolerant: with no composer span the rows below the dock behave like
    // the old 3-region router.
    expect(questionPointerRegion(23, 5, dock, MSG_RIGHT, null)).toBe('message')
    expect(questionPointerRegion(26, 5, dock, MSG_RIGHT, null)).toBe('message')
    expect(questionPointerRegion(26, 5, null, MSG_RIGHT, null)).toBe('dock')
  })
})

describe('composerStripRows (mirror of conversation composer math)', () => {
  test('24-row terminal: a one-line draft gives a 5-row card above the status bar', () => {
    // ROWS=24: the card's bottom sits at rows−STATUS_BAR_HEIGHT = 21. The
    // borderless card's height counts its two half-row fill edges (▄/▀) plus a
    // 1-row text area, gap and status row → 5 rows, spanning 17..21.
    expect(composerStripRows(80, 24, 'hi', false, 80)).toEqual({ top: 17, height: 5 })
  })

  test('an attached image chip adds one row (growing upward)', () => {
    expect(composerStripRows(80, 24, 'hi', true, 80)).toEqual({ top: 16, height: 6 })
  })

  test('a multi-line draft grows the card until the rows−8 cap', () => {
    // usable = 80−4 = 76; 4 wrapped rows → min(5+4−1, 16) = 8 → card 14..21.
    expect(composerStripRows(80, 24, 'a\nb\nc\nd', false, 80)).toEqual({ top: 14, height: 8 })
    // Long single line that wraps several times also grows the box.
    const long = 'word '.repeat(200)
    const span = composerStripRows(80, 24, long, false, 80)!
    expect(span.height).toBeGreaterThan(5)
    expect(span.top + span.height - 1).toBe(21) // card bottom stays put
  })

  test('degenerate sizes return null', () => {
    expect(composerStripRows(0, 24, '', false, 80)).toBeNull()
    expect(composerStripRows(80, 0, '', false, 80)).toBeNull()
    expect(composerStripRows(80, 24, '', false, 0)).toBeNull()
  })
})
