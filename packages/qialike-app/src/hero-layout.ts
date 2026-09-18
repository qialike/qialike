/**
 * Blank-session HERO layout math (web/opencode parity): the hero stack is
 * CENTERED vertically and INCLUDES the composer — the same composer card that
 * docks at the bottom in the conversation phase sits mid-screen while the
 * session is blank (web: EmptyHero + centered InputBar; opencode: home route
 * with a centered prompt).
 *
 * Pure so the renderer and every pointer/geometry mirror share ONE source of
 * truth: the renderer emits exactly `topSpacer` rows before the brand block and
 * `bottomSpacer` rows after the hints, and `composerTopRow` is derived from the
 * same numbers — routing can therefore never disagree with what is painted.
 *
 * @module @yourname/qialike-app/hero-layout
 */

import {
  HERO_ART_WORDMARK_COLS,
  HERO_ART_WORDMARK_ROWS,
  HERO_ART_WORDMARK_TONES,
} from './hero-art.ts'
import { STATUS_BAR_HEIGHT, tooSmallNoticeLines } from './layout-budget.ts'

/** Composer box border rows included in `boxH` (round border top+bottom). */
export const HERO_GAP = 1
/** The DOCKED status bar's row count, re-exported from the single source
 *  ({@link STATUS_BAR_HEIGHT} in `layout-budget.ts`). The hero reserves no
 *  status rows at all — it is chrome-free — so this is kept only for
 *  documentation/tests of the docked geometry. */
export const HERO_STATUS_BAR_HEIGHT = STATUS_BAR_HEIGHT
/** The padded hero area's top/bottom padding rows (paddingY={1}). */
export const HERO_AREA_PADDING_Y = 1

/**
 * The FALLBACK "qialike" wordmark in plain ASCII (5 rows, 27 columns wide).
 * Plain `#` is deliberate: it renders single-width on every terminal, so it is
 * what the hero falls back to when the real brand art (see
 * `HERO_ART_WORDMARK_TONES`) cannot be trusted — narrow terminals, or a
 * terminal that measures the half-block glyph as two columns wide.
 */
const WORDMARK_GLYPHS: Record<string, readonly string[]> = {
  a: ['###', '  #', '###', '# #', '###'],
  e: ['###', '# #', '###', '#  ', '###'],
  i: ['###', ' # ', ' # ', ' # ', '###'],
  k: ['#  ', '# #', '## ', '# #', '# #'],
  l: ['#  ', '#  ', '#  ', '#  ', '###'],
  q: ['###', '# #', '# #', '###', '  #'],
}

/** The rendered wordmark lines (one per row) — the ASCII fallback mark. */
export const HERO_WORDMARK: readonly string[] = (() => {
  const lines = ['', '', '', '', '']
  const word = 'qialike'
  for (let i = 0; i < word.length; i++) {
    const glyph = WORDMARK_GLYPHS[word[i]!]!
    for (let r = 0; r < lines.length; r++) lines[r] += (i > 0 ? ' ' : '') + glyph[r]
  }
  return lines
})()

/** Hero headline — web `conversation` `hero.headline`, verbatim. The hero
 *  uses the EN string ({@link HERO_TITLE}); the zh twin is kept for a one-line
 *  switch back. */
export const HERO_TITLE_ZH = '探索未至之境'
export const HERO_TITLE_EN = 'Into the Unknown'

/** The headline the hero actually draws. */
export const HERO_TITLE = HERO_TITLE_EN

/**
 * The caption line UNDER the brand mark (user call, 2026-09-13). It used to be
 * the qialike VERSION; it is now the project's site — the version keeps its
 * actionable homes (the docked sidebar footer and `--version`), so the hero
 * reads as a brand plate instead of a build stamp. 11 columns wide, so it
 * survives every width the brand mark itself is drawn at (the mark's floor is
 * {@link HERO_ART_MIN_WIDTH} = 52 columns).
 */
export const HERO_CAPTION_URL = 'qialike.com'

/** Rows between the title (end of the brand block) and the composer card when
 *  nothing sits in between (the hero draws no workspace line). */
export const HERO_TITLE_CARD_GAP = 2

/** Input rows the heroic composer keeps at minimum: the hero card is a proper
 *  two-line input box (web's composer is a multi-line textarea), while the
 *  docked card stays one row tall to keep the transcript viewport. */
export const HERO_COMPOSER_INPUT_ROWS = 2

/** Extra box rows that buys: `composerHeight` min is 4 chrome rows + 1 input
 *  row (`textArea = composerH − 4`), so one more input row is +1 box row. */
export const HERO_COMPOSER_EXTRA_ROWS = HERO_COMPOSER_INPUT_ROWS - 1

/** Placeholder of the empty hero composer (user call): web `conversation`
 *  `placeholder.hero` cut down to the two affordances the hero actually offers
 *  — `/` for commands and `@` for file references — separated from the prompt
 *  sentence by a double space so the eye reads them as a key legend. The zh twin
 *  is '描述你想要构建的内容… / 调用指令 @ 文件'. */
export const HERO_PLACEHOLDER = 'Describe what you want to build...  / commands, @ files'

/** Terminal columns the centered composer card keeps clear on each side. */
export const HERO_COMPOSER_SIDE_CLEARANCE = 2
/** Narrowest heroic composer card: the width at which the card still keeps its
 *  permission chip and `Model:` label on ONE status row (the card fills the
 *  window below this, exactly like web's `width:100%` + `max-width`). */
export const HERO_COMPOSER_MIN_COLS = 56
/** Widest heroic composer card (readable line length / web's 920px cap). */
export const HERO_COMPOSER_MAX_COLS = 76
/** Share of the window the card may take on mid-size terminals (web: 64% of
 *  the column, plus the card's own chrome). */
export const HERO_COMPOSER_WIDTH_RATIO = 0.72
/** Columns the card's own chrome costs (round border 2 + a little air): web's
 *  card is content width + 32px. */
export const HERO_COMPOSER_CHROME_COLS = 3

/**
 * Width of the heroic composer card at `width`: web parity — `width: 100%` up
 * to a `max-width`, so the card is a CENTERED column that never spans the whole
 * window on a normal terminal (web `--dsh-composer-card-max-width` =
 * clamp(680px, 64% of the column, 920px) + 32px of chrome). Mapped to terminal
 * columns: {@link HERO_COMPOSER_WIDTH_RATIO} of the window plus
 * {@link HERO_COMPOSER_CHROME_COLS}, floored at {@link HERO_COMPOSER_MIN_COLS}
 * and capped at {@link HERO_COMPOSER_MAX_COLS}.
 * @param width - terminal columns.
 * @returns the card's outer width in columns (≥1, always inside the window).
 */
export function heroComposerWidth(width: number): number {
  const usable = Math.max(1, width - HERO_COMPOSER_SIDE_CLEARANCE * 2)
  const proportional = Math.round(Math.max(0, width) * HERO_COMPOSER_WIDTH_RATIO) + HERO_COMPOSER_CHROME_COLS
  const wanted = Math.max(HERO_COMPOSER_MIN_COLS, Math.min(proportional, HERO_COMPOSER_MAX_COLS))
  return Math.max(1, Math.min(usable, wanted))
}

/** 1-based first column of the centered heroic composer card. */
export function heroComposerLeft(width: number): number {
  return Math.max(1, Math.floor((width - heroComposerWidth(width)) / 2) + 1)
}

/** Inputs of {@link heroLayout}. */
export interface HeroLayoutInput {
  /** Terminal rows. */
  rows: number
  /** Composer box height in rows (borders and image chip included). */
  boxH: number
  /** Brand block rows: wordmark lines + the title line (0 when the terminal is
   *  too small for the wordmark and only the title is drawn). */
  brandLines: number
  /** Hint rows under the composer (the hero now passes 0: no hint line). */
  hintLines: number
  /** Rows between the brand block and the card (default
   *  {@link HERO_TITLE_CARD_GAP}; {@link heroBudget} drops it to 0 on a
   *  terminal too short for it). */
  titleGap?: number
  /** Rows of extra context above the composer (default 0: the hero shows no
   *  workspace line — the footer/status bar carries that information). */
  contextLines?: number
  /** Footer rows pinned at the bottom of the hero area (default 0: the hero
   *  draws no footer; the status bar already shows version/model). */
  footerLines?: number
}

/** Resolved hero geometry (all rows 1-based terminal rows). */
export interface HeroLayout {
  /** Rows emitted before the brand block. */
  topSpacer: number
  /** Rows emitted after the hints (before the footer). */
  bottomSpacer: number
  /** total rows of brand + context + composer + hints. */
  stackRows: number
  /** First border row of the centered composer card. */
  composerTopRow: number
  /** Last border row of the centered composer card. */
  composerBottomRow: number
  /** Rows between the BOTTOM of the hero area and the command popup's bottom
   *  edge: the popup is bottom-anchored, so this is the lift the render hands to
   *  `renderPalette` and the popup grows UPWARD from there. `hintBlock +
   *  bottomSpacer + footerLines` clears everything BELOW the card, which parks
   *  the popup's bottom just above the card's own last row — i.e. lifted ONTO the
   *  card, covering its lower rows (that overlap is what lets a full 14-command
   *  list fit above an already-tall hero stack). The popup's actual row range
   *  comes from {@link paletteBoxRows}, never from this number alone. */
  paletteBottomMargin: number
  /** Content rows available inside the padded hero area. */
  areaRows: number
}

/**
 * Content rows available inside the padded hero area at `rows`.
 *
 * NO floor above the real number: the old `Math.max(6, …)` modelled six rows on
 * a seven-row terminal, i.e. rows the terminal does not have — and every
 * geometry consumer (caret, click→index, palette lift) read that model while the
 * flex layout painted the truth (measured: the hero caret sat one row BELOW the
 * draft on rows ≤ 11, and the card's bottom edge / tip row were clipped away).
 * @param rows - terminal rows.
 * @returns `max(0, rows − 2·padding)`.
 */
export function heroAreaRows(rows: number): number {
  return Math.max(0, rows - HERO_AREA_PADDING_Y * 2)
}

/** Inputs of {@link heroStackRows}. */
export interface HeroStackInput {
  /** Brand block rows the caller draws (mark rows + the title line). */
  brandLines: number
  /** Composer box height in rows. */
  boxH: number
  /** Hint rows UNDER the card (0 when the budget or the probe dropped them). */
  hintLines: number
  /** Rows between the brand block and the card (default
   *  {@link HERO_TITLE_CARD_GAP}; a short terminal drops it to 0). */
  titleGap?: number
  /** Rows of extra context above the composer (default 0). */
  contextLines?: number
}

/**
 * THE hero stack formula — the ONE place that answers "how tall is the hero".
 *
 * The layout, the card budget ({@link heroBudget}) and the tests all go through
 * it, so the model cannot be computed two ways (the previous code repeated the
 * `brand + gap + card + hintBlock` expression in the panel three times, which is
 * how the cap and the paint drifted apart).
 * @param input - see {@link HeroStackInput}.
 * @returns rows occupied by everything except the top/bottom spacers and the
 *   optional footer (whose rows are pinned at the bottom, so they are not part
 *   of the centered stack — `heroLayout` subtracts them in `free`).
 */
export function heroStackRows(input: HeroStackInput): number {
  const titleGap = input.titleGap ?? HERO_TITLE_CARD_GAP
  const contextLines = input.contextLines ?? 0
  const hintBlock = input.hintLines > 0 ? HERO_GAP + input.hintLines : 0
  const contextBlock = contextLines > 0 ? HERO_GAP + contextLines + HERO_GAP : titleGap
  return input.brandLines + contextBlock + input.boxH + hintBlock
}

/** Inputs of {@link heroBudget}. */
export interface HeroBudgetInput {
  /** Terminal rows. */
  rows: number
  /** Brand block rows the caller would like to draw (mark rows + title). */
  brandLines: number
  /** Hint rows the caller would like to draw (0 = probe not settled). */
  hintLines: number
  /** Smallest VIABLE card: chrome + one input row (`COMPOSER_MIN_HEIGHT`). */
  minBoxH: number
  /** Preferred upper bound from the caller (the shared `rows − 8` growth rule);
   *  a hard budget below it always wins. */
  prefMaxBoxH?: number
}

/** The resolved hero row budget — every number the paint and the caret share. */
export interface HeroBudget {
  areaRows: number
  /** Brand rows to paint (the requested count: nothing is dropped below the
   *  product minimum, the hero simply is not drawn). */
  brandLines: number
  /** Rows between the brand block and the card. */
  titleGap: number
  /** Hint rows to paint (the requested count). */
  hintLines: number
  /** Card height cap for `composerHeight`. */
  boxH: number
  stackRows: number
  /** `areaRows − stackRows`; never negative while {@link HeroBudget.fits}. */
  free: number
  /** False below {@link HERO_MIN_ROWS} (or if the stack cannot fit the area):
   *  the stack has no honest position, so the caller must paint
   *  {@link heroTooSmallLines} instead of the hero. */
  fits: boolean
}

/**
 * Resolve the hero's rows for a terminal of `rows` rows.
 *
 * Why this exists: the card's height cap used to be
 * `Math.max(min, Math.min(rows − 8, area − brand − gap − hint))`, and that outer
 * `Math.max` re-raised the bound above what the area can hold — `heroLayout`'s
 * `free` went negative again, Yoga compressed the explicit gap box, and the
 * caret/click/palette model disagreed with the paint by exactly one row on short
 * terminals (measured on the REAL binary at 133 columns: drift +1 on rows
 * 8/9/10/11, card bottom edge and tip row clipped at 8/10).
 *
 * The hero is now ALL OR NOTHING (user call): it is drawn only from
 * {@link HERO_MIN_ROWS} up, i.e. only when the COMPLETE stack — brand block,
 * title gap, the two-line card and the tip row — fits the area without giving
 * anything up. Below that the caller paints {@link heroTooSmallLines} instead of
 * a mutilated hero, so there is no degradation chain left to keep in sync.
 * @param input - see {@link HeroBudgetInput}.
 * @returns the resolved budget; `free ≥ 0` whenever `fits`.
 */
export function heroBudget(input: HeroBudgetInput): HeroBudget {
  const areaRows = heroAreaRows(input.rows)
  const brandLines = Math.max(0, input.brandLines)
  const hintLines = Math.max(0, input.hintLines)
  const titleGap = HERO_TITLE_CARD_GAP
  const hintBlock = hintLines > 0 ? HERO_GAP + hintLines : 0
  // What the card may occupy at most, i.e. the hardest bound the stack can take.
  const budget = areaRows - brandLines - titleGap - hintBlock
  // Two clauses, both required:
  //  ① the product minimum — below `HERO_MIN_ROWS` the hero never mutilates
  //     itself (it would have to drop the tip row or the brand block);
  //  ② the arithmetic invariant — the card must fit what is left of the area.
  //     ② is not redundant: it is what keeps the invariant true for ANY brand
  //     height (e.g. if the art gate were ever lowered so the 6-row art had to
  //     live on a 15-row terminal), and it is the clause the old cap got wrong.
  const fits = input.rows >= HERO_MIN_ROWS && budget >= input.minBoxH
  // The `prefMaxBoxH` bound may sit below `minBoxH` near the minimum height (the
  // shared `rows − 8` rule); `minBoxH ≤ budget` holds whenever `fits`, so the
  // floor cannot push the stack past the area the way the old cap did.
  const boxH = fits
    ? Math.max(input.minBoxH, Math.min(input.prefMaxBoxH ?? budget, budget))
    : input.minBoxH
  const stackRows = heroStackRows({ brandLines, boxH, hintLines, titleGap })
  return { areaRows, brandLines, titleGap, hintLines, boxH, stackRows, free: areaRows - stackRows, fits }
}

/**
 * Fewest terminal rows the hero is drawn in — the smallest window where the
 * COMPLETE hero fits: brand block (title at least) + {@link HERO_TITLE_CARD_GAP}
 * + the two-line card + the tip row = 1 + 2 + 6 + 2 = 11 content rows, plus the
 * area's top/bottom padding. Below this the hero would have to give something up
 * (the tip row, the brand block, the second input row), which the product
 * decision of 2026-09-13 rules out: it paints
 * {@link heroTooSmallLines} instead.
 */
export const HERO_MIN_ROWS = 14

/**
 * Rows below which the hero cannot be drawn at all, for the given card minimum:
 * the product minimum {@link HERO_MIN_ROWS}, or the bare-card arithmetic if that
 * is ever larger (`minBoxH` + the area padding).
 * @param minBoxH - smallest viable card height.
 * @returns the documented minimum, derived so the notice text cannot go stale.
 */
export function heroMinRows(minBoxH: number): number {
  return Math.max(HERO_MIN_ROWS, minBoxH + HERO_AREA_PADDING_Y * 2)
}

/**
 * The one-row notice painted INSTEAD of the hero when {@link HeroBudget.fits} is
 * false. Derived from {@link heroMinRows}, so the number can never go stale.
 * @param minBoxH - smallest viable card height.
 * @returns the notice text.
 */
export function heroTooSmallLines(minBoxH: number): readonly [string, string] {
  return tooSmallNoticeLines(heroMinRows(minBoxH))
}

/**
 * Rows the DOCKED command palette leaves BELOW its box: the message column's
 * `paddingY` (1) plus the gap between the transcript and the card (2) — the
 * docked popup floats just above the card and never reaches it. The hero leaves
 * `{@link HeroLayout.paletteBottomMargin}` instead (it lifts the popup ONTO the
 * card).
 */
export const PALETTE_DOCKED_GAP = 3

/** Inputs of {@link paletteBoxRows}. */
export interface PaletteBoxInput {
  /** True while the hero is up (the popup is lifted onto the card, so its box
   *  bottom is measured from the bottom of the hero area). */
  hero: boolean
  /** Content rows painted inside the box (commands plus the hidden-remainder
   *  footer — see {@link paletteContentRows}; 0 = no popup). */
  count: number
  /** Terminal rows — required for the hero (the lift is measured from the area's
   *  bottom edge). */
  rows?: number
  /** Hero: the lift the render passes to the popup
   *  ({@link HeroLayout.paletteBottomMargin}). */
  heroLift?: number
  /** Docked: the composer card's first painted row ({@link HeroLayout.composerTopRow}). */
  bandTop?: number
}

/**
 * The row range the command palette's bordered box ACTUALLY occupies (1-based
 * terminal rows, both borders included), or an empty range when nothing is
 * painted.
 *
 * ONE source for the three consumers that must agree about the popup: the paint
 * (which passes the lift/`bandTop` in), the caret's visibility
 * (`installFrameSuffix` — the hardware caret must be hidden only when the popup
 * really covers its cell) and the mouse→row mapping
 * (`commandPaletteIndexFromRow`). Deriving them separately is exactly how the
 * caret came to be hidden while the popup was nowhere near it: the visibility
 * rule assumed "hero + palette open ⇒ the input row is covered", but the popup
 * grows UPWARD from a fixed bottom, so a NARROW palette (a few matches) stops
 * covering the input row while the caret stayed hidden.
 *
 * @param input - see {@link PaletteBoxInput}.
 * @returns the box's first/last row; `last < first` when `count` is 0.
 */
export function paletteBoxRows(input: PaletteBoxInput): { first: number; last: number } {
  // Nothing is painted without a content row: an empty range, so every
  // containment test against it is false by construction.
  if (input.count <= 0) return { first: 1, last: 0 }
  const bottom = input.hero
    // The popup is bottom-anchored inside the hero's padded AREA: Yoga positions
    // the absolute overlay against that box's own coordinate space, whose row 1
    // is screen row 1 and whose height is {@link heroAreaRows}. MEASURED against
    // the painted screen at 120x30, 100x26, 160x50, 80x24, 120x18 and 140x40 (the
    // `╭`/`╰` rows the writer actually emits): `areaRows − lift` reproduces the
    // bottom border on all six, while `rows − padding − lift` was one row LOW on
    // every one — which silently mis-mapped every palette click by a row and made
    // the caret's coverage test reason about a box that was not on screen.
    ? heroPaletteBottomRow(input.rows ?? 0, input.heroLift ?? 0)
    : (input.bandTop ?? 0) - PALETTE_DOCKED_GAP
  // A bordered box: `count` content rows between a top and a bottom border.
  return { first: bottom - input.count - 1, last: bottom }
}

/**
 * The row the hero palette's box is anchored to: the hero area's bottom edge
 * minus the lift the render hands to the popup. Shared by {@link paletteBoxRows}
 * (the painted box), {@link heroPaletteLimitRows} (how many command rows fit
 * above it) and therefore the caret's coverage test and the mouse→row mapping —
 * one expression, so the consumers cannot disagree.
 *
 * The popup is ABSOLUTE inside the hero's padded area, whose row 1 is screen row
 * 1, so this is a screen row as well.
 * @param rows - terminal rows.
 * @param heroLift - the `paddingBottom` the render hands to `renderPalette`
 *   ({@link HeroLayout.paletteBottomMargin}).
 * @returns the box's bottom border row.
 */
export function heroPaletteBottomRow(rows: number, heroLift: number): number {
  return heroAreaRows(rows) - heroLift
}

/** Command rows the HERO palette paints at most: the whole command list.
 *
 *  It used to be 8 (with a `… N more` footer), on the theory that a smaller box
 *  keeps the frame under the pty's ~4095-byte instalment. MEASURED (the frame
 *  that OPENS the palette, split by its `ESC[?2026h…l` envelope,
 *  `test/probes/hero-palette-rows.py`):
 *
 *  | terminal | 8 rows + footer | 14 rows |
 *  |---|---|---|
 *  | 80×24  | 3333 B | 4784 B |
 *  | 120×30 | 3814 B | 5465 B |
 *  | 160×50 | 4254 B | 6110 B |
 *  | 240×30 | 5134 B | 7385 B |
 *
 *  So the cap did keep the frame in one instalment at 80–120 columns and never
 *  did at 160+ (the cost is the full-WIDTH repaint, not the popup's height). The
 *  full list crosses the limit everywhere, and what makes that invisible is the
 *  synchronized-output envelope (`ESC[?2026h/l`, see `__dshFrameEnvelope` in the
 *  build), which presents a split frame as one picture. On a terminal that
 *  ignores the mode the old one-round-trip half-paint can be visible again — the
 *  accepted price of showing all 14 commands.
 *
 *  It is still CLAMPED to what fits: the popup grows upward from
 *  {@link heroPaletteBottomRow}, so on a short hero a full list would push the
 *  box's top border off screen — {@link heroPaletteLimitRows} keeps it on row 1
 *  and lets the footer report the remainder (pty-measured: 14 rows with no footer
 *  from a 24-row terminal up, 8 rows + footer at 120×18; see the `hero-palette`
 *  scenario). */
export const HERO_PALETTE_MAX_ROWS = 14

/**
 * The number of palette content rows the hero can paint without pushing the box's
 * top border off screen: the box is bottom-anchored at {@link heroPaletteBottomRow}
 * and grows upward, so it may spend `bottom − 2` content rows (the box spans
 * `[bottom − count − 1, bottom]`, both borders included). When the list is longer
 * than the window one of those rows goes to the `… N more` footer, so the window
 * shrinks by one; shrinking can only make the list "still too long", so the
 * decision cannot oscillate. Never below 1, so a hero with no room still paints
 * one command row plus the footer.
 * @param rows - terminal rows.
 * @param heroLift - the lift handed to the popup.
 * @param count - matches after the filter (decides whether a footer is painted).
 * @returns the content-row limit for {@link paletteWindow}.
 */
export function heroPaletteLimitRows(rows: number, heroLift: number, count: number): number {
  const room = heroPaletteBottomRow(rows, heroLift) - 2
  const cap = Math.min(HERO_PALETTE_MAX_ROWS, Math.max(1, count))
  const limit = Math.max(1, Math.min(cap, room))
  return count > limit ? Math.max(1, Math.min(limit, room - 1)) : limit
}

/** Content rows a palette box paints: the command rows plus the single footer
 *  row that reports the hidden remainder (see {@link paletteWindow}). */
export function paletteContentRows(visible: number, hidden: number): number {
  return Math.max(0, visible) + (hidden > 0 ? 1 : 0)
}

/**
 * The slice of the command list a palette shows, keeping the SELECTED row
 * visible with minimal sliding.
 *
 * @param count - matches after the filter.
 * @param index - the selected match (any integer; it is wrapped here).
 * @param max - largest number of command rows to show (≥1).
 * @returns `first` (index of the first painted match), `visible` (how many rows
 *   are painted) and `hidden` (how many remain, reachable by filtering/scrolling).
 */
export function paletteWindow(count: number, index: number, max: number): {
  first: number
  visible: number
  hidden: number
} {
  if (count <= 0) return { first: 0, visible: 0, hidden: 0 }
  const limit = Math.max(1, Math.min(max, count))
  const sel = ((index % count) + count) % count
  // Slide only as far as the selection requires: while it is inside the window
  // the window stays put (so the list never jumps under the user), and past the
  // bottom edge it follows one row at a time.
  const first = sel < limit ? 0 : Math.min(sel - limit + 1, count - limit)
  return { first, visible: limit, hidden: count - limit }
}

/**
 * Lay out the centered hero stack.
 * @param input - see {@link HeroLayoutInput}.
 * @returns the resolved geometry; spacers are never negative (a stack taller
 *   than the area collapses the spacers and clips from the bottom instead).
 */
export function heroLayout(input: HeroLayoutInput): HeroLayout {
  const contextLines = input.contextLines ?? 0
  const footerLines = input.footerLines ?? 0
  // The hero draws NO status bar (chrome-free first screen), so the whole
  // window height minus the area padding belongs to the hero stack.
  const areaRows = heroAreaRows(input.rows)
  // Rows between the brand block and the card: the title's own breathing room
  // when nothing sits in between (the hero draws no context line), else
  // gap + context + gap.
  const contextBlock = contextLines > 0 ? HERO_GAP + contextLines + HERO_GAP : (input.titleGap ?? HERO_TITLE_CARD_GAP)
  const stackRows = heroStackRows({
    brandLines: input.brandLines,
    boxH: input.boxH,
    hintLines: input.hintLines,
    titleGap: input.titleGap,
    contextLines,
  })
  // The gap after the composer exists only when hints are drawn (the layout must
  // match the emitted rows exactly) — read from the SAME formula.
  const hintBlock = input.hintLines > 0 ? HERO_GAP + input.hintLines : 0
  const free = Math.max(0, areaRows - stackRows - footerLines)
  const topSpacer = Math.floor(free / 2)
  const bottomSpacer = free - topSpacer
  const composerTopRow = 1 + HERO_AREA_PADDING_Y
    + topSpacer + input.brandLines + contextBlock
  return {
    topSpacer,
    bottomSpacer,
    stackRows,
    composerTopRow,
    composerBottomRow: composerTopRow + input.boxH - 1,
    paletteBottomMargin: hintBlock + bottomSpacer + footerLines,
    areaRows,
  }
}

/**
 * Whether the wordmark fits / is worth drawing at this size.
 * @param rows - terminal rows.
 * @param width - terminal columns.
 * @returns true when the ASCII wordmark should render (else title-only).
 */
export function heroWordmarkFits(rows: number, width: number): boolean {
  return rows >= 22 && width >= 80
}

/* ------------------------------------------------------------------------- *
 * Brand art (generated from the `qialike` wordmark SVGs — see `hero-art.ts`)
 * ------------------------------------------------------------------------- */

/**
 * The half-block glyph the brand art is drawn with on most terminals. `▀`
 * (U+2580) carries a foreground color AND a background color in one cell, which
 * is exactly two stacked tone pixels — so a rasterized cell stays square on a
 * terminal cell that is about twice as tall as it is wide.
 */
export const HERO_ART_CELL_GLYPH = '▀'

/**
 * The BOTTOM-half glyph, used with the cell background as the upper tone on
 * Apple Terminal — see {@link HeroArtEncoding}.
 */
export const HERO_ART_BOTTOM_GLYPH = '▄'

/**
 * How one cell's two stacked tone pixels are split between the glyph and the
 * cell BACKGROUND.
 *
 * - `top` (the shipped encoding, used everywhere except Apple Terminal): the
 *   upper tone is `▀`'s foreground, the lower one the cell background.
 * - `bottom` (Apple Terminal): the WHOLE cell is filled with the upper tone as a
 *   background and the lower tone is the bottom-anchored `▄`.
 *
 * Why the second encoding exists: SF Mono's block glyphs do not fill the row
 * box. Its `█` covers 83.8% of the row with the gap at the TOP (measured on
 * Apple Terminal, 2026-09-17), so a top-anchored `▀` leaves a stripe of the
 * cell's background — i.e. of the WRONG tone — across the top of every row: the
 * reported 横缝. A background always fills the whole cell, and the same
 * measurement says the ink is bottom-aligned, so `▄` reaches the cell's bottom
 * and the two tones meet with no page stripe anywhere. (google-gemini/gemini-cli
 * #23919 works around the same terminal defect with `▅`.)
 *
 * On a terminal whose glyphs DO tile, the two encodings paint the same picture:
 * `bg = upper` + `▄ = lower` is the complement of `▀ = upper` + `bg = lower`.
 * Under `bottom`, cells whose two tones are equal become a plain background with
 * NO glyph at all, which cannot seam on any terminal.
 */
export type HeroArtEncoding = 'top' | 'bottom'

/**
 * Which encoding this terminal needs: `bottom` on macOS (Apple Terminal's SF
 * Mono is the defect this exists for), `top` elsewhere. `QIALIKE_HERO_ART_ENCODING`
 * (`top`/`bottom`) overrides it, so both can be A/B'd on one machine.
 * @param platform - `process.platform`.
 * @param override - the environment value, if any.
 * @returns the encoding to pack the art with.
 */
export function heroArtEncoding(platform: string, override?: string): HeroArtEncoding {
  const value = (override ?? '').trim().toLowerCase()
  if (value === 'top' || value === 'bottom') return value
  return platform === 'darwin' ? 'bottom' : 'top'
}

/** Ink weights per tone role of the design: `B` primary, `M` secondary. Blending
 *  `theme.text` toward `theme.bg` with these weights reproduces the art's
 *  hierarchy on a dark AND on a light theme — the source variants only swap
 *  palettes, the roles are identical.
 *
 *  The third weight is {@link HERO_ART_SHADOW_ALPHA}: the mark's shadow is not a
 *  third *ink* but a 25% tint of the ink it hangs from, so it is derived from
 *  these two rather than listed here. */
export const HERO_ART_INK_ALPHA = { primary: 1, secondary: 0.7 } as const

/** How far the shadow (and the letter-counter fill) is blended toward the
 *  background — 25%, the same weight opencode's wordmark uses for its `~`
 *  (bottom feather) and `_` (counter fill) marks. */
export const HERO_ART_SHADOW_ALPHA = 0.25

/** Rows the brand art occupies (two design-pixel rows per terminal row). */
export const HERO_ART_ROWS = Math.ceil(HERO_ART_WORDMARK_ROWS / 2)

/** Terminal columns the brand art needs (grid width + side margins). */
export const HERO_ART_MARGIN_COLS = 4
/** Minimum terminal width for the brand art. */
export const HERO_ART_MIN_WIDTH = HERO_ART_WORDMARK_COLS + HERO_ART_MARGIN_COLS
/** Minimum terminal rows for the brand art (art + title + context + composer
 *  + hints + footer + padding + status bar). Two rows above the 4-row art this
 *  gate was written for: the rasterized wordmark packs SIX half-block rows. */
export const HERO_ART_MIN_ROWS = 23

/** One rendered hero-art cell: the glyph plus which ink color paints each half. */
export interface HeroArtCell {
  /** Glyph to print (`▀`/`▄`/`█`/space). */
  ch: string
  /** Foreground ink index into {@link heroArtInkColors}. −1 means "no foreground"
   *  for a space; for a GLYPH it means the PAGE colour, which the renderer
   *  substitutes for `theme.bg` (the `bottom` encoding erases a half back to the
   *  page that way). */
  fg: number
  /** Lower-half ink index, −1 = none (the cell background stays clear, i.e. the
   *  page shows through — or, under the `bottom` encoding, the upper tone). */
  bg: number
}

/** Whether a tone cell is part of the mark's BODY (one of the two inks). */
function heroArtBody(tone: string | undefined): boolean {
  return tone === 'B' || tone === 'M'
}

/**
 * The generated tone grid as RENDERED.
 *
 * The SVG's `D` cells are its anti-aliased edge, and drawing all of them as a
 * third, 25% ink put a grey ring around every stroke — brightest reading: a
 * "ghost" halo, including a whole row of it ABOVE the wordmark (2026-09-15, user
 * report). The edge is therefore no longer an outline. It is kept only where it
 * does a job, following the idiom opencode's wordmark uses (`~` = a half block
 * in the shadow colour below the ink, `_` = a letter counter filled with the
 * shadow):
 *
 *  - a cell ENCLOSED by the body (a letter counter) → the shadow fill;
 *  - a cell directly BELOW a body cell → the shadow's bottom feather.
 *
 * Every other `D` cell — above, left or right of the ink — is dropped; opencode
 * never puts its shadow above the mark. Measured on the generated grid: 139 `D`
 * cells → 49 kept (12 enclosed + 37 below) and 90 dropped, whole rows included.
 * The dropped empty cells are replaced by shadow too where they are enclosed or
 * sit below ink (26 of them), so the render grid carries 75 shadow cells.
 * @param tones - the source tone rows (defaults to the generated wordmark).
 * @returns rows of the same shape, using only `B`/`M`/`D`/`.` (`.` = no ink).
 */
export function heroArtShadedTones(tones: readonly string[] = HERO_ART_WORDMARK_TONES): string[] {
  const height = tones.length
  const width = tones.reduce((max, row) => Math.max(max, row.length), 0)
  const at = (y: number, x: number): string => tones[y]?.[x] ?? '.'
  // Flood-fill the OUTSIDE from the border across non-body cells: a non-body
  // cell the fill never reaches is a letter counter (enclosed by the mark).
  const outside: boolean[][] = tones.map(() => new Array<boolean>(width).fill(false))
  const stack: [number, number][] = []
  const visit = (y: number, x: number): void => {
    if (y < 0 || y >= height || x < 0 || x >= width) return
    if (outside[y]![x] || heroArtBody(at(y, x))) return
    outside[y]![x] = true
    stack.push([y, x])
  }
  for (let x = 0; x < width; x++) { visit(0, x); visit(height - 1, x) }
  for (let y = 0; y < height; y++) { visit(y, 0); visit(y, width - 1) }
  while (stack.length > 0) {
    const [y, x] = stack.pop()!
    visit(y - 1, x)
    visit(y + 1, x)
    visit(y, x - 1)
    visit(y, x + 1)
  }
  return tones.map((_row, y) => {
    let out = ''
    for (let x = 0; x < width; x++) {
      const tone = at(y, x)
      if (heroArtBody(tone)) { out += tone; continue }
      const enclosed = !outside[y]![x]
      const underInk = y > 0 && heroArtBody(at(y - 1, x))
      out += enclosed || underInk ? 'D' : '.'
    }
    return out
  })
}

/**
 * Ink index for one `D` half: the shadow belongs to the ink it hangs from, so
 * the nearest body cell above it in the same column picks the slot — `M` strokes
 * get the secondary shadow (index 3), everything else the primary one (index 2).
 * Every shadow cell in the generated grid resolves this way (measured: no cell
 * has body ink both above and below with disagreeing tones). A `D` with no body
 * in its column at all (only reachable through an explicit test grid) falls back
 * to the primary shadow.
 */
function heroArtShadowIndex(tones: readonly string[], y: number, x: number): number {
  for (let up = y - 1; up >= 0; up--) {
    const tone = tones[up]?.[x]
    if (heroArtBody(tone)) return tone === 'M' ? 3 : 2
  }
  for (let down = y + 1; down < tones.length; down++) {
    const tone = tones[down]?.[x]
    if (heroArtBody(tone)) return tone === 'M' ? 3 : 2
  }
  return 2
}

/** Ink index of one half of a cell (`B`=0, `M`=1, shadow=2/3), −1 = no ink. */
function heroArtInk(tones: readonly string[], y: number, x: number): number {
  const tone = tones[y]?.[x]
  if (tone === 'B') return 0
  if (tone === 'M') return 1
  if (tone === 'D') return heroArtShadowIndex(tones, y, x)
  return -1
}

/**
 * Pack the shaded tone grid into colored half-block cells: two stacked
 * design-pixel rows become one terminal row.
 *
 * The two tone rows map to (glyph, background) differently per
 * {@link HeroArtEncoding}: `top` draws the upper tone with `▀` and the lower one
 * with the cell background; `bottom` fills the cell with the upper tone and
 * draws the lower one with `▄`. Both paint the same picture on a terminal whose
 * glyphs tile; see the type's doc for why Apple Terminal needs the second.
 * @param tones - tone rows (defaults to {@link heroArtShadedTones}, i.e. the
 *   generated wordmark with the AA halo dropped and the counters/feather kept);
 *   a trailing odd row is dropped, since a half-block cell needs both halves.
 * @param encoding - which half the glyph carries (defaults to the shipped
 *   `top`).
 * @returns one array of cells per terminal row.
 */
export function heroArtCells(
  tones: readonly string[] = heroArtShadedTones(),
  encoding: HeroArtEncoding = 'top',
): HeroArtCell[][] {
  const width = tones.reduce((max, row) => Math.max(max, row.length), 0)
  const out: HeroArtCell[][] = []
  for (let r = 0; r + 1 < tones.length; r += 2) {
    const line: HeroArtCell[] = []
    for (let c = 0; c < width; c++) {
      const top = heroArtInk(tones, r, c)
      const bottom = heroArtInk(tones, r + 1, c)
      if (encoding === 'bottom') {
        // The background carries the UPPER tone (a background always fills the
        // cell), and the bottom-anchored glyph carries the lower one — so no
        // top-anchored ink can leave a page stripe above itself.
        if (top === bottom) line.push({ ch: ' ', fg: -1, bg: top })
        else if (top >= 0) line.push({ ch: HERO_ART_BOTTOM_GLYPH, fg: bottom, bg: top })
        else line.push({ ch: HERO_ART_BOTTOM_GLYPH, fg: bottom, bg: -1 })
        continue
      }
      if (top >= 0 && bottom >= 0) {
        // Same ink on both halves paints as one solid block (no background).
        line.push(top === bottom ? { ch: '█', fg: top, bg: -1 } : { ch: '▀', fg: top, bg: bottom })
      } else if (top >= 0) line.push({ ch: '▀', fg: top, bg: -1 })
      else if (bottom >= 0) line.push({ ch: '▄', fg: bottom, bg: -1 })
      else line.push({ ch: ' ', fg: -1, bg: -1 })
    }
    out.push(line)
  }
  return out
}

/** Parse `#rgb`/`#rrggbb`(aa) into 0–255 channels. */
function heroArtRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const int = Number.parseInt(full.slice(0, 6), 16)
  if (!Number.isFinite(int) || full.length < 6) return [255, 255, 255]
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff]
}

/**
 * Resolve the four inks the brand art draws with, from a theme:
 * `[primary, secondary, shadowOfPrimary, shadowOfSecondary]`.
 *
 * `primary` is `theme.text` itself and `secondary` is it blended
 * {@link HERO_ART_INK_ALPHA}.secondary of the way toward `theme.bg` (the source
 * SVG's own second ink sits at the same weight); each shadow is its ink blended
 * {@link HERO_ART_SHADOW_ALPHA} toward `theme.bg`, so a dark theme gets a dark
 * shadow and a light theme a light one.
 * @param text - theme text color (`#rgb`/`#rrggbb`).
 * @param bg - theme background color.
 * @returns hex colors for the four ink slots, in index order.
 */
export function heroArtInkColors(
  text: string,
  bg: string,
  ink: { readonly primary: number; readonly secondary: number } = HERO_ART_INK_ALPHA,
  shadow = HERO_ART_SHADOW_ALPHA,
): string[] {
  const [tr, tg, tb] = heroArtRgb(text)
  const [br, bgc, bb] = heroArtRgb(bg)
  const chan = (t: number, b: number, a: number): number =>
    Math.max(0, Math.min(255, Math.round(t * a + b * (1 - a))))
  const hex = (c: readonly [number, number, number]): string =>
    `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  type Rgb = readonly [number, number, number]
  const primary: Rgb = [chan(tr, br, ink.primary), chan(tg, bgc, ink.primary), chan(tb, bb, ink.primary)]
  const secondary: Rgb = [
    chan(tr, br, ink.secondary),
    chan(tg, bgc, ink.secondary),
    chan(tb, bb, ink.secondary),
  ]
  const tint = (c: Rgb): Rgb => [chan(c[0], br, shadow), chan(c[1], bgc, shadow), chan(c[2], bb, shadow)]
  return [hex(primary), hex(secondary), hex(tint(primary)), hex(tint(secondary))]
}

/** Brand mark flavor the hero draws above its title. */
export type HeroMarkKind = 'blocks' | 'ascii' | 'none'

/** `QIALIKE_HERO_ART` override: force a flavor instead of auto-selecting. */
export type HeroArtMode = 'auto' | HeroMarkKind

/**
 * Parse the `QIALIKE_HERO_ART` override (`blocks`/`text`/`off`, anything else
 * = `auto`). `text` is the ASCII fallback mark, `off` draws no brand art.
 * @param raw - the environment value.
 * @returns the mode.
 */
export function heroArtMode(raw: string | undefined): HeroArtMode {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === 'blocks' || value === 'art') return 'blocks'
  if (value === 'text' || value === 'ascii') return 'ascii'
  if (value === 'off' || value === 'none') return 'none'
  return 'auto'
}

/**
 * The one-line hint the hero shows UNDER its composer card.
 *
 * - no provider ready -> point at `/models`, the only way to add one;
 * - a provider is ready -> point at `/sessions`, the other thing a first-run
 *   hero cannot do by itself (restore history);
 * - `undefined` (the launch's credential probe has not settled yet) -> no line,
 *   so the row never flashes a wrong instruction on the first frame.
 * @param providerReady - `Store.providerReady`.
 * @returns the line, or `undefined` when nothing should be drawn.
 */
export function heroHintLine(providerReady: boolean | undefined): string | undefined {
  if (providerReady === undefined) return undefined
  return providerReady
    ? 'Use /sessions to restore a historical session'
    : 'No provider yet — use /models to add one'
}

/** The glyph that OPENS the hint line (user call: an eye-catching marker at the
 *  line's start). U+1F4A1 is Extended_Pictographic, so every width table (and
 *  `string-width`) measures it as exactly two columns — the row therefore stays
 *  centered even though the mark is not ASCII. */
export const HERO_HINT_ICON = '💡'

/** The label painted next to {@link HERO_HINT_ICON}, in the accent colour and
 *  bold: it names the line ("this is a tip, not an error"). */
export const HERO_HINT_LABEL = 'Tip'

/** Blank columns between {@link HERO_HINT_LABEL} and the hint sentence. */
export const HERO_HINT_LABEL_GAP = 2

/**
 * The hint line as ONE paintable string: `<icon> <label><gap><sentence>`.
 *
 * Pure so the renderer, the row count (`heroHintRowCount`) and the centering
 * pad all derive from a single builder — the colored `<Text>` parts in the
 * panel must concatenate back to exactly this string, or the centered row would
 * drift from the model (the same class of bug as the caret drift).
 * @param providerReady - `Store.providerReady`.
 * @returns the display line, or `undefined` when nothing should be drawn.
 */
export function heroHintText(providerReady: boolean | undefined): string | undefined {
  const line = heroHintLine(providerReady)
  if (line === undefined) return undefined
  return `${HERO_HINT_ICON} ${HERO_HINT_LABEL}${' '.repeat(HERO_HINT_LABEL_GAP)}${line}`
}

/**
 * The hero's warning line for a repository overlay that was applied (or skipped),
 * or `undefined` when the launch had none.
 *
 * It REPLACES the tip rather than adding a row: the repository layer is applied
 * without any prompt, so the row that would carry advice carries the one fact a
 * user cannot otherwise see — and the hero stack keeps its row count, which is
 * what the layout budget and the small-terminal scenarios pin.
 * @param notice - `Store.repoOverlayNotice`.
 * @returns the paintable line, or `undefined`.
 */
export function heroNoticeText(notice: string | undefined): string | undefined {
  return notice === undefined ? undefined : `⚠ ${notice}`
}

/**
 * How many rows sit UNDER the card: the older-history progress line while a
 * resumed session folds, plus exactly one of {repository-overlay warning, tip}.
 * Pure so the layout model ({@link heroBudget}), the paint and the tests count
 * them the same way — the panel used to compute this inline with nothing
 * asserting it.
 * @param olderLoading - `Store.olderLoading`.
 * @param providerReady - `Store.providerReady`.
 * @param notice - `Store.repoOverlayNotice` (replaces the tip when present).
 * @returns 0..2 rows.
 */
export function heroHintRows(olderLoading: boolean, providerReady: boolean | undefined, notice?: string | undefined): number {
  return (olderLoading ? 1 : 0) + (notice !== undefined || heroHintLine(providerReady) !== undefined ? 1 : 0)
}

/** Rows a mark occupies in the hero stack (0 for `none`). */
export function heroMarkRows(kind: HeroMarkKind): number {
  if (kind === 'blocks') return HERO_ART_ROWS
  if (kind === 'ascii') return HERO_WORDMARK.length
  return 0
}

/** Inputs of {@link heroArtMarkKind}. */
export interface HeroArtMarkInput {
  /** Terminal rows. */
  rows: number
  /** Terminal columns. */
  width: number
  /** Measured display width of ONE art cell glyph ({@link HERO_ART_CELL_GLYPH})
   *  on this terminal — `▀` is East-Asian-Ambiguous, so it is only safe to draw
   *  the art when the terminal really advances it one column. */
  blockWidth: number
  /** `QIALIKE_HERO_ART` override (default `auto`). */
  mode?: HeroArtMode
}

/**
 * Which brand mark to draw, and whether at all.
 * @param input - see {@link HeroArtMarkInput}.
 * @returns `blocks` for the generated pixel art, `ascii` for the plain-`#`
 *   fallback wordmark, `none` when only the title fits.
 */
export function heroArtMarkKind(input: HeroArtMarkInput): HeroMarkKind {
  const mode = input.mode ?? 'auto'
  if (mode === 'none') return 'none'
  if (mode === 'blocks') return 'blocks'
  if (mode === 'ascii') return heroWordmarkFits(input.rows, input.width) ? 'ascii' : 'none'
  const artFits = input.blockWidth === 1
    && input.width >= HERO_ART_MIN_WIDTH
    && input.rows >= HERO_ART_MIN_ROWS
  if (artFits) return 'blocks'
  return heroWordmarkFits(input.rows, input.width) ? 'ascii' : 'none'
}
