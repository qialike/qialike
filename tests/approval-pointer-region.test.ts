/**
 * Unit tests for the approval dock's horizontal OPTIONS-row geometry
 * (`setDialogRowGeometry`/`dialogRowIndexFromCol` in list-geometry.ts) and the
 * shared pointer-region router the approval panel routes mouse/wheel events
 * through.
 *
 * The approval dock's Deny / Allow always / Allow once share ONE horizontal
 * row, but the dock also has a title row, a reason row and a hint row above
 * and below it. The row geometry now records the options row's SCREEN ROW, so
 * hover/click maps a column to an option ONLY when the pointer is actually on
 * that row — hovering a title/reason/hint row that happens to share a column
 * must never highlight or trigger an option. The dock and the message column
 * around it route through the same pure pointer-region function the question
 * dock uses (dock rows → dock actions, composer strip + message rows → normal
 * surface, sidebar → none).
 *
 * Run with `bun test tests/approval-pointer-region.test.ts`.
 *
 * @module qialike/approval-pointer-region-test
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { setDialogRowGeometry, dialogRowIndexFromCol } from '../packages/qialike-app/src/list-geometry.ts'
import { pointerRegion, composerStripRows, messageRightFor } from '../packages/qialike-app/src/pointer-region.ts'

/** Options row on grid row 6 (0-based → 1-based screen row 7), 0-based left
 *  edge 4; the three options occupy cols 5..5+len-1 (Deny=3, Allow always=12,
 *  Allow once=10 wide, gap 2 between). */
const ROW = { topRow: 6, left: 4, widths: [3, 12, 10] }
const screenRowOfOptions = ROW.topRow + 1 // 7 (1-based SGR row)

describe('dialogRowIndexFromCol (row-gated options geometry)', () => {
  beforeEach(() => setDialogRowGeometry(ROW))

  test('a column on the OPTIONS row maps to the option under it', () => {
    // Option 0 spans screen cols 5..7 (left 4 + widths[0]=3, cols are 1-based).
    expect(dialogRowIndexFromCol(screenRowOfOptions, 5)).toBe(0)
    expect(dialogRowIndexFromCol(screenRowOfOptions, 7)).toBe(0)
    // Option 1 starts after option 0 (3) + its 2-col gap: 10..21.
    expect(dialogRowIndexFromCol(screenRowOfOptions, 10)).toBe(1)
    expect(dialogRowIndexFromCol(screenRowOfOptions, 21)).toBe(1)
    // Option 2: after option 1 (12) + gap: 24..33.
    expect(dialogRowIndexFromCol(screenRowOfOptions, 24)).toBe(2)
    expect(dialogRowIndexFromCol(screenRowOfOptions, 33)).toBe(2)
    // The gap columns between options map to nothing.
    expect(dialogRowIndexFromCol(screenRowOfOptions, 8)).toBe(-1)
    expect(dialogRowIndexFromCol(screenRowOfOptions, 9)).toBe(-1)
    expect(dialogRowIndexFromCol(screenRowOfOptions, 22)).toBe(-1)
  })

  test('the same columns on a DIFFERENT row (title/reason/hint) never map', () => {
    for (const other of [screenRowOfOptions - 2, screenRowOfOptions - 1, screenRowOfOptions + 1, screenRowOfOptions + 2]) {
      expect(dialogRowIndexFromCol(other, 10)).toBe(-1)
      expect(dialogRowIndexFromCol(other, 22)).toBe(-1)
    }
  })

  test('a column outside any option segment maps to -1 even on the options row', () => {
    expect(dialogRowIndexFromCol(screenRowOfOptions, 1)).toBe(-1) // left of row
    expect(dialogRowIndexFromCol(screenRowOfOptions, 200)).toBe(-1)
  })

  test('before any row geometry is registered, mapping returns -1', () => {
    setDialogRowGeometry(null)
    expect(dialogRowIndexFromCol(screenRowOfOptions, 10)).toBe(-1)
  })
})

describe('shared pointer-region router (used by the approval dock)', () => {
  /** A measured approval dock occupying screen rows 10..20 (11 rows). */
  const dock = { top: 10, height: 11 }
  const composer = { top: 23, height: 5 }
  const MSG_RIGHT = 80

  test('dock rows → dock; message rows above the dock → message', () => {
    expect(pointerRegion(10, 5, dock, MSG_RIGHT, composer)).toBe('dock')
    expect(pointerRegion(20, 40, dock, MSG_RIGHT, composer)).toBe('dock')
    expect(pointerRegion(9, 5, dock, MSG_RIGHT, composer)).toBe('message')
    expect(pointerRegion(22, 5, dock, MSG_RIGHT, composer)).toBe('message') // gap row
  })

  test('composer strip rows (below the dock) → composer', () => {
    expect(pointerRegion(23, 5, dock, MSG_RIGHT, composer)).toBe('composer')
    expect(pointerRegion(27, 40, dock, MSG_RIGHT, composer)).toBe('composer')
  })

  test('sidebar columns → none, even over dock rows', () => {
    expect(pointerRegion(15, 81, dock, MSG_RIGHT, composer)).toBe('none')
  })

  test('before the dock is measured, non-composer rows are conservatively dock', () => {
    expect(pointerRegion(5, 3, null, MSG_RIGHT, composer)).toBe('dock')
    expect(pointerRegion(23, 3, null, MSG_RIGHT, composer)).toBe('composer') // strip still usable
  })
})

describe('messageRightFor (message column right edge)', () => {
  test('no sidebar under SIDEBAR_MIN_WIDTH; sidebar width below the threshold', () => {
    expect(messageRightFor(100, 'auto')).toBe(100)
    expect(messageRightFor(100, 'off')).toBe(100)
    expect(messageRightFor(140, 'off')).toBe(140)
  })
  test('auto at/above the sidebar threshold reserves round(width*0.3)', () => {
    expect(messageRightFor(120, 'auto')).toBe(120 - Math.max(20, Math.round(120 * 0.3)))
    expect(messageRightFor(120, 'on')).toBe(120 - Math.max(20, Math.round(120 * 0.3)))
  })
})

describe('composerStripRows mirrors the conversation composer (approval open)', () => {
  test('24-row terminal: one-line draft → 5-row borderless card above the status bar', () => {
    // Height counts the two half-row fill edges (▄/▀) + text area + gap + status.
    expect(composerStripRows(80, 24, 'hi', false, 80)).toEqual({ top: 17, height: 5 })
  })
  test('image chip adds one row (growing upward)', () => {
    expect(composerStripRows(80, 24, 'hi', true, 80)).toEqual({ top: 16, height: 6 })
  })
})
