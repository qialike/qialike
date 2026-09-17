/**
 * Hero brand art — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Regenerate with:  python3 svg/gen-hero-art.py
 *
 * Source: the `qialike-wordmark-{dark,light}.svg` wordmark. Those are PIXEL
 * ART, not vector art: every coordinate is a multiple of 6, so the 168x42
 * viewBox holds a 28x6 grid of 6x6 source pixels and this table is
 * read straight off the path data — nothing is rasterized or resampled (see
 * the generator for why that matters). Both variants carry IDENTICAL geometry
 * and differ only in palette, so they resolve to this one grid (the generator
 * asserts that) — the ink COLORS the app draws with come from the active theme,
 * not from the SVG: `heroArtInkColors(theme.text, theme.bg)` blends by
 * `HERO_ART_INK_ALPHA`.
 *
 * Tone alphabet (one cell = one SOURCE pixel of the wordmark):
 *   `B` primary ink  ·  `M` secondary ink  ·  `.` empty
 *   dark  variant B=#f1ecec M=#b7b1b1
 *   light variant B=#201e1e M=#656363
 *
 * @module @yourname/dsh-tui-app/hero-art
 */

/** Source file each variant was rendered from (workspace-relative). */
export const HERO_ART_SOURCES = {
  dark: 'svg/qialike-wordmark-dark.svg',
  light: 'svg/qialike-wordmark-light.svg',
} as const

/** sha256 of the source SVGs at generation time (drift check). */
export const HERO_ART_SOURCE_SHA256 = {
  dark: 'abe7c945b5f0496227d07c0c8685d7e6d605e332ef47e9b1aeb83309bec11724',
  light: '63a272e5554f2e9097db8f572b69f189fa3b097c9784fd26aede5ad606fedca4',
} as const

/**
 * SVG user units per source pixel of the wordmark. The generator REFUSES a
 * source whose coordinates are not all multiples of this: the artwork is pixel
 * art, and reading it off a grid it does not sit on is what resampled (and so
 * jagged) the mark before.
 */
export const HERO_ART_WORDMARK_UNIT: number = 6

/** Wordmark grid width in SOURCE PIXELS (the 168x42 viewBox holds
 *  28 x 6 of them). */
export const HERO_ART_WORDMARK_COLS: number = 28

/** Wordmark grid height in source pixels (cropped to the ink bounds). */
export const HERO_ART_WORDMARK_ROWS: number = 6

/**
 * The `qialike` wordmark, one string per source-pixel row
 * (6 x 28), left to right, top to bottom.
 */
export const HERO_ART_WORDMARK_TONES: readonly string[] = [
  'MMMM.M..MMM.B....B.B..B.BBBB',
  'M..M.M....M.B....B.B.B..B..B',
  'M..M.M.MMMM.B....B.BB...BBBB',
  'M..M.M.M..M.B....B.B.B..B...',
  'MMMM.M.MMMM.BBBB.B.B..B.BBBB',
  '...M........................',
]
