/**
 * Unit tests for the colour-depth module (`packages/dsh-tui-app/src/
 * color-depth.ts`) — the fix for "the composer card merges into the page".
 *
 * The bug (reported on Ubuntu 24.04): the terminal speaks 24-bit colour but
 * exports no `COLORTERM`, so chalk drops to level 2 and converts our hexes with
 * its own cube rounding, under which `theme.bg` and `theme.element` landed on the
 * SAME index in five of the sixteen registered schemes. We now do the level-2
 * mapping ourselves.
 *
 * Run with `bun test tests/color-depth.test.ts`.
 *
 * @module dsh-tui/color-depth-test
 */

import { describe, expect, test, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  ANSI256_RGB, FILL_KEYS, REACHABLE_ENTRIES, colorLevel, colorOverride, cubeRound, nearestEntry,
  parseHex, quantizePalette, rgbDistance, rgbToHex,
} from '../packages/dsh-tui-app/src/color-depth.ts'
import { BUILTIN_SCHEMES, DEFAULT_SCHEME, applyScheme, schemeRegistry } from '../packages/dsh-tui-app/src/theme-plugin.ts'
import { theme } from '../packages/dsh-tui-app/src/theme.ts'

afterEach(() => { applyScheme(DEFAULT_SCHEME) })

describe('colorLevel', () => {
  test('DSH_TUI_COLOR overrides everything', () => {
    expect(colorLevel({ DSH_TUI_COLOR: '24bit', TERM: 'xterm-256color' })).toBe(3)
    expect(colorLevel({ DSH_TUI_COLOR: '256', TERM: 'xterm-kitty' })).toBe(2)
    expect(colorLevel({ DSH_TUI_COLOR: '16', COLORTERM: 'truecolor' })).toBe(1)
    expect(colorLevel({ DSH_TUI_COLOR: ' 256 ' })).toBe(2)
  })

  test('follows chalk/supports-color otherwise', () => {
    // Exactly `truecolor` — `24bit` is NOT accepted (measured behavior of the
    // vendored supports-color, and the reason the bug hid on some terminals).
    expect(colorLevel({ COLORTERM: 'truecolor' })).toBe(3)
    expect(colorLevel({ COLORTERM: '24bit' })).toBe(1)
    expect(colorLevel({ TERM: 'xterm-kitty' })).toBe(3)
    expect(colorLevel({ TERM: 'xterm-256color' })).toBe(2)
    expect(colorLevel({ TERM: 'screen-256color' })).toBe(2)
    // Ubuntu 24.04's terminal: capable of 24-bit, advertises nothing.
    expect(colorLevel({ TERM: 'xterm-256color', COLORTERM: '' })).toBe(2)
    expect(colorLevel({ TERM: 'vt100' })).toBe(1)
    expect(colorLevel({})).toBe(1)
  })
})

describe('the Ink-side override table cannot drift', () => {
  // The SGR form is chosen by code injected into Ink's output.js, in a bundle
  // that owns the chalk instance (see the note on `colorOverride`). That copy
  // duplicates the `DSH_TUI_COLOR` table, so this test extracts it from the build
  // script and compares — the duplication is intentional, its drift is not.
  const source = readFileSync(new URL('../apps/tui-bin/build.mjs', import.meta.url), 'utf8')
  const body = /const __dshColorOverride = \(env\) => \{([\s\S]*?)\n\};/.exec(source)?.[1]

  test('the snippet is present and wired into __dshLevel', () => {
    expect(body, '__dshColorOverride must exist in apps/tui-bin/build.mjs').toBeDefined()
    // Removing the assignment would silently strand the override at palette level.
    expect(source).toContain('chalk.level = forced')
  })

  test('both tables answer identically for every spelling', () => {
    const build = new Function('env', body!) as (env: Record<string, string>) => number | null
    for (const value of ['24bit', 'truecolor', '256', '16', '', '  256 ', 'TRUEcolor', 'nonsense', '24']) {
      const env = { DSH_TUI_COLOR: value }
      expect(build(env), `build side: ${JSON.stringify(value)}`).toBe(colorOverride(env))
      if (colorOverride(env) !== null) {
        expect(colorLevel(env), `both sides agree: ${JSON.stringify(value)}`).toBe(build(env)!)
      }
    }
    // Unset must mean "chalk decides", not some level.
    expect(build({})).toBeNull()
    expect(build({ DSH_TUI_COLOR: '256' })).toBe(2)
  })
})

describe('hex helpers', () => {
  test('parseHex accepts #rgb and #rrggbb, rejects the rest', () => {
    expect(parseHex('#151517')).toEqual([21, 21, 23])
    expect(parseHex('#fff')).toEqual([255, 255, 255])
    expect(parseHex('#abc')).toEqual([170, 187, 204])
    expect(parseHex('151517')).toEqual([21, 21, 23])
    // Alpha is tolerated and dropped (the caller keeps such colours unmapped).
    expect(parseHex('#11223380')).toEqual([17, 34, 51])
    expect(parseHex('currentColor')).toBeNull()
    expect(parseHex('#12345')).toBeNull()
    expect(parseHex('')).toBeNull()
  })

  test('rgbToHex round-trips parseHex', () => {
    for (const hex of ['#000000', '#151517', '#fafafa', '#679efe', '#f7ad31']) {
      expect(rgbToHex(parseHex(hex)!)).toBe(hex)
    }
  })
})

describe('palette table', () => {
  test('256 entries, the documented anchors present', () => {
    expect(ANSI256_RGB).toHaveLength(256)
    expect(ANSI256_RGB[16]).toEqual([0, 0, 0])
    expect(ANSI256_RGB[231]).toEqual([255, 255, 255])
    expect(ANSI256_RGB[232]).toEqual([8, 8, 8])
    expect(ANSI256_RGB[255]).toEqual([238, 238, 238])
    expect(ANSI256_RGB[196]).toEqual([255, 0, 0])
  })

  test('cubeRound mirrors the terminal-side converter', () => {
    // Greys take the 24-step ramp, colours the 6x6x6 cube — this is what makes
    // "we chose index N" verifiable.
    expect(cubeRound([0, 0, 0])).toBe(16)
    expect(cubeRound([255, 255, 255])).toBe(231)
    expect(cubeRound([8, 8, 8])).toBe(232)
    // The palette's base-16 entries share their RGB with a cube/grey entry (0 and
    // 16 are both black, 15 and 231 both white), so the canonical resolver for a
    // hex is `cubeRound`, not a lookup of the first matching index.
    expect(cubeRound([128, 0, 0])).toBe(124)
    expect(cubeRound([255, 0, 0])).toBe(196)
    expect(cubeRound([238, 238, 238])).toBe(254)
  })

  test('only reachable entries are offered, and enough of them exist', () => {
    // 86 of 256 (measured). The palette is what the terminal actually paints:
    // `cubeRound(hex)` decides, so an entry is reachable when some hex converts
    // to it — either its own RGB (80 entries round-trip) or a neighbouring grey
    // (the top six steps 250-255).
    expect(REACHABLE_ENTRIES).toHaveLength(86)
    for (const entry of REACHABLE_ENTRIES) {
      expect(cubeRound(parseHex(entry.hex)!), `${entry.index} via ${entry.hex}`).toBe(entry.index)
      expect(ANSI256_RGB[entry.index], `index ${entry.index}`).toBeDefined()
    }
    // Every grey-ramp step is reachable, which is where near-neutral surfaces
    // belong — including the top six, whose own RGB does NOT round-trip (the
    // ramp's spacing is 10, the converter's 247/24 ≈ 10.29) but which we reach by
    // storing the neighbouring value: 255 is painted by storing #f0f0f0.
    for (let index = 232; index <= 255; index++) {
      expect(REACHABLE_ENTRIES.map((e) => e.index), `grey ${index}`).toContain(index)
    }
    const top = REACHABLE_ENTRIES.find((e) => e.index === 255)!
    expect(top.hex).toBe('#f0f0f0')
    expect(cubeRound(ANSI256_RGB[255]!)).not.toBe(255)
    // Entries the converter can never land on are absent: the base-16 set (its
    // colours are absorbed by the cube) and the neutral cube entries (swallowed
    // by the converter's grey branch).
    expect(REACHABLE_ENTRIES.map((e) => e.index)).not.toContain(23)
    expect(REACHABLE_ENTRIES.map((e) => e.index)).not.toContain(1)
    expect(REACHABLE_ENTRIES.map((e) => e.index)).not.toContain(196 - 100)
  })

  test('rgbDistance weights green above red above blue', () => {
    const base = parseHex('#404040')!
    // Equal per-channel deltas: green costs most (4), blue least (3).
    expect(rgbDistance(base, [72, 64, 64])).toBeLessThan(rgbDistance(base, [64, 64, 72])!)
    expect(rgbDistance(base, [64, 64, 72])).toBeLessThan(rgbDistance(base, [64, 72, 64])!)
    expect(rgbDistance(base, base)).toBe(0)
  })
})

describe('nearestEntry', () => {
  test('the measured dark ramp lands where the design says', () => {
    expect(nearestEntry(parseHex('#151517')!)?.index).toBe(233)
    expect(nearestEntry(parseHex('#1b1b1c')!)?.index).toBe(234)
    expect(nearestEntry(parseHex('#2c2c2e')!)?.index).toBe(236)
  })

  test('near-neutral light colours stay on the grey ramp', () => {
    // The trap this model exists for: demanding that the stored hex round-trips
    // through its OWN RGB made the top of the grey ramp unusable, and the light
    // scheme's `element` #e6e6e6 then became pink #ffd7d7.
    const entry = nearestEntry(parseHex('#e6e6e6')!)!
    expect(entry.hex).toBe('#e6e6e6')
    expect(ANSI256_RGB[entry.index]![0]).toBe(ANSI256_RGB[entry.index]![1])
    expect(cubeRound(parseHex(entry.hex)!)).toBe(entry.index)
  })

  test('avoid skips a taken entry instead of colliding', () => {
    const rgb = parseHex('#151517')!
    const first = nearestEntry(rgb)!
    const second = nearestEntry(rgb, new Set([first.index]))!
    expect(second.index).not.toBe(first.index)
    expect(REACHABLE_ENTRIES.map((e) => e.index)).toContain(second.index)
  })
})

describe('quantizePalette', () => {
  test('level 3 and level 1 are identity; level 2 reports its changes', () => {
    const source = { ...BUILTIN_SCHEMES[DEFAULT_SCHEME] } as Record<string, string>
    const untouched = { ...source }
    expect(quantizePalette(untouched, 3)).toBe(0)
    expect(untouched).toEqual(source)
    const sixteen = { ...source }
    expect(quantizePalette(sixteen, 1)).toBe(0)
    expect(sixteen).toEqual(source)
    const quantized = { ...source }
    expect(quantizePalette(quantized, 2)).toBeGreaterThan(0)
    expect(quantized.bg).not.toBe(source.bg)
  })

  test('level 2 snaps every colour onto a reachable entry', () => {
    const palette = { ...BUILTIN_SCHEMES[DEFAULT_SCHEME] } as Record<string, string>
    quantizePalette(palette, 2)
    for (const [key, hex] of Object.entries(palette)) {
      const entry = REACHABLE_ENTRIES.find((e) => e.hex === hex)
      expect(entry, `${key} = ${hex}`).toBeDefined()
      expect(cubeRound(parseHex(hex)!), `${key} = ${hex} (entry ${entry!.index})`).toBe(entry!.index)
    }
  })

  test('a light scheme keeps its grey ladder (no chroma-tinted surfaces)', () => {
    // Measured before the model was corrected: `light` came out with a pink
    // panel/element. A light scheme's surfaces must stay NEUTRAL at level 2.
    const palette = { ...BUILTIN_SCHEMES.light } as Record<string, string>
    quantizePalette(palette, 2)
    for (const key of ['bg', 'panel', 'element', 'borderSubtle']) {
      const [r, g, b] = parseHex(palette[key]!)!
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${key} = ${palette[key]}`).toBeLessThanOrEqual(2)
    }
    expect(palette).toMatchObject({ bg: '#ffffff', panel: '#f0f0f0', element: '#e6e6e6' })
  })

  test('mapping is idempotent (a second pass changes nothing)', () => {
    const palette = { ...BUILTIN_SCHEMES.kanagawa } as Record<string, string>
    quantizePalette(palette, 2)
    const once = { ...palette }
    expect(quantizePalette(palette, 2)).toBe(0)
    expect(palette).toEqual(once)
  })

  test('alpha colours are left alone (snapping would change their meaning)', () => {
    const palette = { bg: '#15151780', text: '#ffffff' }
    quantizePalette(palette, 2)
    expect(palette.bg).toBe('#15151780')
  })

  test('a palette key that is not a hex is tolerated', () => {
    const palette = { bg: 'inherit', element: '#2c2c2e' }
    expect(() => quantizePalette(palette, 2)).not.toThrow()
    expect(palette.bg).toBe('inherit')
  })

  /** Every scheme the picker offers, at level 2: the page and the composer
   *  card's fill must stay different colours — this is the reported bug. */
  test('THE FIX: no scheme collapses bg/element at level 2', () => {
    for (const name of Object.keys(schemeRegistry())) {
      const palette = { ...schemeRegistry()[name]! } as Record<string, string>
      quantizePalette(palette, 2)
      expect(palette.bg, name).not.toBe(palette.element)
    }
  })

  test('the three FILLS are pairwise distinct at level 2, in all schemes', () => {
    for (const name of Object.keys(schemeRegistry())) {
      const palette = { ...schemeRegistry()[name]! } as Record<string, string>
      quantizePalette(palette, 2)
      const values = FILL_KEYS.map((key) => palette[key]!)
      expect(new Set(values).size, `${name}: ${values.join(' ')}`).toBe(values.length)
    }
  })

  test('borders are mapped to nearest, NOT forced apart from the fills', () => {
    // `solarized-light` paints all four non-bg roles #eee8d5; forcing a distinct
    // entry for its borders invented a PINK hairline (measured #ffd7d7). A theme
    // that makes a border equal to a fill means "no visible frame", so the mapped
    // border may repeat a fill but must stay neutral here.
    const palette = { ...BUILTIN_SCHEMES['solarized-light']! } as Record<string, string>
    quantizePalette(palette, 2)
    for (const key of ['borderSubtle', 'border']) {
      const [r, g, b] = parseHex(palette[key]!)!
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${key} = ${palette[key]}`).toBeLessThanOrEqual(2)
    }
    expect(palette.borderSubtle).toBe(palette.border)
    // …while the fills next to them are still all different.
    expect(new Set(FILL_KEYS.map((k) => palette[k]!)).size).toBe(3)
  })

  test('the five schemes that used to collapse bg onto element', () => {
    // Measured collisions under chalk's own level-2 conversion; the new mapping
    // must not reproduce them.
    for (const name of ['kanagawa', 'everforest', 'panda', 'solarized', 'solarized-light']) {
      const palette = { ...schemeRegistry()[name]! } as Record<string, string>
      quantizePalette(palette, 2)
      expect(palette.bg, name).not.toBe('#5f5f5f')
      expect(palette.element, name).not.toBe(palette.bg)
      // …and the PAINTED colours (what cubeRound makes of the stored hex) differ
      expect(cubeRound(parseHex(palette.element)!), name).not.toBe(cubeRound(parseHex(palette.bg)!))
    }
  })
})

describe('applyScheme wiring', () => {
  test('a 256-colour terminal gets the quantized palette on the shared object', () => {
    // The env flip and the assertions are synchronous, so no other test file can
    // observe the temporary override.
    const previous = process.env.DSH_TUI_COLOR
    try {
      process.env.DSH_TUI_COLOR = '256'
      applyScheme('kanagawa')
      const expected = { ...BUILTIN_SCHEMES.kanagawa } as Record<string, string>
      quantizePalette(expected, 2)
      expect(theme.bg).toBe(expected.bg)
      expect(theme.element).toBe(expected.element)
      expect(theme.bg).not.toBe(theme.element)
    } finally {
      if (previous === undefined) delete process.env.DSH_TUI_COLOR
      else process.env.DSH_TUI_COLOR = previous
    }
  })

  test('per-role overrides are quantized too (they bypass the scheme)', () => {
    const previous = process.env.DSH_TUI_COLOR
    try {
      process.env.DSH_TUI_COLOR = '256'
      applyScheme('dark', { accent: '#ff8800' })
      const expected = { accent: '#ff8800' } as Record<string, string>
      quantizePalette(expected, 2)
      expect(theme.accent).toBe(expected.accent)
    } finally {
      if (previous === undefined) delete process.env.DSH_TUI_COLOR
      else process.env.DSH_TUI_COLOR = previous
    }
  })

  test('the unit suite preload pins 24-bit, so tests see authored hexes', () => {
    expect(process.env.DSH_TUI_COLOR).toBe('24bit')
    applyScheme('light')
    expect(theme.bg).toBe(BUILTIN_SCHEMES.light.bg)
  })
})
