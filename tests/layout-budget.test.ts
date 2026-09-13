import { describe, expect, test } from 'bun:test'
import {
  COMPOSER_MIN_HEIGHT,
  DOCKED_CHROME_ABOVE_CARD,
  DOCKED_MIN_ROWS,
  DOCKED_MIN_TRANSCRIPT_ROWS,
  STATUS_BAR_HEIGHT,
  dockedComposerTop,
  dockedFits,
  dockedTranscriptRows,
  tooSmallNoticeLines,
} from '../packages/dsh-tui-app/src/layout-budget.ts'
import { heroTooSmallLines } from '../packages/dsh-tui-app/src/hero-layout.ts'
import { composerStripRows } from '../packages/dsh-tui-app/src/pointer-region.ts'
import { visualWidth } from '../packages/dsh-tui-app/src/markdown.tsx'

describe('docked minimum height (conversation view)', () => {
  test('is derived, not hard-coded: card + chrome above it + status bar + transcript rows', () => {
    expect(COMPOSER_MIN_HEIGHT).toBe(5)
    expect(DOCKED_CHROME_ABOVE_CARD).toBe(2) // message-column paddingY top + the gap above the card
    expect(STATUS_BAR_HEIGHT).toBe(3)
    expect(DOCKED_MIN_TRANSCRIPT_ROWS).toBe(4)
    expect(DOCKED_MIN_ROWS).toBe(14)
    expect(DOCKED_MIN_ROWS).toBe(
      COMPOSER_MIN_HEIGHT + DOCKED_CHROME_ABOVE_CARD + STATUS_BAR_HEIGHT + DOCKED_MIN_TRANSCRIPT_ROWS,
    )
  })

  test('the boundary is 13/14 and is asserted on BOTH sides', () => {
    for (const rows of [1, 5, 8, 9, 10, 11, 12, 13]) expect(dockedFits(rows), `rows=${rows}`).toBe(false)
    for (const rows of [14, 15, 24, 60]) expect(dockedFits(rows), `rows=${rows}`).toBe(true)
  })

  test('when the docked view is drawn the card never overlaps the status bar', () => {
    // The painted stack is: padding top 1 + transcript + gap 1 + card + status 3.
    // The old model slid the card up on short terminals because it ignored the
    // padding/gap; measured on the real binary that put the caret one row off the
    // draft at 9 rows and painted the card's last row under the status bar.
    for (let rows = 1; rows <= 60; rows++) {
      const capped = Math.max(COMPOSER_MIN_HEIGHT, rows - 8) // the docked cap
      for (const cardH of [COMPOSER_MIN_HEIGHT, capped, capped + 1 /* image chip */]) {
        const top = dockedComposerTop(rows, cardH)
        expect(top, `rows=${rows} card=${cardH}: never above the fixed chrome`)
          .toBeGreaterThanOrEqual(1 + DOCKED_CHROME_ABOVE_CARD)
        if (!dockedFits(rows)) continue
        expect(top + cardH - 1, `rows=${rows} card=${cardH}`)
          .toBeLessThanOrEqual(rows - STATUS_BAR_HEIGHT)
      }
    }
  })

  test('at the minimum the card keeps its promise: 4 transcript rows', () => {
    expect(dockedTranscriptRows(DOCKED_MIN_ROWS, COMPOSER_MIN_HEIGHT)).toBe(DOCKED_MIN_TRANSCRIPT_ROWS)
    // Why 10 rows is NOT the product minimum even though the arithmetic is clean
    // there: it reserves ZERO transcript rows — a card you can type into with
    // nothing to read.
    expect(dockedTranscriptRows(10, COMPOSER_MIN_HEIGHT)).toBe(0)
    expect(dockedTranscriptRows(11, COMPOSER_MIN_HEIGHT)).toBe(1)
    expect(dockedTranscriptRows(13, COMPOSER_MIN_HEIGHT)).toBe(3)
    // The bottom-anchored value is what shows on a normal terminal (clamp is a belt).
    expect(dockedComposerTop(24, COMPOSER_MIN_HEIGHT)).toBe(24 - STATUS_BAR_HEIGHT - COMPOSER_MIN_HEIGHT + 1)
    // ...and the clamp really clamps when a card is impossibly tall.
    expect(dockedComposerTop(14, 100)).toBe(1 + DOCKED_CHROME_ABOVE_CARD)
  })

  test('both views use ONE notice builder, and it is TWO short rows', () => {
    // Two rows because the old single line was 76 columns wide: its tail — the
    // actionable part — was the first thing a narrow terminal cut (measured on
    // the real binary at 76/70/60 columns). Both rows now fit from 34 columns up.
    expect(tooSmallNoticeLines(14)).toEqual(['Terminal too small — keys paused', 'resize to at least 14 rows'])
    expect(tooSmallNoticeLines(DOCKED_MIN_ROWS)[1]).toContain(String(DOCKED_MIN_ROWS))
    // The hero's own minimum is 14 as well, so the two screens say the same thing.
    expect(heroTooSmallLines(COMPOSER_MIN_HEIGHT)).toEqual(tooSmallNoticeLines(DOCKED_MIN_ROWS))
    // Per-row WIDTH invariant: nothing may be long enough to need truncation on a
    // terminal where the surface is still meaningful (34 columns = 32 usable).
    for (const line of tooSmallNoticeLines(DOCKED_MIN_ROWS)) {
      expect(visualWidth(line), line).toBeLessThanOrEqual(32)
    }
  })

  test('the pointer mirror reads the same budget (and is empty below the minimum)', () => {
    // Below the docked minimum the render paints the notice instead of the stack,
    // so no cell may be classified as the composer strip.
    expect(composerStripRows(80, 13, 'hi', false, 80)).toBeNull()
    expect(composerStripRows(80, DOCKED_MIN_ROWS, 'hi', false, 80)).toEqual({
      top: dockedComposerTop(DOCKED_MIN_ROWS, COMPOSER_MIN_HEIGHT),
      height: COMPOSER_MIN_HEIGHT,
    })
    // Every drawn size keeps mirror == budget for the card top.
    for (const rows of [14, 20, 24, 37, 60]) {
      const strip = composerStripRows(120, rows, 'hi', false, 120)!
      expect(strip.top, `rows=${rows}`).toBe(dockedComposerTop(rows, strip.height))
      expect(strip.top + strip.height - 1).toBeLessThanOrEqual(rows - STATUS_BAR_HEIGHT)
    }
  })
})
