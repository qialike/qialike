/**
 * Tests for the Other-editor wheel-scroll gate (`inputWheelScrollsAt`).
 *
 * Requirement: in the question dock's inline "Other" input, when the text
 * overflows its visible ≤5-row window, a mouse wheel tick over the input
 * scrolls it (one visual line, exactly like ↑/↓) instead of staying inert.
 * Everywhere else on the dock the wheel must stay inert — so the gate needs
 * BOTH: (a) the tick happened over the editor's box (its visible window rows,
 * spanning the dock-inner width) AND (b) the content really overflows the
 * window (more visual rows than shown). Without overflow there is nothing to
 * scroll and the wheel keeps the dock-inert semantics.
 *
 * Run with `bun test tests/question-input-wheel.test.ts`.
 *
 * @module qialike/question-input-wheel-test
 */

import { describe, expect, test } from 'bun:test'
import { inputWheelScrollsAt } from '../packages/qialike-app/src/panels/question.tsx'

// Measured input-box geometry (as the panel records it per frame): content
// starts at 1-based SGR (top+1, left+1); the window shows `count` rows.
const geo = { top: 20, left: 5, count: 5 }
const usable = 30

describe('inputWheelScrollsAt (dock wheel scrolls the Other input only when hovered AND overflowing)', () => {
  test('a tick over the input window scrolls when content overflows', () => {
    // 12 visual rows of content, window shows 5 → overflow.
    expect(inputWheelScrollsAt(geo.top + 1, geo.left + 1, geo, 12, usable)).toBe(true)
    expect(inputWheelScrollsAt(geo.top + 3, geo.left + 15, geo, 12, usable)).toBe(true)
    expect(inputWheelScrollsAt(geo.top + 5, geo.left + usable, geo, 12, usable)).toBe(true)
  })

  test('content that fits the window (≤5 rows) never scrolls, even when hovered', () => {
    expect(inputWheelScrollsAt(geo.top + 1, geo.left + 1, geo, 5, usable)).toBe(false)
    expect(inputWheelScrollsAt(geo.top + 2, geo.left + 10, geo, 3, usable)).toBe(false)
  })

  test('a tick outside the editor rows (above/below its window) stays inert', () => {
    // Row 0 relative (the row right above the box top) and the row right below
    // the window: neither is inside the input grid.
    expect(inputWheelScrollsAt(geo.top, geo.left + 1, geo, 12, usable)).toBe(false)
    expect(inputWheelScrollsAt(geo.top + geo.count + 1, geo.left + 1, geo, 12, usable)).toBe(false)
    expect(inputWheelScrollsAt(1, geo.left + 1, geo, 12, usable)).toBe(false)
  })

  test('a tick outside the input columns (left of / right of the box) stays inert', () => {
    // One cell left of the content start and one cell past the inner width.
    expect(inputWheelScrollsAt(geo.top + 1, geo.left, geo, 12, usable)).toBe(false)
    expect(inputWheelScrollsAt(geo.top + 1, geo.left + usable + 1, geo, 12, usable)).toBe(false)
    expect(inputWheelScrollsAt(geo.top + 1, 1, geo, 12, usable)).toBe(false)
  })

  test('the window edge is inclusive: first/last content cell and row scroll', () => {
    expect(inputWheelScrollsAt(geo.top + 1, geo.left + 1, geo, 12, usable)).toBe(true)
    expect(inputWheelScrollsAt(geo.top + geo.count, geo.left + usable, geo, 12, usable)).toBe(true)
  })

  test('a smaller window bounds the hit area to its own rows', () => {
    // Pure-function generality: whatever `count` the geometry records, only
    // those rows are hoverable for the wheel (overflow still required).
    const shortWin = { top: 20, left: 5, count: 2 }
    expect(inputWheelScrollsAt(shortWin.top + 1, shortWin.left + 1, shortWin, 9, usable)).toBe(true)
    expect(inputWheelScrollsAt(shortWin.top + 2, shortWin.left + 1, shortWin, 9, usable)).toBe(true)
    expect(inputWheelScrollsAt(shortWin.top + 3, shortWin.left + 1, shortWin, 9, usable)).toBe(false)
  })
})
