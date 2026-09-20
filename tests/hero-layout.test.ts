/**
 * Tests for the centered HERO layout math (web parity): the composer card is a
 * centered, NARROW column inside the hero stack, and the renderer + pointer
 * geometry mirrors both read these numbers, so the invariants here are what
 * keeps routing aligned with what is painted.
 *
 * Run with `bun test tests/hero-layout.test.ts`.
 *
 * @module qialike/hero-layout-test
 */

import { describe, expect, test } from 'bun:test'
import {
  HERO_AREA_PADDING_Y,
  HERO_ART_MIN_WIDTH,
  HERO_CAPTION_URL,
  HERO_COMPOSER_EXTRA_ROWS,
  HERO_COMPOSER_MAX_COLS,
  HERO_COMPOSER_MIN_COLS,
  HERO_COMPOSER_SIDE_CLEARANCE,
  HERO_TITLE,
  HERO_TITLE_EN,
  HERO_TITLE_ZH,
  HERO_COMPOSER_INPUT_ROWS,
  HERO_PLACEHOLDER,
  HERO_HINT_ICON,
  HERO_HINT_LABEL,
  HERO_HINT_LABEL_GAP,
  HERO_MIN_ROWS,
  HERO_STATUS_BAR_HEIGHT,
  HERO_WORDMARK,
  heroAreaRows,
  heroBudget,
  heroComposerLeft,
  heroComposerWidth,
  heroHintRows,
  heroMinRows,
  heroStackRows,
  heroTooSmallLines,
  HERO_TITLE_CARD_GAP,
  heroLayout,
  paletteBoxRows,
  paletteContentRows,
  paletteWindow,
  heroPaletteBottomRow,
  heroPaletteLimitRows,
  PALETTE_DOCKED_GAP,
  heroHintLine,
  heroHintText,
  heroWordmarkFits,
} from '../packages/qialike-app/src/hero-layout.ts'
import { visualWidth } from '../packages/qialike-app/src/markdown.tsx'
import { COMPOSER_MIN_HEIGHT } from '../packages/qialike-app/src/layout-budget.ts'

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

describe('hero budget (the card cannot outgrow the area)', () => {
  const MIN_BOX = 5 // COMPOSER_MIN_HEIGHT: chrome + one input row
  const budgetFor = (rows: number, brandLines = 1, hintLines = 1) =>
    heroBudget({ rows, brandLines, hintLines, minBoxH: MIN_BOX, prefMaxBoxH: rows - 8 })

  test('the invariant holds for EVERY terminal height (the old cap broke it)', () => {
    // This is the sweep the old code had no guard for: its cap ended in
    // `Math.max(min, …)`, which re-raised the bound above the area on short
    // terminals. Measured on the real binary at 133 columns: the hero caret sat
    // one row BELOW the draft on rows 8/9/10/11, with the card's bottom edge and
    // the tip row clipped at 8/10.
    for (let rows = 3; rows <= 60; rows++) {
      for (const brandLines of [0, 1, 6, 7]) {
        for (const hintLines of [0, 1, 2]) {
          const b = budgetFor(rows, brandLines, hintLines)
          if (!b.fits) continue
          const l = heroLayout({ rows, boxH: b.boxH, brandLines: b.brandLines, titleGap: b.titleGap, hintLines: b.hintLines })
          expect(l.areaRows, `rows=${rows}`).toBe(b.areaRows)
          expect(l.stackRows, `rows=${rows} brand=${brandLines} hint=${hintLines}`).toBe(b.stackRows)
          expect(l.stackRows, `rows=${rows} brand=${brandLines} hint=${hintLines}`).toBeLessThanOrEqual(b.areaRows)
          expect(b.free, `rows=${rows}`).toBeGreaterThanOrEqual(0)
          // The paint and the model must agree on where the card ends, too: the
          // palette lift is derived from the same numbers.
          expect(l.paletteBottomMargin).toBe(
            (b.hintLines > 0 ? 1 + b.hintLines : 0) + l.bottomSpacer,
          )
        }
      }
    }
  })

  test('the hero is ALL OR NOTHING: nothing is dropped, it just is not drawn', () => {
    // User call (2026-09-13): the minimum hero height is 14 rows — the smallest
    // window where the COMPLETE hero fits (brand block + title gap + the
    // two-line card + the tip row = 11 content rows + 2 padding rows). Below it
    // the app says the terminal is too small instead of drawing a mutilated
    // hero, so there is no degradation chain left to keep in sync with the paint.
    const at = (rows: number) => heroBudget({ rows, brandLines: 1, hintLines: 1, minBoxH: MIN_BOX, prefMaxBoxH: rows - 8 })
    expect(HERO_MIN_ROWS).toBe(14)
    for (const rows of [14, 15, 16, 20, 24, 37]) {
      const b = at(rows)
      expect(b.fits, `rows=${rows}`).toBe(true)
      expect(b.hintLines, `rows=${rows}: the tip row survives`).toBe(1)
      expect(b.brandLines, `rows=${rows}: the brand block survives`).toBe(1)
      expect(b.titleGap, `rows=${rows}: the title gap survives`).toBe(HERO_TITLE_CARD_GAP)
      expect(b.stackRows).toBeLessThanOrEqual(b.areaRows)
    }
    // The smallest drawn hero really is the complete one.
    const min = at(HERO_MIN_ROWS)
    expect(min.stackRows).toBe(1 + HERO_TITLE_CARD_GAP + min.boxH + 1 + 1)
    // ...and it carries the hero's two input rows (the card cap reaches 6).
    expect(min.boxH).toBe(6)
    // One row below the minimum nothing is drawn at all.
    for (const rows of [13, 12, 11, 10, 8, 7, 6, 5, 3]) {
      expect(at(rows).fits, `rows=${rows}`).toBe(false)
    }
  })

  test('below the minimum height the notice takes over', () => {
    const at = (rows: number) => heroBudget({ rows, brandLines: 1, hintLines: 1, minBoxH: MIN_BOX, prefMaxBoxH: rows - 8 })
    // The notice names the real number (derived, so it cannot go stale).
    expect(heroMinRows(MIN_BOX)).toBe(HERO_MIN_ROWS)
    expect(heroTooSmallLines(MIN_BOX)).toEqual(['Terminal too small — keys paused', 'resize to at least 14 rows'])
    expect(heroTooSmallLines(MIN_BOX)[1]).toContain(String(heroMinRows(MIN_BOX)))
    expect(at(13).fits).toBe(false)
    expect(at(HERO_MIN_ROWS).fits).toBe(true)
    // `heroMinRows` also honours a card minimum that would need MORE than the
    // product minimum (the belt that keeps the invariant unconditional).
    expect(heroMinRows(20)).toBe(22)
    // `heroAreaRows` tells the truth on a tiny window (the old floor claimed 6).
    expect(heroAreaRows(12)).toBe(10)
    expect(heroAreaRows(7)).toBe(5)
    expect(heroAreaRows(4)).toBe(2)
    expect(heroAreaRows(2)).toBe(0)
  })

  test('an over-tall brand block is refused instead of overflowing (belt ②)', () => {
    // The art is only drawn from 23 rows up, so this cannot happen today — but
    // the arithmetic clause is what keeps `stackRows <= areaRows` true even if a
    // future gate let a 7-row brand block into a 15-row window.
    const b = heroBudget({ rows: 15, brandLines: 7, hintLines: 1, minBoxH: MIN_BOX, prefMaxBoxH: 7 })
    expect(b.fits).toBe(false)
    const ok = heroBudget({ rows: 23, brandLines: 7, hintLines: 2, minBoxH: MIN_BOX, prefMaxBoxH: 15 })
    expect(ok.fits).toBe(true)
    expect(ok.stackRows).toBeLessThanOrEqual(ok.areaRows)
  })

  test('heroStackRows is the single formula the layout uses', () => {
    const boxH = 6
    const brandLines = 7
    // Two hint rows cost ONE gap plus two lines — the paint must not give each
    // row its own gap box (that made the paint 1 row taller than the model).
    expect(heroStackRows({ brandLines, boxH, hintLines: 2 })).toBe(brandLines + HERO_TITLE_CARD_GAP + boxH + 1 + 2)
    expect(heroStackRows({ brandLines, boxH, hintLines: 0 })).toBe(brandLines + HERO_TITLE_CARD_GAP + boxH)
    expect(heroStackRows({ brandLines, boxH, hintLines: 1, titleGap: 0 })).toBe(brandLines + boxH + 1 + 1)
    const l = heroLayout({ rows: 37, boxH, brandLines, hintLines: 2 })
    expect(l.stackRows).toBe(heroStackRows({ brandLines, boxH, hintLines: 2 }))
    expect(l.paletteBottomMargin).toBe(1 + 2 + l.bottomSpacer)
  })

  test('the row count under the card is one pure function (0/1/2)', () => {
    expect(heroHintRows(false, undefined)).toBe(0)
    expect(heroHintRows(false, true)).toBe(1)
    expect(heroHintRows(false, false)).toBe(1)
    expect(heroHintRows(true, undefined)).toBe(1)
    expect(heroHintRows(true, true)).toBe(2)
    expect(heroHintRows(true, false)).toBe(2)
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

  test('with NO hint rows the palette lift is just the bottom spacer', () => {
    // The hero line under the card exists again (83c92aa), but the layout must
    // still handle hintLines 0 — an unsettled provider probe, or the budget
    // dropping the row on a short terminal. Then nothing sits below the card but
    // the palette lift, and the stack shrinks by the whole hint block.
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

  test('placeholder names both affordances (commands + file refs), and is static', () => {
    expect(HERO_PLACEHOLDER).toBe('Describe what you want to build...  / commands, @ files')
    expect(visualWidth(HERO_PLACEHOLDER)).toBe(HERO_PLACEHOLDER.length)
    expect(HERO_PLACEHOLDER).toMatch(/\/ commands, @ files$/)
    expect(HERO_PLACEHOLDER, 'the prompt sentence stays the leading, greppable prefix')
      .toMatch(/^Describe what you want to build/)
  })

  test('the caption under the brand mark is the project site, not the version', () => {
    expect(HERO_CAPTION_URL).toBe('qialike.com')
    // ASCII-only, so it centers exactly (no East-Asian-Ambiguous glyph drift).
    expect(visualWidth(HERO_CAPTION_URL)).toBe(HERO_CAPTION_URL.length)
    // And it must survive every width the brand mark itself is drawn at: the
    // caption is painted under the mark, so the mark's own floor is the widest
    // the caption can ever be asked to fit.
    expect(visualWidth(HERO_CAPTION_URL)).toBeLessThanOrEqual(HERO_ART_MIN_WIDTH)
  })
})

describe('hero hint line (under the card)', () => {
  test('points at /models with no provider, at /sessions once one is ready', () => {
    expect(heroHintLine(undefined), 'unknown -> no line (no wrong-instruction flash)').toBeUndefined()
    expect(heroHintLine(false)).toBe('No provider yet — use /models to add one')
    expect(heroHintLine(true)).toBe('Use /sessions to restore a historical session')
  })

  test('the layout model reserves the row it will be painted in', () => {
    // The caret/click/palette math all read this model, so the hint row must be
    // counted there with the same gap the paint uses (HERO_GAP + 1 row).
    const base = heroLayout({ rows: 37, boxH: 6, brandLines: 7, hintLines: 0 })
    const withHint = heroLayout({ rows: 37, boxH: 6, brandLines: 7, hintLines: 1 })
    // The stack grows by the gap + the line...
    expect(withHint.stackRows - base.stackRows).toBe(2)
    // ...while the palette margin grows by 1: the extra rows also shrink the
    // centering spacers, so the card ends up one row higher and the net
    // distance from the card's bottom to the area's bottom grows by one.
    expect(withHint.paletteBottomMargin - base.paletteBottomMargin).toBe(1)
    expect(base.composerTopRow - withHint.composerTopRow).toBe(1)
  })

  test('identifies the command to type', () => {
    for (const line of [heroHintLine(false)!, heroHintLine(true)!]) {
      expect(line).toMatch(/\/(models|sessions)/)
    }
  })

  test('the painted line opens with the eye-catching icon + Tip label', () => {
    expect(heroHintText(undefined)).toBeUndefined()
    for (const ready of [false, true] as const) {
      const full = heroHintText(ready)!
      expect(full.startsWith(`${HERO_HINT_ICON} ${HERO_HINT_LABEL}`), 'icon+label lead the line').toBe(true)
      // Exactly the three parts the panel paints, in order: the colored
      // icon/label `<Text>`, its gap, then the muted sentence.
      expect(full).toBe(
        `${HERO_HINT_ICON} ${HERO_HINT_LABEL}${' '.repeat(HERO_HINT_LABEL_GAP)}${heroHintLine(ready)}`,
      )
      expect(full.endsWith(heroHintLine(ready)!)).toBe(true)
    }
    // The sentence itself is unchanged — the probes and the `/sessions` hint
    // substring assertions keep working.
    expect(heroHintText(true)).toContain('Use /sessions to restore a historical session')
  })

  test('the icon is measured two columns wide, so the centered row stays centered', () => {
    // U+1F4A1 is Extended_Pictographic: every width table (and the terminal)
    // advances it two columns. If it were ambiguous-width the pad computed from
    // `heroHintText` would disagree with the paint by one column.
    expect(visualWidth(HERO_HINT_ICON)).toBe(2)
    for (const ready of [false, true] as const) {
      const full = heroHintText(ready)!
      expect(visualWidth(full)).toBe(
        visualWidth(HERO_HINT_ICON) + 1 + HERO_HINT_LABEL.length + HERO_HINT_LABEL_GAP + heroHintLine(ready)!.length,
      )
    }
  })

  test('the prefixed line still fits the widest card untruncated', () => {
    // WIDEST card (76 cols → 72 usable): the whole tip must fit, icon included.
    const widest = heroComposerWidth(200) - 4
    for (const ready of [false, true] as const) {
      expect(visualWidth(heroHintText(ready)!)).toBeLessThanOrEqual(widest)
    }
  })
})

describe('the command palette box (paletteBoxRows)', () => {
  const CARD_TOP = 23

  test('docked: the box bottom clears the card by the documented gap', () => {
    const box = paletteBoxRows({ hero: false, count: 14, bandTop: CARD_TOP })
    expect(box.last).toBe(CARD_TOP - PALETTE_DOCKED_GAP)
    // Bordered box: count content rows between the two borders.
    expect(box.last - box.first + 1).toBe(14 + 2)
    // The content rows are exactly the ones the mouse mapping always used
    // (`bandTop − n − 3` first), so pointer routing is unchanged in this view.
    expect(box.first + 1).toBe(CARD_TOP - 14 - 3)
  })

  test('hero: the box bottom is the area bottom minus the render lift', () => {
    const l = heroLayout(BASE)
    const box = paletteBoxRows({
      hero: true, count: 14, rows: BASE.rows, heroLift: l.paletteBottomMargin,
    })
    // MEASURED against the painted screen (see `paletteBoxRows`): the overlay's
    // coordinate space is the padded AREA starting at screen row 1, so the box
    // bottom is `areaRows − lift` — NOT `rows − padding − lift`, which was one row
    // low on every size probed.
    expect(box.last).toBe(heroAreaRows(BASE.rows) - l.paletteBottomMargin)
    expect(box.last - box.first + 1).toBe(14 + 2)
  })

  test('no commands means nothing is painted (empty range)', () => {
    const box = paletteBoxRows({ hero: true, count: 0, rows: BASE.rows, heroLift: 0 })
    expect(box.last).toBeLessThan(box.first)
  })

  /**
   * The reported regression: the popup is bottom-anchored and grows UPWARD, so a
   * WIDE list covers the input row (caret hidden — the block caret must not blink
   * through the popup) while a NARROW list sits across the card's lower rows and
   * leaves the input row visible. The caret's visibility is decided from this
   * overlap, so a narrow list must NOT report coverage.
   */
  test('a narrow hero list does not cover the input row; a wide one does', () => {
    // The REAL hero card height: `composerMinHeight()` is COMPOSER_MIN_HEIGHT (5)
    // plus HERO_COMPOSER_EXTRA_ROWS — the two-row hero input box. Using BASE's
    // 5-row card here moved the card one row and inverted this boundary, which is
    // why the fixture height is asserted rather than assumed.
    const boxH = COMPOSER_MIN_HEIGHT + HERO_COMPOSER_EXTRA_ROWS
    expect(boxH).toBe(6)
    const l = heroLayout({ ...BASE, boxH })
    const caretRow = l.composerTopRow + 1 // the card's first content (input) row
    const covers = (count: number): boolean => {
      const box = paletteBoxRows({
        hero: true, count, rows: BASE.rows, heroLift: l.paletteBottomMargin,
      })
      return caretRow >= box.first && caretRow <= box.last
    }
    // One match + no footer: the box sits BELOW the input row, so the caret stays
    // visible — measured on the real binary (`/help` → `visible=True`).
    expect(covers(1)).toBe(false)
    // Two content rows already grow the top border up onto the input row.
    expect(covers(2)).toBe(true)
    expect(covers(14)).toBe(true)
    // The hider must never claim coverage the paint cannot back: the input row is
    // inside the card, which the popup can only reach by growing up from its own
    // anchored bottom.
    expect(l.composerTopRow).toBeLessThanOrEqual(l.composerBottomRow)
  })
})

describe('the palette window (paletteWindow / paletteContentRows)', () => {
  test('every match is shown when the list fits the cap', () => {
    const w = paletteWindow(3, 0, 8)
    expect(w).toEqual({ first: 0, visible: 3, hidden: 0 })
    expect(paletteContentRows(w.visible, w.hidden)).toBe(3)
  })

  test('a list longer than the window is sliced and reports its remainder', () => {
    // A window size, not a cap: these cases exercise `paletteWindow`/`paletteContentRows`
    // arithmetic, and any limit does. (The hero's own limit follows the list size —
    // see the case below.)
    const window = 14
    const w = paletteWindow(30, 0, window)
    expect(w.first).toBe(0)
    expect(w.visible).toBe(window)
    expect(w.hidden).toBe(30 - window)
    // The footer row that reports the remainder is part of the box.
    expect(paletteContentRows(w.visible, w.hidden)).toBe(window + 1)
  })

  test('the hero cap is the whole command list — there is no fixed cap', () => {
    // User call: the hero must show every command again. 8 rows truncated the
    // list into a `… N more` footer that bought nothing — the frame is over the
    // pty's 4095-byte instalment at 8 rows too (8232 B at 120×30), and the
    // synchronized-output envelope is what actually prevents the visible tear.
    //
    // A constant used to live here, kept equal to the command count, so the list
    // painted whole only until somebody added a command: `/upgrade` made it 15 and
    // pushed a row into the footer. The cap follows the list now, whatever it is.
    const tall = heroLayout({ ...BASE, rows: 37 })
    for (const count of [14, 15, 20, 40]) {
      const limit = heroPaletteLimitRows(37, tall.paletteBottomMargin, count)
      const w = paletteWindow(count, 0, limit)
      // Room allows these, so the whole list must paint with no footer row.
      if (limit === count) {
        expect(w, `count=${count}`).toEqual({ first: 0, visible: count, hidden: 0 })
        expect(paletteContentRows(w.visible, w.hidden), `count=${count} no footer`).toBe(count)
      }
    }
    // 15 is the live command count; at a normal height it paints whole.
    expect(heroPaletteLimitRows(37, tall.paletteBottomMargin, 15)).toBe(15)
  })

  test('the window slides only as far as the selection requires', () => {
    const max = 14
    const count = 30
    // Inside the window: it must not move (the list cannot jump under the user).
    for (let i = 0; i < max; i++) expect(paletteWindow(count, i, max).first).toBe(0)
    // Past the bottom edge it follows, one row at a time, and stops at the end.
    expect(paletteWindow(count, max, max).first).toBe(1)
    expect(paletteWindow(count, max + 2, max).first).toBe(3)
    expect(paletteWindow(count, count - 1, max).first).toBe(count - max)
    // An out-of-range index WRAPS (the store's selection cycles), so the window
    // follows the wrapped row instead of running off the end.
    expect(paletteWindow(count, 99, max).first).toBe(paletteWindow(count, 99 % count, max).first)
  })

  test('the selected row is always inside the painted window', () => {
    const max = 5
    for (let count = 1; count <= 20; count++) {
      for (let i = -3; i <= count + 3; i++) {
        const w = paletteWindow(count, i, max)
        const sel = ((i % count) + count) % count
        expect(sel, `count=${count} i=${i}`).toBeGreaterThanOrEqual(w.first)
        expect(sel, `count=${count} i=${i}`).toBeLessThan(w.first + w.visible)
        expect(w.first + w.visible, 'never past the end').toBeLessThanOrEqual(count)
      }
    }
  })

  test('an empty match list paints nothing', () => {
    expect(paletteWindow(0, 0, 8)).toEqual({ first: 0, visible: 0, hidden: 0 })
    expect(paletteContentRows(0, 0)).toBe(0)
  })

  test('the docked popup is uncapped (cap = count), so nothing is hidden', () => {
    const w = paletteWindow(14, 13, 14)
    expect(w).toEqual({ first: 0, visible: 14, hidden: 0 })
    expect(paletteContentRows(w.visible, w.hidden)).toBe(14)
  })

  /**
   * The hero popup is bottom-anchored and grows UPWARD, so a long list can push
   * its own top border off screen on a short hero. The limit is what keeps every
   * painted row on the terminal — and, since the cap is the LIST SIZE, what makes
   * the whole palette safe at any list length.
   */
  test('the hero limit keeps the top border on screen at every height', () => {
    const LIST = 20
    for (let rows = 8; rows <= 60; rows++) {
      const l = heroLayout({ ...BASE, rows })
      const limit = heroPaletteLimitRows(rows, l.paletteBottomMargin, LIST)
      // A full list is shown whenever it fits above the anchored bottom…
      expect(limit, `rows=${rows}`).toBeLessThanOrEqual(LIST)
      expect(limit, `rows=${rows}`).toBeGreaterThanOrEqual(1)
      // …and the resulting box never starts above row 1 (both borders included).
      const w = paletteWindow(LIST, 0, limit)
      const box = paletteBoxRows({
        hero: true,
        count: paletteContentRows(w.visible, w.hidden),
        rows,
        heroLift: l.paletteBottomMargin,
      })
      expect(box.first, `rows=${rows} box=${box.first}..${box.last}`).toBeGreaterThanOrEqual(1)
      expect(box.last, `rows=${rows}`).toBe(heroPaletteBottomRow(rows, l.paletteBottomMargin))
    }
    // …so a tall terminal shows the whole list and a short one degrades instead of
    // clipping (pty-measured: 15 commands from 24 rows up, 9 at 133×20).
    const tall = heroLayout({ ...BASE, rows: 37 })
    expect(heroPaletteLimitRows(37, tall.paletteBottomMargin, 15)).toBe(15)
    const short = heroLayout({ ...BASE, rows: 18 })
    expect(heroPaletteLimitRows(18, short.paletteBottomMargin, 15)).toBeLessThan(15)
  })
})
