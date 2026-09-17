/**
 * Hero brand art — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Regenerate with:  python3 svg/gen-hero-art.py
 *
 * Source: the `qialike-wordmark-{dark,light}.svg` wordmark. It is PIXEL
 * ART on a 3-unit grid: every coordinate is a multiple of it, so the
 * 168x42 viewBox is a 56x14 grid of 3x3 source pixels and the table
 * below is that grid cropped to the ink bounds (56x12). It is read
 * straight off the path data — nothing is rasterized or resampled (see the
 * generator for why that matters). Both variants carry IDENTICAL geometry and
 * differ only in palette, so they resolve to this one grid (the generator
 * asserts that) — the ink COLORS the app draws with come from the active
 * theme, not from the SVG: `heroArtInkColors(theme.text, theme.bg)` blends by
 * `HERO_ART_INK_ALPHA`.
 *
 * TWO grids, because the art is painted with cell BACKGROUNDS at
 * `HERO_ART_CELLS_PER_PIXEL` terminal columns per source pixel:
 *   - `HERO_ART_WORDMARK_FINE_*` is the source's own 56x12 grid; it needs
 *     112 terminal columns, so it is the tier a WIDE terminal draws;
 *   - `HERO_ART_WORDMARK_*` is that grid reduced 2x2 (a cell keeps an
 *     ink when at least half of the fine sub-pixels it covers carry it),
 *     28x6 / 56 columns, the tier a NARROW terminal draws.
 * The reduction is exact in shape and asserted by the generator, never
 * eyeballed.
 *
 * Tone alphabet (one cell = one source pixel):
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
  dark: '36e9142e9567f2121ab69941872b56695b0310fb58fed10c97781e62e1f2744c',
  light: '569e32d7858613d96b765258e52cc633c911ccc129ec98a645e643398f0e94be',
} as const

/**
 * SVG user units per source pixel of the FINE grid. The generator DERIVES
 * this from the coordinates (their greatest common divisor, after snapping
 * Inkscape float noise) and REFUSES a source that does not sit on a shared
 * grid or whose grid does not tile the viewBox — reading artwork off a grid it
 * does not sit on is what resampled (and so jagged) the mark before.
 */
export const HERO_ART_WORDMARK_FINE_UNIT: number = 3

/** Fine grid width in SOURCE PIXELS (56 of them, cropped from the
 *  56 the 168x42 viewBox holds at 3 units each). */
export const HERO_ART_WORDMARK_FINE_COLS: number = 56

/** Fine grid height in source pixels (cropped to the ink bounds). */
export const HERO_ART_WORDMARK_FINE_ROWS: number = 12

/**
 * The `qialike` wordmark on its OWN source grid, one string per source-pixel
 * row (12 x 56), left to right, top to bottom.
 */
export const HERO_ART_WORDMARK_FINE_TONES: readonly string[] = [
  'MMMMMMMM..MM....MMMMMM..BB........BB..BB....BB..BBBBBBBB',
  'MM....MM..MM........MM..BB........BB..BB....BB..BB....BB',
  'MM....MM..MM........MM..BB........BB..BB..BB....BB....BB',
  'MM....MM..MM........MM..BB........BB..BB..BB....BB....BB',
  'MM....MM..MM..MMMMMMMM..BB........BB..BBBB......BBBBBBBB',
  'MM....MM..MM..MMMMMMMM..BB........BB..BBBB......BBBBBBBB',
  'MM....MM..MM..MM....MM..BB........BB..BB..BB....BB......',
  'MM....MM..MM..MM....MM..BB........BB..BB..BB....BB......',
  'MM....MM..MM..MM....MM..BB........BB..BB....BB..BB......',
  'MMMMMMMM..MM..MMMMMMMM..BBBBBBBB..BB..BB....BB..BBBBBBBB',
  '......MM................................................',
  '......MM................................................',
]

/**
 * SVG user units per source pixel of the COARSE grid: 3 (the fine unit) times
 * 2, i.e. 6. The coarse grid is the fine one reduced, so its
 * pixels are exactly the design pixels the hero drew before the source was
 * refined — same table, same footprint.
 */
export const HERO_ART_WORDMARK_UNIT: number = 6

/** Coarse grid width in SOURCE PIXELS (28 x 6); one coarse pixel is
 *  2x2 fine ones. */
export const HERO_ART_WORDMARK_COLS: number = 28

/** Coarse grid height in source pixels. */
export const HERO_ART_WORDMARK_ROWS: number = 6

/**
 * The `qialike` wordmark reduced to the COARSE grid, one string per source-pixel
 * row (6 x 28), left to right, top to bottom. This is the tier a
 * narrow terminal draws; the fine grid above is the wide one.
 */
export const HERO_ART_WORDMARK_TONES: readonly string[] = [
  'MMMM.M..MMM.B....B.B..B.BBBB',
  'M..M.M....M.B....B.B.B..B..B',
  'M..M.M.MMMM.B....B.BB...BBBB',
  'M..M.M.M..M.B....B.B.B..B...',
  'MMMM.M.MMMM.BBBB.B.B..B.BBBB',
  '...M........................',
]
