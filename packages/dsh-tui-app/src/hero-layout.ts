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
 * @module @yourname/dsh-tui-app/hero-layout
 */

import {
  HERO_ART_WORDMARK_COLS,
  HERO_ART_WORDMARK_ROWS,
  HERO_ART_WORDMARK_TONES,
} from './hero-art.ts'

/** Composer box border rows included in `boxH` (round border top+bottom). */
export const HERO_GAP = 1
/** The DOCKED status bar's row count (mirrors conversation STATUS_BAR_HEIGHT).
 *  The hero reserves no status rows at all — it is chrome-free — so this is
 *  kept only for documentation/tests of the docked geometry. */
export const HERO_STATUS_BAR_HEIGHT = 3
/** The padded hero area's top/bottom padding rows (paddingY={1}). */
export const HERO_AREA_PADDING_Y = 1

/**
 * The FALLBACK "dsh-tui" wordmark in plain ASCII (5 rows, 27 columns wide).
 * Plain `#` is deliberate: it renders single-width on every terminal, so it is
 * what the hero falls back to when the real brand art (see
 * `HERO_ART_WORDMARK_TONES`) cannot be trusted — narrow terminals, or a
 * terminal that measures the half-block glyph as two columns wide.
 */
const WORDMARK_GLYPHS: Record<string, readonly string[]> = {
  d: ['  #', '  #', '###', '# #', '###'],
  s: ['###', '#  ', '###', '  #', '###'],
  h: ['#  ', '#  ', '###', '# #', '# #'],
  '-': ['   ', '   ', '###', '   ', '   '],
  t: ['#  ', '###', '#  ', '#  ', '#  '],
  u: ['# #', '# #', '# #', '# #', '###'],
  i: ['###', ' # ', ' # ', ' # ', '###'],
}

/** The rendered wordmark lines (one per row) — the ASCII fallback mark. */
export const HERO_WORDMARK: readonly string[] = (() => {
  const lines = ['', '', '', '', '']
  const word = 'dsh-tui'
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
  /** Rows below the composer inside the hero area (gap + hints + bottom spacer
   *  + footer): the command palette lifts by this much to sit on the card. */
  paletteBottomMargin: number
  /** Content rows available inside the padded hero area. */
  areaRows: number
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
  const areaRows = Math.max(6, input.rows - HERO_AREA_PADDING_Y * 2)
  // The gap after the composer exists only when hints are drawn (the layout
  // must match the emitted rows exactly).
  const hintBlock = input.hintLines > 0 ? HERO_GAP + input.hintLines : 0
  // Rows between the brand block and the card: the title's own breathing room
  // when nothing sits in between (the hero draws no context line), else
  // gap + context + gap.
  const contextBlock = contextLines > 0 ? HERO_GAP + contextLines + HERO_GAP : HERO_TITLE_CARD_GAP
  const stackRows = input.brandLines + contextBlock
    + input.boxH + hintBlock
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
 * The half-block glyph the brand art is drawn with. `▀` (U+2580) carries a
 * foreground color AND a background color in one cell, which is exactly two
 * stacked tone pixels — so a rasterized cell stays square on a terminal cell that
 * is about twice as tall as it is wide.
 */
export const HERO_ART_CELL_GLYPH = '▀'

/** Ink weight per tone role of the design: `B` primary, `M` secondary, `D`
 *  dim/shadow. Blending `theme.text` toward `theme.bg` with these weights
 *  reproduces the art's hierarchy on a dark AND on a light theme — the source
 *  variants only swap palettes, the roles are identical. */
export const HERO_ART_TONE_ALPHA: readonly [number, number, number] = [1, 0.55, 0.25]

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
  /** Upper-half ink tone index into {@link heroArtInkColors}, −1 = empty. */
  fg: number
  /** Lower-half ink tone index, −1 = none (the cell background stays clear). */
  bg: number
}

/** Tone character → tone index (`B`=0, `M`=1, `D`=2), −1 for empty/unknown. */
function heroArtTone(tone: string | undefined): number {
  const index = tone === undefined ? -1 : 'BMD'.indexOf(tone)
  return index
}

/**
 * Pack the generated tone grid into colored half-block cells: two stacked
 * design-pixel rows become one terminal row.
 * @param tones - tone rows (defaults to the generated wordmark art); a trailing
 *   odd row is dropped, since a half-block cell needs both halves.
 * @returns one array of cells per terminal row.
 */
export function heroArtCells(tones: readonly string[] = HERO_ART_WORDMARK_TONES): HeroArtCell[][] {
  const width = tones.reduce((max, row) => Math.max(max, row.length), 0)
  const out: HeroArtCell[][] = []
  for (let r = 0; r + 1 < tones.length; r += 2) {
    const topRow = tones[r] ?? ''
    const bottomRow = tones[r + 1] ?? ''
    const line: HeroArtCell[] = []
    for (let c = 0; c < width; c++) {
      const top = heroArtTone(topRow[c])
      const bottom = heroArtTone(bottomRow[c])
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
 * Resolve the three tone colors for a theme: `theme.text` blended toward
 * `theme.bg` by {@link HERO_ART_TONE_ALPHA}, so the lightest ink (`B`) is the
 * theme's own text color and the shadow (`D`) sits close to the background.
 * @param text - theme text color (`#rgb`/`#rrggbb`).
 * @param bg - theme background color.
 * @returns hex colors for tones `B`, `M`, `D`.
 */
export function heroArtInkColors(
  text: string,
  bg: string,
  alpha: readonly [number, number, number] = HERO_ART_TONE_ALPHA,
): string[] {
  const [tr, tg, tb] = heroArtRgb(text)
  const [br, bgc, bb] = heroArtRgb(bg)
  return alpha.map((a) => {
    const mix = (t: number, b: number): string =>
      Math.max(0, Math.min(255, Math.round(t * a + b * (1 - a)))).toString(16).padStart(2, '0')
    return `#${mix(tr, br)}${mix(tg, bgc)}${mix(tb, bb)}`
  })
}

/** Brand mark flavor the hero draws above its title. */
export type HeroMarkKind = 'blocks' | 'ascii' | 'none'

/** `DSH_TUI_HERO_ART` override: force a flavor instead of auto-selecting. */
export type HeroArtMode = 'auto' | HeroMarkKind

/**
 * Parse the `DSH_TUI_HERO_ART` override (`blocks`/`text`/`off`, anything else
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
  /** `DSH_TUI_HERO_ART` override (default `auto`). */
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
