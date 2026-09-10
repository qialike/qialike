/**
 * Tests for the centered HERO layout math (web parity): the composer card is a
 * centered, NARROW column inside the hero stack, and the renderer + pointer
 * geometry mirrors both read these numbers, so the invariants here are what
 * keeps routing aligned with what is painted.
 *
 * Run with `bun test tests/hero-layout.test.ts`.
 *
 * @module dsh-tui/hero-layout-test
 */

import { describe, expect, test } from 'bun:test'
import {
  HERO_COMPOSER_EXTRA_ROWS,
  HERO_COMPOSER_MAX_COLS,
  HERO_COMPOSER_MIN_COLS,
  HERO_COMPOSER_SIDE_CLEARANCE,
  HERO_TITLE,
  HERO_TITLE_EN,
  HERO_TITLE_ZH,
  HERO_COMPOSER_INPUT_ROWS,
  HERO_PLACEHOLDER,
  HERO_STATUS_BAR_HEIGHT,
  HERO_WORDMARK,
  heroComposerLeft,
  heroComposerWidth,
  HERO_TITLE_CARD_GAP,
  heroLayout,
  heroWordmarkFits,
} from '../packages/dsh-tui-app/src/hero-layout.ts'
import { visualWidth } from '../packages/dsh-tui-app/src/markdown.tsx'

const BASE = { rows: 30, boxH: 5, brandLines: HERO_WORDMARK.length + 1, hintLines: 1 }

describe('wordmark', () => {
  test('5 equal-width ASCII rows (no ambiguous-width glyphs)', () => {
    expect(HERO_WORDMARK).toHaveLength(5)
    const widths = new Set(HERO_WORDMARK.map((l) => visualWidth(l)))
    expect(widths.size).toBe(1)
    expect([...widths][0]).toBe(HERO_WORDMARK[0]!.length) // ASCII: visual width == length
    expect(/^[# ]+$/.test(HERO_WORDMARK.join(''))).toBe(true)
  })
})

describe('heroLayout centering', () => {
  test('spacers plus stack fill the padded area exactly (no context, no footer)', () => {
    const l = heroLayout(BASE)
    expect(l.topSpacer + l.stackRows + l.bottomSpacer).toBe(l.areaRows)
    expect(l.topSpacer).toBeGreaterThan(0)
    expect(Math.abs(l.topSpacer - l.bottomSpacer)).toBeLessThanOrEqual(1)
  })

  test('composerTopRow is derived from the emitted rows (brand → gap → card)', () => {
    const l = heroLayout(BASE)
    // 1 (first terminal row) + 1 (paddingY) + spacer + brand + HERO_TITLE_CARD_GAP
    expect(l.composerTopRow).toBe(2 + l.topSpacer + BASE.brandLines + HERO_TITLE_CARD_GAP)
    expect(l.composerBottomRow).toBe(l.composerTopRow + BASE.boxH - 1)
  })

  test('palette lifts by the rows that sit below the card', () => {
    const l = heroLayout(BASE)
    expect(l.paletteBottomMargin).toBe(1 + BASE.hintLines + l.bottomSpacer)
  })

  test('title-only (no wordmark) and no-hint variants keep the formula', () => {
    const noWord = heroLayout({ ...BASE, brandLines: 1 })
    expect(noWord.composerTopRow).toBe(2 + noWord.topSpacer + 1 + HERO_TITLE_CARD_GAP)
    const noHints = heroLayout({ ...BASE, hintLines: 0 })
    expect(noHints.paletteBottomMargin).toBe(noHints.bottomSpacer)
    expect(noHints.topSpacer + noHints.stackRows + noHints.bottomSpacer).toBe(noHints.areaRows)
  })

  test('explicit context/footer rows still shift the stack (docked-style callers)', () => {
    const withContext = heroLayout({ ...BASE, contextLines: 1 })
    expect(withContext.composerTopRow).toBe(2 + withContext.topSpacer + BASE.brandLines + 1 + 1 + 1)
    const withFooter = heroLayout({ ...BASE, footerLines: 1 })
    expect(withFooter.paletteBottomMargin).toBe(1 + BASE.hintLines + withFooter.bottomSpacer + 1)
    expect(withFooter.topSpacer + withFooter.stackRows + withFooter.bottomSpacer + 1).toBe(withFooter.areaRows)
  })

  test('a too-short terminal collapses the spacers instead of going negative', () => {
    const l = heroLayout({ rows: 12, boxH: 6, brandLines: 6, hintLines: 1 })
    expect(l.topSpacer).toBe(0)
    expect(l.bottomSpacer).toBe(0)
    expect(l.composerTopRow).toBeGreaterThanOrEqual(2)
  })
})

describe('chrome-free hero (no status bar)', () => {
  test('no status-bar rows are reserved: the stack owns the whole window', () => {
    const l = heroLayout(BASE)
    expect(l.areaRows).toBe(BASE.rows - 2) // only the area paddingY is taken out
    // The DOCKED bar still exists at its usual height — the hero just never
    // draws it, so its 3 rows are NOT subtracted from the hero area.
    expect(HERO_STATUS_BAR_HEIGHT).toBe(3)
    expect(l.areaRows).toBeGreaterThan(BASE.rows - 2 - HERO_STATUS_BAR_HEIGHT)
  })

  test('a taller hero area centers the stack lower (3 extra rows split evenly)', () => {
    const withBar = heroLayout({ ...BASE, rows: BASE.rows })
    const asIfBar = heroLayout({ ...BASE, rows: BASE.rows - HERO_STATUS_BAR_HEIGHT })
    expect(withBar.topSpacer + withBar.bottomSpacer)
      .toBeGreaterThan(asIfBar.topSpacer + asIfBar.bottomSpacer)
  })
})

describe('hero composer card width (web-parity centered column)', () => {
  test('never fills the window on a typical terminal', () => {
    for (const width of [80, 100, 120, 200, 400]) {
      const card = heroComposerWidth(width)
      expect(card).toBeLessThanOrEqual(HERO_COMPOSER_MAX_COLS)
      expect(card).toBeLessThan(width)
      expect(heroComposerLeft(width) + card - 1).toBeLessThanOrEqual(width)
    }
  })

  test('grows with the window up to the cap (72% of the window + chrome)', () => {
    // 110 → round(79.2) + 3 = 82 → capped at 76 (69% of the window)
    expect(heroComposerWidth(110)).toBe(HERO_COMPOSER_MAX_COLS)
    expect(heroComposerWidth(110)).toBeLessThan(110 * 0.75)
    // wide enough to keep the web placeholder on ONE line
    expect(heroComposerWidth(110) - 4).toBeGreaterThanOrEqual(HERO_PLACEHOLDER.length)
    // 80 → round(57.6) + 3 = 61
    expect(heroComposerWidth(80)).toBe(61)
    // 200 → capped
    expect(heroComposerWidth(200)).toBe(HERO_COMPOSER_MAX_COLS)
    // 70 → 50 + 3 = 53 → floored to the status-row minimum
    expect(heroComposerWidth(70)).toBe(HERO_COMPOSER_MIN_COLS)
  })

  test('the floor keeps the card wide enough for its status row', () => {
    // Chip + gap + "Model: not set" ≈ 40 columns of CONTENT inside the border.
    expect(HERO_COMPOSER_MIN_COLS - 4).toBeGreaterThanOrEqual(48)
  })

  test('degrades to the usable width on tiny terminals without going negative', () => {
    // usable = width − 2·clearance; below the floor the card fills what is left.
    expect(heroComposerWidth(30)).toBe(30 - HERO_COMPOSER_SIDE_CLEARANCE * 2)
    expect(heroComposerWidth(8)).toBe(4)
    expect(heroComposerWidth(2)).toBe(1)
    expect(heroComposerLeft(2)).toBe(1)
  })

  test('is centered: the left column mirrors the right margin', () => {
    for (const width of [60, 80, 100, 121]) {
      const card = heroComposerWidth(width)
      const left = heroComposerLeft(width)
      const rightMargin = width - (left + card - 1)
      expect(Math.abs(left - 1 - rightMargin)).toBeLessThanOrEqual(1)
    }
  })

  test('anchors the input caret INSIDE the card (row and column band)', () => {
    // The hardware cursor is placed at the card's first content cell:
    // row = composerTopRow + 1 (past the round border), col = cardLeft + 2
    // (past the border + paddingX). It must be inside the painted box.
    const board = { ...BASE, boxH: 5, brandLines: 5 }
    const l = heroLayout(board)
    const caretRow = l.composerTopRow + 1
    expect(caretRow).toBeGreaterThan(l.composerTopRow)
    expect(caretRow).toBeLessThanOrEqual(l.composerBottomRow)
    for (const width of [60, 80, 110, 200]) {
      const left = heroComposerLeft(width)
      const caretCol = left + 2
      expect(caretCol).toBeGreaterThan(left)
      expect(caretCol).toBeLessThanOrEqual(left + heroComposerWidth(width) - 1)
    }
  })
})

describe('hero composer input height (web-parity two-row box)', () => {
  test('the hero box is one row taller than the docked minimum, i.e. 2 input rows', () => {
    expect(HERO_COMPOSER_EXTRA_ROWS).toBe(1)
    expect(HERO_COMPOSER_INPUT_ROWS).toBe(2)
    // composerHeight(min) = min + wrapped − 1 and textArea = height − 4, so a
    // min of 5 gives 1 input row and 5 + EXTRA gives exactly 2.
    expect(5 + HERO_COMPOSER_EXTRA_ROWS - 4).toBe(HERO_COMPOSER_INPUT_ROWS)
  })

  test('the extra row is inside the card the caret uses', () => {
    const l = heroLayout({ ...BASE, boxH: 5 + HERO_COMPOSER_EXTRA_ROWS })
    expect(l.composerBottomRow - l.composerTopRow + 1).toBe(5 + HERO_COMPOSER_EXTRA_ROWS)
  })
})

describe('size gates and hero copy', () => {
  test('wordmark only when the terminal is comfortably large', () => {
    expect(heroWordmarkFits(30, 100)).toBe(true)
    expect(heroWordmarkFits(20, 100)).toBe(false)
    expect(heroWordmarkFits(30, 70)).toBe(false)
  })

  test('the hero draws NO hint line: hintLines 0 keeps the palette math honest', () => {
    // The hint line under the card was removed (user call): the hero passes
    // hintLines 0, so nothing below the card but the palette lift.
    const noHint = heroLayout({ ...BASE, hintLines: 0 })
    expect(noHint.paletteBottomMargin).toBe(noHint.bottomSpacer)
    expect(noHint.stackRows).toBe(BASE.brandLines + HERO_TITLE_CARD_GAP + BASE.boxH)
  })

  test('headline is web\'s EN hero.headline, with the zh twin kept', () => {
    expect(HERO_TITLE).toBe('Into the Unknown')
    expect(HERO_TITLE).toBe(HERO_TITLE_EN)
    expect(HERO_TITLE_EN).toBe('Into the Unknown')
    expect(HERO_TITLE_ZH).toBe('探索未至之境')
    expect(visualWidth(HERO_TITLE)).toBe(HERO_TITLE.length) // ASCII: centers exactly
  })

  test('placeholder is web\'s hero copy, verbatim and static', () => {
    expect(HERO_PLACEHOLDER).toBe('Describe what you want to build... / commands, @ files or sessions')
    expect(visualWidth(HERO_PLACEHOLDER)).toBe(HERO_PLACEHOLDER.length)
  })
})
