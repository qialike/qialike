/**
 * Tests for the hero BRAND ART: the generated `qialike` pixel-art wordmark
 * (`hero-art.ts`, read straight off the source SVGs by `svg/gen-hero-art.py`),
 * its background-only packing, its tone → theme color ramp and the fallback
 * ladder (art → ASCII wordmark → title only).
 *
 * The art is drawn with cell BACKGROUNDS and spaces only — no block glyph — so
 * its width is exactly `HERO_ART_COLS` on every terminal and these tests pin the
 * one invariant that makes it correct: one SOURCE pixel becomes
 * `HERO_ART_CELLS_PER_PIXEL` cells of the same ink, in one cell row.
 *
 * Run with `bun test tests/hero-art.test.ts`.
 *
 * @module dsh-tui/hero-art-test
 */

import { describe, expect, test } from 'bun:test'
import {
  HERO_ART_SOURCE_SHA256,
  HERO_ART_SOURCES,
  HERO_ART_WORDMARK_COLS,
  HERO_ART_WORDMARK_ROWS,
  HERO_ART_WORDMARK_TONES,
  HERO_ART_WORDMARK_UNIT,
} from '../packages/dsh-tui-app/src/hero-art.ts'
import {
  HERO_ART_CELLS_PER_PIXEL,
  HERO_ART_COLS,
  HERO_ART_INK_ALPHA,
  HERO_ART_MARGIN_COLS,
  HERO_ART_MIN_ROWS,
  HERO_ART_MIN_WIDTH,
  HERO_ART_ROWS,
  HERO_WORDMARK,
  heroArtCells,
  heroArtInkColors,
  heroArtMarkKind,
  heroArtMode,
  heroMarkRows,
} from '../packages/dsh-tui-app/src/hero-layout.ts'

/** Tone census of a grid, so a test can state a count instead of a shape. */
const census = (grid: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const row of grid) for (const tone of row) out[tone] = (out[tone] ?? 0) + 1
  return out
}

describe('generated brand art table', () => {
  test('is the wordmark\'s OWN pixel grid — no resampling of it', () => {
    // The source SVG draws on a 6-unit grid (168x42 viewBox = 28x7 cells one
    // 6-unit pixel each); the table is that grid, cropped to the ink bounds, so
    // every entry IS a source pixel. The previous generator rendered the same
    // artwork onto a 48x12 grid — 48/28 = 1.714 — so a quarter of the cells
    // landed on a pixel boundary and were resolved as "anti-aliased edge"
    // instead of ink, which is what made the mark read as jagged.
    expect(HERO_ART_WORDMARK_UNIT).toBe(6)
    expect(HERO_ART_WORDMARK_COLS).toBe(28)
    expect(HERO_ART_WORDMARK_ROWS).toBe(6)
    expect(HERO_ART_WORDMARK_TONES).toHaveLength(HERO_ART_WORDMARK_ROWS)
    for (const row of HERO_ART_WORDMARK_TONES) expect(row).toHaveLength(HERO_ART_WORDMARK_COLS)
  })

  test('uses only the source\'s two inks, and both appear', () => {
    const joined = HERO_ART_WORDMARK_TONES.join('')
    expect(/^[.BM]+$/.test(joined)).toBe(true)
    for (const tone of 'BM') expect(joined.includes(tone)).toBe(true)
    // No `D` role at all: a two-ink pixel-art source has no anti-aliased edge.
    expect(joined.includes('D')).toBe(false)
    expect(census(HERO_ART_WORDMARK_TONES)).toEqual({ M: 34, B: 38, '.': 96 })
  })

  test('keeps the letter counters open and the glyphs separated', () => {
    const grid = HERO_ART_WORDMARK_TONES
    // The `q` is a ring: a 4x5 box whose 2x3 centre is EMPTY. Filling it (the
    // opencode-style counter tint the old shading pass applied) is what made the
    // mark read as a row of solid blocks.
    expect(grid[0]!.slice(0, 4)).toBe('MMMM')
    expect(grid[4]!.slice(0, 4)).toBe('MMMM')
    for (const y of [1, 2, 3]) expect(grid[y]!.slice(0, 4)).toBe('M..M')
    // Every row below the cap line keeps gaps, i.e. the letters stay separated.
    for (const row of grid) expect(row.includes('.')).toBe(true)
  })

  test('the `q` descender is the only ink below the baseline', () => {
    const last = HERO_ART_WORDMARK_TONES[HERO_ART_WORDMARK_ROWS - 1]!
    const columns = [...last].flatMap((tone, index) => (tone === '.' ? [] : [index]))
    expect(columns.length, 'there is a descender').toBeGreaterThan(0)
    expect(columns.length, 'and it is narrow').toBeLessThanOrEqual(4)
    expect(columns[columns.length - 1]! - columns[0]!, 'and contiguous').toBe(columns.length - 1)
    // It hangs UNDER the mark: those columns carry ink directly above them too.
    const above = HERO_ART_WORDMARK_TONES[HERO_ART_WORDMARK_ROWS - 2]!
    for (const c of columns) expect(above[c]).not.toBe('.')
  })

  test('records its provenance (both variant SVGs + their sha256)', () => {
    expect(HERO_ART_SOURCES.dark).toBe('svg/qialike-wordmark-dark.svg')
    expect(HERO_ART_SOURCES.light).toBe('svg/qialike-wordmark-light.svg')
    expect(HERO_ART_SOURCE_SHA256.dark).toMatch(/^[0-9a-f]{64}$/)
    expect(HERO_ART_SOURCE_SHA256.light).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('background-only packing (one source pixel = two cells)', () => {
  test('needs two columns per source pixel and one row per source row', () => {
    // A terminal cell is ~2x as tall as it is wide, so two cells side by side are
    // the square the source's 6x6 pixel asks for; the mark therefore keeps the
    // source's aspect instead of being stretched.
    expect(HERO_ART_CELLS_PER_PIXEL).toBe(2)
    expect(HERO_ART_COLS).toBe(HERO_ART_WORDMARK_COLS * HERO_ART_CELLS_PER_PIXEL)
    expect(HERO_ART_ROWS).toBe(HERO_ART_WORDMARK_ROWS)
    const cells = heroArtCells()
    expect(cells).toHaveLength(HERO_ART_ROWS)
    for (const line of cells) expect(line).toHaveLength(HERO_ART_COLS)
  })

  test('gives both cells of a source pixel the SAME ink', () => {
    const cells = heroArtCells()
    const inkOf = (tone: string): number => (tone === 'B' ? 0 : tone === 'M' ? 1 : -1)
    for (let r = 0; r < HERO_ART_WORDMARK_ROWS; r++) {
      for (let c = 0; c < HERO_ART_WORDMARK_COLS; c++) {
        const want = inkOf(HERO_ART_WORDMARK_TONES[r]![c]!)
        for (let k = 0; k < HERO_ART_CELLS_PER_PIXEL; k++) {
          expect(cells[r]![c * HERO_ART_CELLS_PER_PIXEL + k]!.ink, `(${r},${c})`).toBe(want)
        }
      }
    }
  })

  test('paints every cell with a background and nothing else', () => {
    // A cell carries ONE field. There is no glyph and no second (foreground)
    // half, by construction: the mark's ink is always a cell background, which
    // every terminal fills exactly — so no font anti-aliasing and no seam can
    // appear, on any terminal (the old encoding needed `▄`, whose ink cannot
    // reach a cell top on Apple Terminal's SF Mono).
    for (const line of heroArtCells()) {
      for (const cell of line) {
        expect(Object.keys(cell)).toEqual(['ink'])
        expect([-1, 0, 1]).toContain(cell.ink)
      }
    }
  })

  test('the drawn cells are the source pixels doubled, and nothing else', () => {
    const flat = heroArtCells().flat()
    const painted = flat.filter((cell) => cell.ink >= 0)
    const source = census(HERO_ART_WORDMARK_TONES)
    expect(painted.filter((c) => c.ink === 1).length).toBe(source['M']! * HERO_ART_CELLS_PER_PIXEL)
    expect(painted.filter((c) => c.ink === 0).length).toBe(source['B']! * HERO_ART_CELLS_PER_PIXEL)
    expect(flat.filter((c) => c.ink === -1).length).toBe(source['.']! * HERO_ART_CELLS_PER_PIXEL)
  })

  test('pads a short row instead of shifting the mark', () => {
    const [line] = heroArtCells(['BM'])
    expect(line).toHaveLength(HERO_ART_COLS)
    expect(line!.slice(0, 4).map((c) => c.ink)).toEqual([0, 0, 1, 1])
    for (const cell of line!.slice(4)) expect(cell.ink).toBe(-1)
  })
})

describe('ink palette', () => {
  test('is the SVG two-ink design, blended toward the theme background', () => {
    expect(HERO_ART_INK_ALPHA).toEqual({ primary: 1, secondary: 0.7 })
    expect(heroArtInkColors('#ffffff', '#000000')).toEqual(['#ffffff', '#b3b3b3'])
    expect(heroArtInkColors('#000000', '#ffffff')).toEqual(['#000000', '#4d4d4d'])
    // The default dark theme's two inks (the approved preview's colors).
    expect(heroArtInkColors('#f9fafb', '#151517')).toEqual(['#f9fafb', '#b5b5b7'])
  })

  test('primary ink IS the theme text color', () => {
    expect(heroArtInkColors('#f9fafb', '#151517')[0]).toBe('#f9fafb')
    // The secondary sits between the ink and the page, so the two-ink hierarchy
    // survives a light theme too (the light variant's own second ink does).
    const [primary, secondary] = heroArtInkColors('#000000', '#ffffff')
    expect(secondary).not.toBe(primary)
    expect(secondary).not.toBe('#ffffff')
  })

  test('accepts #rgb shorthand and survives junk input', () => {
    expect(heroArtInkColors('#fff', '#000')[0]).toBe('#ffffff')
    expect(heroArtInkColors('nonsense', '#000')).toHaveLength(2)
  })
})

describe('mark selection ladder', () => {
  const wide = { rows: 30, width: 100 }

  test('picks the art whenever it fits — no glyph-width clause any more', () => {
    expect(heroArtMarkKind(wide)).toBe('blocks')
    expect(HERO_ART_MIN_WIDTH).toBe(HERO_ART_COLS + HERO_ART_MARGIN_COLS)
    // The old ladder needed the terminal to measure `▄` as ONE column (it is
    // East-Asian-Ambiguous). Nothing in the art is a glyph now, so the decision
    // is pure geometry: the input carries no width input at all.
    expect(Object.keys(wide)).toEqual(['rows', 'width'])
  })

  test('falls back on short or narrow terminals, then to nothing', () => {
    // 21 rows: too short for the 23-row art AND for the 22-row ASCII mark.
    expect(heroArtMarkKind({ rows: 21, width: 100 })).toBe('none')
    expect(heroArtMarkKind({ rows: HERO_ART_MIN_ROWS, width: 100 })).toBe('blocks')
    // The band between the two gates: too short for the art, but the shorter
    // ASCII fallback still fits.
    expect(heroArtMarkKind({ rows: 22, width: 100 })).toBe('ascii')
    // Just below the art's width the ASCII mark cannot help either (it needs 80).
    expect(heroArtMarkKind({ rows: 30, width: HERO_ART_MIN_WIDTH - 1 })).toBe('none')
    // Too small for even the ASCII wordmark (needs 22 rows / 80 columns).
    expect(heroArtMarkKind({ rows: 20, width: 60 })).toBe('none')
    expect(heroArtMarkKind({ rows: 30, width: 40 })).toBe('none')
  })

  test('the art reaches narrower terminals than the ASCII fallback needs', () => {
    // 60 columns is below the ASCII wordmark's 80, but the art is only 56 wide.
    expect(HERO_ART_COLS).toBe(56)
    expect(heroArtMarkKind({ rows: 30, width: 60 })).toBe('blocks')
  })

  test('honors the DSH_TUI_HERO_ART override', () => {
    expect(heroArtMarkKind({ ...wide, mode: 'blocks' })).toBe('blocks')
    expect(heroArtMarkKind({ ...wide, mode: 'ascii' })).toBe('ascii')
    expect(heroArtMarkKind({ ...wide, mode: 'none' })).toBe('none')
    // Forced flavors still respect "does it fit at all".
    expect(heroArtMarkKind({ rows: 12, width: 30, mode: 'blocks' })).toBe('blocks')
    expect(heroArtMarkKind({ rows: 12, width: 30, mode: 'ascii' })).toBe('none')
  })

  test('parses the mode, defaulting unknown values to auto', () => {
    expect(heroArtMode(undefined)).toBe('auto')
    expect(heroArtMode('')).toBe('auto')
    expect(heroArtMode(' BLOCKS ')).toBe('blocks')
    expect(heroArtMode('art')).toBe('blocks')
    expect(heroArtMode('text')).toBe('ascii')
    expect(heroArtMode('ascii')).toBe('ascii')
    expect(heroArtMode('off')).toBe('none')
    expect(heroArtMode('none')).toBe('none')
    expect(heroArtMode('glitter')).toBe('auto')
  })

  test('reports the rows each mark costs the hero stack', () => {
    expect(heroMarkRows('blocks')).toBe(HERO_ART_ROWS)
    expect(heroMarkRows('ascii')).toBe(HERO_WORDMARK.length)
    expect(heroMarkRows('none')).toBe(0)
    // The pixel-art wordmark is TALLER than the ASCII fallback (6 vs 5 rows) —
    // it used to be 4, which is why HERO_ART_MIN_ROWS moved 21 -> 23.
    expect(HERO_ART_ROWS).toBeGreaterThan(HERO_WORDMARK.length)
  })
})
