/**
 * Tests for the hero BRAND ART: the generated `embedcode` pixel-art wordmark
 * (`hero-art.ts`, produced by `svg/gen-hero-art.py` from the workspace's
 * `svg/embedcode-{dark,light}.svg`), its half-block packing, its tone → theme
 * color ramp and the fallback ladder (art → ASCII wordmark → title only).
 *
 * The art is drawn with `▀`, which is East-Asian-Ambiguous, so the ladder's
 * `blockWidth` input is what keeps a 2-column terminal from overflowing the
 * hero — these tests pin that behavior.
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
} from '../packages/dsh-tui-app/src/hero-art.ts'
import {
  HERO_ART_CELL_GLYPH,
  HERO_ART_INK_ALPHA,
  HERO_ART_MARGIN_COLS,
  HERO_ART_MIN_ROWS,
  HERO_ART_MIN_WIDTH,
  HERO_ART_ROWS,
  HERO_ART_SHADOW_ALPHA,
  HERO_WORDMARK,
  heroArtCells,
  heroArtInkColors,
  heroArtMarkKind,
  heroArtMode,
  heroArtShadedTones,
  heroMarkRows,
} from '../packages/dsh-tui-app/src/hero-layout.ts'

describe('generated brand art table', () => {
  test('is the 48x12 tone grid rasterized from the 168x42 wordmark viewBox', () => {
    expect(HERO_ART_WORDMARK_TONES).toHaveLength(HERO_ART_WORDMARK_ROWS)
    expect(HERO_ART_WORDMARK_ROWS).toBe(12)
    expect(HERO_ART_WORDMARK_COLS).toBe(48)
    // 48:12 keeps the source's 168:42 (4:1) aspect, so the mark is not stretched.
    expect(HERO_ART_WORDMARK_COLS / HERO_ART_WORDMARK_ROWS).toBe(4)
    for (const row of HERO_ART_WORDMARK_TONES) expect(row).toHaveLength(HERO_ART_WORDMARK_COLS)
  })

  test('uses only the documented tone alphabet and every tone appears', () => {
    const joined = HERO_ART_WORDMARK_TONES.join('')
    expect(/^[.BMD]+$/.test(joined)).toBe(true)
    for (const tone of 'BMD') expect(joined.includes(tone)).toBe(true)
  })

  test('keeps the source top margin blank and letter gaps in every glyph row', () => {
    // The rasterized wordmark carries the SVG's own top margin; below it every
    // row keeps at least one empty cell, i.e. the letters stay separated.
    expect(HERO_ART_WORDMARK_TONES[0]).toBe('.'.repeat(HERO_ART_WORDMARK_COLS))
    for (const row of HERO_ART_WORDMARK_TONES.slice(1)) expect(row.includes('.')).toBe(true)
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

describe('half-block packing', () => {
  test('packs two design rows per terminal row', () => {
    const cells = heroArtCells()
    expect(cells).toHaveLength(HERO_ART_ROWS)
    expect(HERO_ART_ROWS).toBe(HERO_ART_WORDMARK_ROWS / 2)
    for (const line of cells) expect(line).toHaveLength(HERO_ART_WORDMARK_COLS)
    for (const line of cells) for (const cell of line) expect(' ▀▄█'.includes(cell.ch)).toBe(true)
  })

  test('the descender rides the last cell line as a solid block', () => {
    const line = heroArtCells()[HERO_ART_ROWS - 1]!
    const lastRow = HERO_ART_WORDMARK_TONES[HERO_ART_WORDMARK_ROWS - 1]!
    const columns = [...lastRow].flatMap((tone, index) => (tone === '.' ? [] : [index]))
    expect(columns.length).toBeGreaterThan(0)
    for (const c of columns) {
      // The same ink on the last two tone rows packs into one solid half-block.
      expect(line[c]!.ch).toBe('█')
      expect(line[c]!.fg).toBeGreaterThanOrEqual(0)
    }
  })

  test('maps each half to its own ink (both / upper / lower / empty)', () => {
    const [line] = heroArtCells(['B.', '.M', 'DD', 'BM'])
    expect(line!.map((c) => c.ch).join('')).toBe('▀▄')
    expect(line![0]).toEqual({ ch: '▀', fg: 0, bg: -1 })
    expect(line![1]).toEqual({ ch: '▄', fg: 1, bg: -1 })

    const [same] = heroArtCells(['DD', 'DD'])
    expect(same![0]).toEqual({ ch: '█', fg: 2, bg: -1 })

    const [diff] = heroArtCells(['BM', 'MD'])
    expect(diff![0]).toEqual({ ch: '▀', fg: 0, bg: 1 })
    // The `D` under the `M` half IS the secondary ink's shadow (index 3), not a
    // third ink: shadows belong to the stroke they hang from.
    expect(diff![1]).toEqual({ ch: '▀', fg: 1, bg: 3 })

    const [empty] = heroArtCells(['..', '..'])
    expect(empty![0]).toEqual({ ch: ' ', fg: -1, bg: -1 })
  })

  test('drops a trailing unpaired row and tolerates ragged input', () => {
    expect(heroArtCells(['B'])).toHaveLength(0)
    expect(heroArtCells(['B', 'B', 'B'])).toHaveLength(1)
    // Ragged input pads the SHORT row with empty halves (width = widest row).
    const [ragged] = heroArtCells(['BMD', 'B'])
    expect(ragged).toHaveLength(3)
    expect(ragged![2]).toEqual({ ch: '▀', fg: 2, bg: -1 })
  })
})

describe('anti-aliased edge -> shadow (opencode shading, 2026-09-15)', () => {
  const census = (grid: readonly string[]): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const row of grid) for (const tone of row) out[tone] = (out[tone] ?? 0) + 1
    return out
  }
  const body = (grid: readonly string[], y: number, x: number): boolean =>
    grid[y]?.[x] === 'B' || grid[y]?.[x] === 'M'

  test('keeps only the shadow that does a job, and drops the rest of the edge', () => {
    const src = census(HERO_ART_WORDMARK_TONES)
    const out = census(heroArtShadedTones())
    // Only the `D` cells change; the two inks are untouched.
    expect(out['B']).toBe(src['B'])
    expect(out['M']).toBe(src['M'])
    expect(src['D']).toBe(139)
    // 30 letter-counter fills + 45 cells under ink (37 of them the edge itself,
    // 8 empty) survive; 90 outline cells are dropped.
    expect(out['D']).toBe(75)
    expect(out['.']).toBe(src['.']! + 90 - 26)
  })

  test('the grey row ABOVE the wordmark is gone (the reported ghost)', () => {
    const src = HERO_ART_WORDMARK_TONES
    const out = heroArtShadedTones()
    // The rasterizer's top edge row sits directly above the first ink row.
    expect(src[1]!.replace(/\./gu, '')).not.toBe('')
    expect(out[1]!.replace(/\./gu, '')).toBe('')
    // …and nothing else moved: the ink rows themselves are untouched.
    for (let y = 2; y < src.length; y++) {
      for (let x = 0; x < src[y]!.length; x++) {
        if (body(src, y, x)) expect(out[y]![x], `(${y},${x})`).toBe(src[y]![x])
      }
    }
  })

  test('a kept edge cell is enclosed by the mark or sits under ink — never both-ish', () => {
    const src = HERO_ART_WORDMARK_TONES
    const out = heroArtShadedTones()
    const height = src.length
    const width = src[0]!.length
    // Independent flood fill of the outside over non-body cells.
    const outside = src.map(() => new Array<boolean>(width).fill(false))
    const stack: [number, number][] = []
    const visit = (y: number, x: number): void => {
      if (y < 0 || y >= height || x < 0 || x >= width) return
      if (outside[y]![x] || body(src, y, x)) return
      outside[y]![x] = true
      stack.push([y, x])
    }
    for (let x = 0; x < width; x++) { visit(0, x); visit(height - 1, x) }
    for (let y = 0; y < height; y++) { visit(y, 0); visit(y, width - 1) }
    while (stack.length > 0) {
      const [y, x] = stack.pop()!
      visit(y - 1, x); visit(y + 1, x); visit(y, x - 1); visit(y, x + 1)
    }
    let kept = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const wanted = !body(src, y, x) && (!outside[y]![x] || (y > 0 && body(src, y - 1, x)))
        expect(out[y]![x] === 'D', `(${y},${x})`).toBe(wanted)
        if (wanted) kept += 1
      }
    }
    expect(kept).toBe(75)
  })

  test('the shadow slot follows the stroke it hangs from', () => {
    const cellOf = (grid: readonly string[]): unknown => heroArtCells(grid)[0]![0]
    // Under an `M` stroke: the secondary shadow (3); under `B`: the primary (2).
    expect(cellOf(['M', 'D'])).toEqual({ ch: '▀', fg: 1, bg: 3 })
    expect(cellOf(['B', 'D'])).toEqual({ ch: '▀', fg: 0, bg: 2 })
    // No body anywhere in the column: the primary shadow is the safe default.
    expect(cellOf(['.', 'D'])).toEqual({ ch: '▄', fg: 2, bg: -1 })
    // The generated grid resolves BOTH slots (40 + 35 shadow pixels).
    const cells = heroArtCells()
    const halves = new Set<number>()
    for (const line of cells) for (const cell of line) {
      if (cell.fg >= 2) halves.add(cell.fg)
      if (cell.bg >= 2) halves.add(cell.bg)
    }
    expect([...halves].sort()).toEqual([2, 3])
  })
})

describe('ink palette', () => {
  test('is the SVG two-ink design plus a 25% shadow of each ink', () => {
    expect(HERO_ART_INK_ALPHA).toEqual({ primary: 1, secondary: 0.7 })
    expect(HERO_ART_SHADOW_ALPHA).toBe(0.25)
    expect(heroArtInkColors('#ffffff', '#000000')).toEqual(['#ffffff', '#b3b3b3', '#404040', '#2d2d2d'])
    expect(heroArtInkColors('#000000', '#ffffff')).toEqual(['#000000', '#4d4d4d', '#bfbfbf', '#d3d3d3'])
    // The default dark theme's four inks (the approved preview's colors).
    expect(heroArtInkColors('#f9fafb', '#151517')).toEqual(['#f9fafb', '#b5b5b7', '#4e4e50', '#3d3d3f'])
  })

  test('primary ink IS the theme text color, and the inks order away from the bg', () => {
    const [text, bg] = ['#f9fafb', '#151517']
    const inks = heroArtInkColors(text, bg)
    expect(inks[0]).toBe(text)
    const distance = (hex: string): number => {
      const rgb = (h: string): number[] => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16))
      const a = rgb(hex)
      const b = rgb(bg)
      return a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0)
    }
    const d = inks.map((ink) => distance(ink!))
    for (let i = 1; i < d.length; i++) expect(d[i - 1]!).toBeGreaterThan(d[i]!)
  })

  test('accepts #rgb shorthand and survives junk input', () => {
    expect(heroArtInkColors('#fff', '#000')[0]).toBe('#ffffff')
    expect(heroArtInkColors('nonsense', '#000')).toHaveLength(4)
  })
})

describe('mark selection ladder', () => {
  const wide = { rows: 30, width: 100, blockWidth: 1 }

  test('picks the art when it fits on a one-column-wide terminal', () => {
    expect(heroArtMarkKind(wide)).toBe('blocks')
    expect(HERO_ART_CELL_GLYPH).toBe('▀')
    expect(HERO_ART_MIN_WIDTH).toBe(HERO_ART_WORDMARK_COLS + HERO_ART_MARGIN_COLS)
  })

  test('falls back to the ASCII wordmark when the block glyph is two columns', () => {
    expect(heroArtMarkKind({ ...wide, blockWidth: 2 })).toBe('ascii')
    expect(heroArtMarkKind({ ...wide, blockWidth: 0 })).toBe('ascii')
  })

  test('falls back on short or narrow terminals, then to nothing', () => {
    // 21 rows: too short for the 23-row art AND for the 22-row ASCII mark.
    expect(heroArtMarkKind({ rows: 21, width: 100, blockWidth: 1 })).toBe('none')
    expect(heroArtMarkKind({ rows: HERO_ART_MIN_ROWS, width: 100, blockWidth: 1 })).toBe('blocks')
    // The band between the two gates: too short for the art, but the shorter
    // ASCII fallback still fits.
    expect(heroArtMarkKind({ rows: 22, width: 100, blockWidth: 1 })).toBe('ascii')
    // Just below the art's width the ASCII mark cannot help either (it needs 80).
    expect(heroArtMarkKind({ rows: 30, width: HERO_ART_MIN_WIDTH - 1, blockWidth: 1 })).toBe('none')
    // Too small for even the ASCII wordmark (needs 22 rows / 80 columns).
    expect(heroArtMarkKind({ rows: 20, width: 60, blockWidth: 2 })).toBe('none')
    expect(heroArtMarkKind({ rows: 30, width: 40, blockWidth: 1 })).toBe('none')
  })

  test('the art reaches narrower terminals than the ASCII fallback needs', () => {
    // 60 columns is below the ASCII wordmark's 80, but the art is only 45 wide.
    expect(heroArtMarkKind({ rows: 30, width: 60, blockWidth: 1 })).toBe('blocks')
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
    // The rasterized wordmark is TALLER than the ASCII fallback (6 vs 5 rows) —
    // it used to be 4, which is why HERO_ART_MIN_ROWS moved 21 -> 23.
    expect(HERO_ART_ROWS).toBeGreaterThan(HERO_WORDMARK.length)
  })
})
