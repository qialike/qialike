/**
 * Tests for the hero BRAND ART: the generated `qialike` pixel-art wordmark
 * (`hero-art.ts`, read straight off the source SVGs by `svg/gen-hero-art.py`),
 * its TWO pixel-art tiers, its background-only packing, its tone → theme color
 * ramp and the fallback ladder (fine art → coarse art → ASCII wordmark → title).
 *
 * The source is pixel art on a 3-unit grid (56x12 after cropping), and the app
 * draws two tiers from it: `blocks-fine` is that grid itself (112 columns) for a
 * wide terminal, `blocks` its 2x2 reduction (28x6, 56 columns) for a narrow one.
 * Both are painted with cell BACKGROUNDS and spaces only — no block glyph — so a
 * row's width is exactly its cell count, and these tests pin the invariants that
 * make that correct: one SOURCE pixel becomes `HERO_ART_CELLS_PER_PIXEL` cells of
 * the same ink in one cell row, and the coarse table really is the reduction of
 * the fine one (recomputed here, not trusted).
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
  HERO_ART_WORDMARK_FINE_COLS,
  HERO_ART_WORDMARK_FINE_ROWS,
  HERO_ART_WORDMARK_FINE_TONES,
  HERO_ART_WORDMARK_FINE_UNIT,
  HERO_ART_WORDMARK_ROWS,
  HERO_ART_WORDMARK_TONES,
  HERO_ART_WORDMARK_UNIT,
} from '../packages/dsh-tui-app/src/hero-art.ts'
import {
  HERO_ART_CELLS_PER_PIXEL,
  HERO_ART_COLS,
  HERO_ART_FINE_COLS,
  HERO_ART_FINE_MIN_ROWS,
  HERO_ART_FINE_MIN_WIDTH,
  HERO_ART_FINE_ROWS,
  HERO_ART_INK_ALPHA,
  HERO_ART_MARGIN_COLS,
  HERO_ART_MIN_ROWS,
  HERO_ART_MIN_WIDTH,
  HERO_ART_ROWS,
  HERO_WORDMARK,
  heroArtCells,
  heroArtFineCells,
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

/**
 * The coarse tier, recomputed independently: a coarse cell keeps the ink of at
 * least half of the 2x2 fine sub-pixels it covers, and an ambiguous split is a
 * failure (it would mean the tiers are different designs, not one design at two
 * resolutions).
 */
const reduce2 = (fine: readonly string[]): string[] => {
  const width = fine[0]?.length ?? 0
  const out: string[] = []
  for (let r = 0; r < fine.length; r += 2) {
    let line = ''
    for (let c = 0; c < width; c += 2) {
      const quad = [fine[r]![c], fine[r]![c + 1], fine[r + 1]![c], fine[r + 1]![c + 1]]
      const counts = new Map<string, number>()
      for (const tone of quad) if (tone !== '.') counts.set(tone!, (counts.get(tone!) ?? 0) + 1)
      const kept = [...counts].filter(([, n]) => n * 2 >= quad.length).map(([tone]) => tone)
      expect(kept.length, `coarse cell (${r / 2},${c / 2}) is ambiguous`).toBeLessThanOrEqual(1)
      line += kept[0] ?? '.'
    }
    out.push(line)
  }
  return out
}

describe('generated brand art — the FINE tier (the source\'s own grid)', () => {
  test('is the wordmark\'s OWN pixel grid — no resampling of it', () => {
    // The source SVGs draw on a 3-unit grid (the GCD of their coordinates:
    // 168x42 viewBox = 56x14 cells one 3-unit pixel each), and the table is that
    // grid cropped to the ink bounds, so every entry IS a source pixel. The
    // generator refuses off-grid geometry, curves and half-covered cells rather
    // than resampling: reading artwork off a grid it does not sit on is what
    // turned a quarter of the cells into fake "anti-aliased edge" before.
    expect(HERO_ART_WORDMARK_FINE_UNIT).toBe(3)
    expect(HERO_ART_WORDMARK_FINE_COLS).toBe(56)
    expect(HERO_ART_WORDMARK_FINE_ROWS).toBe(12)
    expect(HERO_ART_WORDMARK_FINE_TONES).toHaveLength(HERO_ART_WORDMARK_FINE_ROWS)
    for (const row of HERO_ART_WORDMARK_FINE_TONES) expect(row).toHaveLength(HERO_ART_WORDMARK_FINE_COLS)
  })

  test('uses only the source\'s two inks, and both appear', () => {
    const joined = HERO_ART_WORDMARK_FINE_TONES.join('')
    expect(/^[.BM]+$/.test(joined)).toBe(true)
    for (const tone of 'BM') expect(joined.includes(tone)).toBe(true)
    // No `D` role at all: a two-ink pixel-art source has no anti-aliased edge.
    expect(joined.includes('D')).toBe(false)
    expect(census(HERO_ART_WORDMARK_FINE_TONES)).toEqual({ M: 120, B: 136, '.': 416 })
  })

  test('keeps the letter counters open and the glyphs separated', () => {
    const grid = HERO_ART_WORDMARK_FINE_TONES
    // The `q` is a ring: an 8x10 box whose 4x8 centre is EMPTY at the source's
    // own resolution. Filling it (the opencode-style counter tint the old
    // shading pass applied) is what made the mark read as a row of solid blocks.
    expect(grid[0]!.slice(0, 8)).toBe('MMMMMMMM')
    expect(grid[9]!.slice(0, 8)).toBe('MMMMMMMM')
    for (const y of [1, 2, 3, 4, 5, 6, 7, 8]) expect(grid[y]!.slice(0, 8)).toBe('MM....MM')
    // Every row keeps gaps, i.e. the letters stay separated.
    for (const row of grid) expect(row.includes('.')).toBe(true)
  })

  test('the `q` descender is the only ink below the baseline', () => {
    const last = HERO_ART_WORDMARK_FINE_TONES[HERO_ART_WORDMARK_FINE_ROWS - 1]!
    const columns = [...last].flatMap((tone, index) => (tone === '.' ? [] : [index]))
    expect(columns.length, 'there is a descender').toBeGreaterThan(0)
    expect(columns.length, 'and it is narrow').toBeLessThanOrEqual(4)
    expect(columns[columns.length - 1]! - columns[0]!, 'and contiguous').toBe(columns.length - 1)
    // It hangs UNDER the mark: those columns carry ink directly above them too.
    const above = HERO_ART_WORDMARK_FINE_TONES[HERO_ART_WORDMARK_FINE_ROWS - 2]!
    for (const c of columns) expect(above[c]).not.toBe('.')
  })
})

describe('generated brand art — the COARSE tier (its 2x2 reduction)', () => {
  test('is the fine grid halved, in shape AND in every tone', () => {
    expect(HERO_ART_WORDMARK_UNIT).toBe(HERO_ART_WORDMARK_FINE_UNIT * 2)
    expect(HERO_ART_WORDMARK_COLS * 2).toBe(HERO_ART_WORDMARK_FINE_COLS)
    expect(HERO_ART_WORDMARK_ROWS * 2).toBe(HERO_ART_WORDMARK_FINE_ROWS)
    expect(HERO_ART_WORDMARK_TONES).toHaveLength(HERO_ART_WORDMARK_ROWS)
    for (const row of HERO_ART_WORDMARK_TONES) expect(row).toHaveLength(HERO_ART_WORDMARK_COLS)
    // The load-bearing invariant: the coarse table is EXACTLY the majority
    // reduction of the fine one, so the two tiers can never drift into different
    // designs (a stale hand-written table would fail here).
    expect(HERO_ART_WORDMARK_TONES).toEqual(reduce2(HERO_ART_WORDMARK_FINE_TONES))
    expect(census(HERO_ART_WORDMARK_TONES)).toEqual({ M: 34, B: 38, '.': 96 })
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
    // the square the source's 3x3 pixel asks for; the mark therefore keeps the
    // source's aspect instead of being stretched.
    expect(HERO_ART_CELLS_PER_PIXEL).toBe(2)
    expect(HERO_ART_COLS).toBe(HERO_ART_WORDMARK_COLS * HERO_ART_CELLS_PER_PIXEL)
    expect(HERO_ART_ROWS).toBe(HERO_ART_WORDMARK_ROWS)
    expect(HERO_ART_FINE_COLS).toBe(HERO_ART_WORDMARK_FINE_COLS * HERO_ART_CELLS_PER_PIXEL)
    expect(HERO_ART_FINE_ROWS).toBe(HERO_ART_WORDMARK_FINE_ROWS)
    const cells = heroArtCells()
    expect(cells).toHaveLength(HERO_ART_ROWS)
    for (const line of cells) expect(line).toHaveLength(HERO_ART_COLS)
    const fine = heroArtFineCells()
    expect(fine).toHaveLength(HERO_ART_FINE_ROWS)
    for (const line of fine) expect(line).toHaveLength(HERO_ART_FINE_COLS)
  })

  test('gives both cells of a source pixel the SAME ink', () => {
    const inkOf = (tone: string): number => (tone === 'B' ? 0 : tone === 'M' ? 1 : -1)
    for (const [tones, cells] of [
      [HERO_ART_WORDMARK_TONES, heroArtCells()],
      [HERO_ART_WORDMARK_FINE_TONES, heroArtFineCells()],
    ] as const) {
      for (let r = 0; r < tones.length; r++) {
        for (let c = 0; c < tones[r]!.length; c++) {
          const want = inkOf(tones[r]![c]!)
          for (let k = 0; k < HERO_ART_CELLS_PER_PIXEL; k++) {
            expect(cells[r]![c * HERO_ART_CELLS_PER_PIXEL + k]!.ink, `(${r},${c})`).toBe(want)
          }
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
    for (const line of [...heroArtCells(), ...heroArtFineCells()]) {
      for (const cell of line) {
        expect(Object.keys(cell)).toEqual(['ink'])
        expect([-1, 0, 1]).toContain(cell.ink)
      }
    }
  })

  test('the drawn cells are the source pixels doubled, and nothing else', () => {
    for (const [tones, cells] of [
      [HERO_ART_WORDMARK_TONES, heroArtCells()],
      [HERO_ART_WORDMARK_FINE_TONES, heroArtFineCells()],
    ] as const) {
      const flat = cells.flat()
      const source = census(tones)
      expect(flat.filter((c) => c.ink === 1).length).toBe(source['M']! * HERO_ART_CELLS_PER_PIXEL)
      expect(flat.filter((c) => c.ink === 0).length).toBe(source['B']! * HERO_ART_CELLS_PER_PIXEL)
      expect(flat.filter((c) => c.ink === -1).length).toBe(source['.']! * HERO_ART_CELLS_PER_PIXEL)
    }
  })

  test('pads a short row instead of shifting the mark', () => {
    const [coarse] = heroArtCells(['BM'])
    expect(coarse).toHaveLength(HERO_ART_COLS)
    expect(coarse!.slice(0, 4).map((c) => c.ink)).toEqual([0, 0, 1, 1])
    for (const cell of coarse!.slice(4)) expect(cell.ink).toBe(-1)
    // The column count is a parameter, so the fine tier cannot be laid out on
    // the coarse width by accident.
    const [fine] = heroArtCells(['BM'], HERO_ART_WORDMARK_FINE_COLS)
    expect(fine).toHaveLength(HERO_ART_FINE_COLS)
    expect(fine!.slice(0, 4).map((c) => c.ink)).toEqual([0, 0, 1, 1])
    for (const cell of fine!.slice(4)) expect(cell.ink).toBe(-1)
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
    expect(HERO_ART_FINE_MIN_WIDTH).toBe(HERO_ART_FINE_COLS + HERO_ART_MARGIN_COLS)
    // The old ladder needed the terminal to measure `▄` as ONE column (it is
    // East-Asian-Ambiguous). Nothing in the art is a glyph now, so the decision
    // is pure geometry: the input carries no width input at all.
    expect(Object.keys(wide)).toEqual(['rows', 'width'])
  })

  test('prefers the FINE tier when it fits, and keeps the coarse one below it', () => {
    expect(heroArtMarkKind({ rows: 40, width: HERO_ART_FINE_MIN_WIDTH })).toBe('blocks-fine')
    expect(heroArtMarkKind({ rows: HERO_ART_FINE_MIN_ROWS, width: 200 })).toBe('blocks-fine')
    // One column short of the fine art: the coarse tier still draws the mark
    // (this is the band an 80-115 column terminal lives in).
    expect(heroArtMarkKind({ rows: 40, width: HERO_ART_FINE_MIN_WIDTH - 1 })).toBe('blocks')
    expect(heroArtMarkKind({ rows: 80, width: 80 })).toBe('blocks')
  })

  test('falls back on short or narrow terminals, then to nothing', () => {
    // 21 rows: too short for the 23-row coarse art AND for the 22-row ASCII mark.
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
    // 60 columns is below the ASCII wordmark's 80, but the coarse art is only 56.
    expect(HERO_ART_COLS).toBe(56)
    expect(heroArtMarkKind({ rows: 30, width: 60 })).toBe('blocks')
  })

  test('honors the DSH_TUI_HERO_ART override', () => {
    expect(heroArtMarkKind({ ...wide, mode: 'blocks' })).toBe('blocks')
    expect(heroArtMarkKind({ rows: 40, width: 200, mode: 'blocks' })).toBe('blocks-fine')
    expect(heroArtMarkKind({ rows: 40, width: 200, mode: 'blocks-fine' })).toBe('blocks-fine')
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
    expect(heroArtMode('fine')).toBe('blocks-fine')
    expect(heroArtMode('coarse')).toBe('blocks')
    expect(heroArtMode('text')).toBe('ascii')
    expect(heroArtMode('ascii')).toBe('ascii')
    expect(heroArtMode('off')).toBe('none')
    expect(heroArtMode('none')).toBe('none')
    expect(heroArtMode('glitter')).toBe('auto')
  })

  test('reports the rows each mark costs the hero stack', () => {
    expect(heroMarkRows('blocks')).toBe(HERO_ART_ROWS)
    expect(heroMarkRows('blocks-fine')).toBe(HERO_ART_FINE_ROWS)
    expect(heroMarkRows('ascii')).toBe(HERO_WORDMARK.length)
    expect(heroMarkRows('none')).toBe(0)
    // Both pixel-art tiers are TALLER than the ASCII fallback (12/6 vs 5 rows).
    expect(HERO_ART_ROWS).toBeGreaterThan(HERO_WORDMARK.length)
    expect(HERO_ART_FINE_ROWS).toBeGreaterThan(HERO_ART_ROWS)
  })
})
