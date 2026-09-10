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
  HERO_ART_MARGIN_COLS,
  HERO_ART_MIN_ROWS,
  HERO_ART_MIN_WIDTH,
  HERO_ART_ROWS,
  HERO_ART_TONE_ALPHA,
  HERO_WORDMARK,
  heroArtCells,
  heroArtInkColors,
  heroArtMarkKind,
  heroArtMode,
  heroMarkRows,
} from '../packages/dsh-tui-app/src/hero-layout.ts'

describe('generated brand art table', () => {
  test('is the 45x8 design-pixel wordmark on the 6px source grid', () => {
    expect(HERO_ART_WORDMARK_TONES).toHaveLength(HERO_ART_WORDMARK_ROWS)
    expect(HERO_ART_WORDMARK_ROWS).toBe(8)
    expect(HERO_ART_WORDMARK_COLS).toBe(45)
    for (const row of HERO_ART_WORDMARK_TONES) expect(row).toHaveLength(HERO_ART_WORDMARK_COLS)
  })

  test('uses only the documented tone alphabet and every tone appears', () => {
    const joined = HERO_ART_WORDMARK_TONES.join('')
    expect(/^[.BMD]+$/.test(joined)).toBe(true)
    for (const tone of 'BMD') expect(joined.includes(tone)).toBe(true)
  })

  test('is a legible mark: blank top/bottom rows, six glyph rows in between', () => {
    expect(HERO_ART_WORDMARK_TONES[0]).toBe('.'.repeat(HERO_ART_WORDMARK_COLS))
    expect(HERO_ART_WORDMARK_TONES[HERO_ART_WORDMARK_ROWS - 1]).toBe('.'.repeat(HERO_ART_WORDMARK_COLS))
    const glyphRows = HERO_ART_WORDMARK_TONES.slice(1, -1)
    expect(glyphRows).toHaveLength(6)
    for (const row of glyphRows) expect(row.includes('.')).toBe(true) // letter gaps
  })

  test('records its provenance (both variant SVGs + their sha256)', () => {
    expect(HERO_ART_SOURCES.dark).toBe('svg/embedcode-dark.svg')
    expect(HERO_ART_SOURCES.light).toBe('svg/embedcode-light.svg')
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

  test('the ascender dots of b/d ride the first row as lower-half cells', () => {
    const first = heroArtCells()[0]!
    const lower = first.filter((c) => c.ch === '▄')
    expect(lower).toHaveLength(3)
    // `▄` paints the LOWER half only: foreground tone, no background.
    for (const cell of lower) {
      expect(cell.fg).toBeGreaterThanOrEqual(0)
      expect(cell.bg).toBe(-1)
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
    expect(diff![1]).toEqual({ ch: '▀', fg: 1, bg: 2 })

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

describe('tone -> theme ink ramp', () => {
  test('blends theme.text toward theme.bg per the documented alphas', () => {
    expect(HERO_ART_TONE_ALPHA).toEqual([1, 0.55, 0.25])
    expect(heroArtInkColors('#ffffff', '#000000')).toEqual(['#ffffff', '#8c8c8c', '#404040'])
    expect(heroArtInkColors('#000000', '#ffffff')).toEqual(['#000000', '#737373', '#bfbfbf'])
  })

  test('primary ink IS the theme text color, and D sits closest to the bg', () => {
    const [text, bg] = ['#f9fafb', '#151517']
    const inks = heroArtInkColors(text, bg)
    expect(inks[0]).toBe(text)
    const distance = (hex: string): number => {
      const rgb = (h: string): number[] => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16))
      const a = rgb(hex)
      const b = rgb(bg)
      return a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0)
    }
    expect(distance(inks[0]!)).toBeGreaterThan(distance(inks[1]!))
    expect(distance(inks[1]!)).toBeGreaterThan(distance(inks[2]!))
  })

  test('accepts #rgb shorthand and survives junk input', () => {
    expect(heroArtInkColors('#fff', '#000')[0]).toBe('#ffffff')
    expect(heroArtInkColors('nonsense', '#000')).toHaveLength(3)
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
    // 20 rows: too short for the 21-row art AND for the 22-row ASCII mark.
    expect(heroArtMarkKind({ rows: HERO_ART_MIN_ROWS - 1, width: 100, blockWidth: 1 })).toBe('none')
    expect(heroArtMarkKind({ rows: HERO_ART_MIN_ROWS, width: 100, blockWidth: 1 })).toBe('blocks')
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
    expect(HERO_ART_ROWS).toBeLessThan(HERO_WORDMARK.length)
  })
})
