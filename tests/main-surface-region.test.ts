/**
 * Unit tests for the MAIN-surface pointer-region classifier
 * (`surfaceRegion` in pointer-region.ts). On the conversation surface with no
 * dock open, what a mouse/wheel event does depends on where the pointer sits:
 *   · message rows (message column above the composer) → transcript surface
 *   · composer rows (the input box at the bottom of the message column)
 *   · sidebar rows (the Steps column, only when visible)
 *   · status rows (full-width bottom bar)
 * Pure geometry classifier — no store.
 *
 * Run with `bun test tests/main-surface-region.test.ts`.
 *
 * @module dsh-tui/main-surface-region-test
 */

import { describe, expect, test } from 'bun:test'
import { surfaceRegion, composerStripRows, sidebarContentBand } from '../packages/dsh-tui-app/src/pointer-region.ts'
import { composerCaretMoveVisual } from '../packages/dsh-tui-app/src/panels/conversation.tsx'

/** 24-row / 80-col terminal, sidebar visible → message column ends at col 56.
 *  Composer: 5-row box 17..21, status bar rows 22..24. */
function geometry(): { messageRight: number; composerTop: number; composerBottom: number; statusTop: number } {
  const strip = composerStripRows(80, 24, 'hi', false, 56)!
  return {
    messageRight: 56,
    composerTop: strip.top, // 17
    composerBottom: strip.top + strip.height - 1, // 21
    statusTop: 22, // rows − STATUS_BAR_HEIGHT + 1
  }
}

describe('surfaceRegion (message / composer / sidebar / status)', () => {
  const g = geometry()

  test('message column rows above the composer → message', () => {
    expect(surfaceRegion(1, 1, g)).toBe('message')
    expect(surfaceRegion(16, 40, g)).toBe('message')
    expect(surfaceRegion(16, 56, g)).toBe('message')
  })

  test('composer box rows (17..21) in the message column → composer', () => {
    expect(surfaceRegion(17, 5, g)).toBe('composer')
    expect(surfaceRegion(20, 40, g)).toBe('composer')
    expect(surfaceRegion(21, 56, g)).toBe('composer')
  })

  test('sidebar columns (col > messageRight) → sidebar, for any non-status row', () => {
    expect(surfaceRegion(5, 57, g)).toBe('sidebar')
    expect(surfaceRegion(16, 80, g)).toBe('sidebar')
    // Composer-height rows are still the sidebar to the right of the message
    // column (the sidebar is a full-height sibling).
    expect(surfaceRegion(20, 70, g)).toBe('sidebar')
  })

  test('status bar rows (bottom 3, full width) → status, even over sidebar cols', () => {
    expect(surfaceRegion(22, 5, g)).toBe('status')
    expect(surfaceRegion(23, 70, g)).toBe('status')
    expect(surfaceRegion(24, 80, g)).toBe('status')
  })

  test('sidebar hidden (messageRight == width): no sidebar region', () => {
    const noSide = { ...g, messageRight: 80 }
    expect(surfaceRegion(5, 80, noSide)).toBe('message')
  })
})

describe('composerCaretMoveVisual (wheel scrolls the draft, not the transcript)', () => {  test('stays put on a single-line draft (nothing to scroll)', () => {
    expect(composerCaretMoveVisual('hi', 2, 76, -1)).toBe(2)
    expect(composerCaretMoveVisual('hi', 0, 76, 1)).toBe(0)
  })

  test('moves across wrapped visual rows of one long line', () => {
    // usable 20: "word word word word word" wraps to 3 visual rows
    const text = 'word word word word word'
    const rows = text.length // placeholder, recompute below via expectations
    void rows
    // caret at the very end (last visual row) moves UP one visual row
    const up = composerCaretMoveVisual(text, text.length, 20, -1)
    expect(up).toBeLessThan(text.length)
    expect(up).toBeGreaterThan(0)
    // caret at the start moves DOWN one visual row → row 2 begins mid-text
    const down = composerCaretMoveVisual(text, 0, 20, 1)
    expect(down).toBeGreaterThan(0)
    expect(down).toBeLessThan(text.length)
  })

  test('moves across real newlines', () => {
    const text = 'aa\nbb'
    // Visual rows: "aa" (chars 0..1) then "bb" (chars 3..4).
    expect(composerCaretMoveVisual(text, 2, 76, 1)).toBeGreaterThan(2) // end of "aa" → into "bb"
    expect(composerCaretMoveVisual(text, 0, 76, 1)).toBeGreaterThan(0) // start → "bb" col 0
    expect(composerCaretMoveVisual(text, 5, 76, -1)).toBeLessThan(5)   // end of "bb" → "aa" col
  })
})

describe('composerStripRows mirrors the terminal-height-linked cap', () => {
  test('24-row terminal: ≤12 wrapped rows grow the box; more rows cap at the height-linked max (box rows−8)', () => {
    // rows=24 → cap = max(5, 16) = 16; 12 wrapped rows → composerH = 5+12−1 =
    // 16 (box 6..21) — all 12 visible. 40 rows cap at the same 16 (→ 12
    // visible = rows−12).
    const twelve = composerStripRows(80, 24, Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n'), false, 80)!
    expect(twelve.height).toBe(16)
    expect(twelve.top + twelve.height - 1).toBe(21) // bottom border stays put
    const forty = composerStripRows(80, 24, Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n'), false, 80)!
    expect(forty.height).toBe(16)
    expect(forty.top + forty.height - 1).toBe(21)
  })

  test('tall terminals grow the cap WITH the terminal (rows−8 box, rows−12 visible)', () => {
    // rows=60 → cap = max(5, 52) = 52; 30 wrapped rows fully fit (composerH =
    // 5+30−1 = 34 ≤ 52, no internal scroll).
    const thirty = composerStripRows(120, 60, Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n'), false, 120)!
    expect(thirty.height).toBe(34)
    expect(thirty.top + thirty.height - 1).toBe(57) // 60 − STATUS_BAR_HEIGHT
    // 70 rows cap at 52 (box) → 48 visible text rows (rows−12); internal scroll.
    const seventy = composerStripRows(120, 60, Array.from({ length: 70 }, (_, i) => `line${i}`).join('\n'), false, 120)!
    expect(seventy.height).toBe(52)
    expect(seventy.top + seventy.height - 1).toBe(57)
  })

  test('small terminals tighten the cap via the rows−8 viewport guard', () => {
    // rows=14 → cap = max(5, 14−8) = 6 → only 2 visible text rows (box height 6).
    const small = composerStripRows(80, 14, Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n'), false, 80)!
    expect(small.height).toBe(6)
    expect(small.top + small.height - 1).toBe(11) // 14 − STATUS_BAR_HEIGHT
  })

  test('an image chip still adds one box row above the height-linked cap', () => {
    const tall = composerStripRows(120, 60, Array.from({ length: 70 }, (_, i) => `line${i}`).join('\n'), true, 120)!
    expect(tall.height).toBe(53) // 52 + chip row
    expect(tall.top + tall.height - 1).toBe(57)
  })
})

describe('sidebarContentBand (sidebar drag-select column band)', () => {
  test('matches the rendered sidebar: border + padding offsets on both sides', () => {
    // 80-col terminal, sidebar width 24 → message column ends at col 56
    // (1-based messageRight). Sidebar starts col 57; its text starts after the
    // left border + paddingX (grid: messageRight+2) and ends two cells before
    // the terminal edge (width−3) — verified against the real Ink render.
    expect(sidebarContentBand(80, 56)).toEqual({ left: 58, right: 77 })
    // The 64-col probe: message 40 + sidebar 24 → content grid cols 42..61.
    expect(sidebarContentBand(64, 40)).toEqual({ left: 42, right: 61 })
  })

  test('never overlaps the message column or the terminal edge', () => {
    const { left, right } = sidebarContentBand(120, 84)
    expect(left).toBeGreaterThan(84) // past messageRight
    expect(right).toBeLessThan(120)
    expect(right - left + 1).toBeGreaterThan(20) // full sidebar content width
  })
})
