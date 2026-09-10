/**
 * Hero brand art — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Regenerate with:  python3 svg/gen-hero-art.py
 *
 * Source pixels: `svg/embedcode-{dark,light}.svg` (the user's own brand
 * assets). Both files are PIXEL ART on an integer grid, so the squares and
 * their ink colors are read EXACTLY out of the path data — no rasterizer,
 * no antialiasing, and regenerating needs only python3.
 *
 * Tone alphabet (a design pixel is one square of the source grid):
 *   `B` primary ink  ·  `M` secondary ink  ·  `D` dim/shadow  ·  `.` empty
 * The dark and light variants differ ONLY in palette, so both resolve to
 * this single grid (the generator asserts that):
 *   dark  variant B=#f1ecec M=#b7b1b1 D=#4b4646
 *   light variant B=#211e1e M=#656363 D=#cfcecd
 *
 * @module @yourname/dsh-tui-app/hero-art
 */

/** Source file each variant was rendered from (repo-relative). */
export const HERO_ART_SOURCES = {
  dark: 'svg/embedcode-dark.svg',
  light: 'svg/embedcode-light.svg',
} as const

/** sha256 of the source SVGs at generation time (drift check). */
export const HERO_ART_SOURCE_SHA256 = {
  dark: 'b3e75dee2b0c788bc0812a8cf7740cb91c2311c535bf68ba1e0914aeb584b58a',
  light: '0b4e2eb366d30b597a0e21634a6ba71a4666d68b85c615949b01a8a10b4d6e32',
} as const

/** Wordmark grid width in design pixels (source grid step: 6px). */
export const HERO_ART_WORDMARK_COLS = 45

/** Wordmark grid height in design pixels. */
export const HERO_ART_WORDMARK_ROWS = 8

/**
 * The `embedcode` wordmark, one string per design-pixel row
 * (8 x 45), left to right, top to bottom.
 */
export const HERO_ART_WORDMARK_TONES: readonly string[] = [
  '.............................................',
  '...........M............M..............B.....',
  'MMMM.MM.M..MMMM.MMMM.MMMM.BBBB.BBBB.BBBB.BBBB',
  'M..M.M.M.M.M..M.M..M.M..M.B....B..B.B..B.B..B',
  'MMMM.MDMDM.MDDM.MMMM.MDDM.BDDD.BDDB.BDDB.BBBB',
  'MDDD.MDMDM.MDDM.MDDD.MDDM.BDDD.BDDB.BDDB.BDDD',
  'MMMM.MDMDM.MMMM.MMMM.MMMM.BBBB.BBBB.BBBB.BBBB',
  '.............................................',
]
