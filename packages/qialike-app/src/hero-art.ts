/**
 * Hero brand art — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Regenerate with:  python3 svg/gen-hero-art.py
 *
 * Source: the `qialike-wordmark-{dark,light}.svg` wordmark. These are TRUE
 * VECTOR paths (no integer grid to read shapes off), so the generator
 * rasterizes them with a headless Inkscape and reduces the result to the
 * tone alphabet below. Both variants carry IDENTICAL geometry and differ
 * only in palette, so they resolve to this one grid (the generator asserts
 * that) — the ink COLORS the app draws with come from the active theme,
 * not from the SVG: `heroArtInkColors(theme.text, theme.bg)` blends by
 * `HERO_ART_TONE_ALPHA`.
 *
 * Tone alphabet (one cell = one tone pixel of the rasterized wordmark):
 *   `B` primary ink  ·  `M` secondary ink  ·  `D` anti-aliased edge  ·  `.` empty
 *   dark  variant B=#f1ecec M=#b7b1b1
 *   light variant B=#201e1e M=#656363
 *
 * @module @yourname/qialike-app/hero-art
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

/** Wordmark grid width in tone pixels (rasterized from the 168x42 viewBox). */
export const HERO_ART_WORDMARK_COLS = 48

/** Wordmark grid height in tone pixels. */
export const HERO_ART_WORDMARK_ROWS = 12

/**
 * The `qialike` wordmark, one string per tone-pixel row
 * (12 x 48), left to right, top to bottom.
 */
export const HERO_ART_WORDMARK_TONES: readonly string[] = [
  '................................................',
  'DDDDDDD..D....DDDDD..D.......DD..D....D..DDDDDDD',
  'MMMMMMM.DMD..DMMMMM.DBD......BB.DBD..DBD.BBBBBBB',
  'MMDDDMM.DMD...DDDMM.DBD......BB.DBD.DDDD.BBDDDBB',
  'MM...MM.DMD......MM.DBD......BB.DBD.BB...BB...BB',
  'MM...MM.DMD.MMMMMMM.DBD......BB.DBBB.....BBBBBBB',
  'MM...MM.DMD.MMMMMMM.DBD......BB.DBBB.....BBBBBBB',
  'MM...MM.DMD.MM...MM.DBD......BB.DBD.BB...BB.....',
  'MMDDDMM.DMD.MMDDDMM.DBDDDDDD.BB.DBD.DDDD.BBDDDDD',
  'MMMMMMM.DMD.MMMMMMM.DBBBBBBD.BB.DBD..DBD.BBBBBBB',
  'DDDDDMM..D..DDDDDDD..DDDDDD..DD..D....D..DDDDDDD',
  '.....MM.........................................',
]
