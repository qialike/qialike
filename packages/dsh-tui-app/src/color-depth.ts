/**
 * Colour depth: what the terminal can actually show, and what we hand it.
 *
 * The theme palette is authored in hex, and Ink renders hex through chalk. That
 * is safe at colour level 3 (24-bit): the hex goes out unchanged. At level 2
 * chalk converts the hex with `rgbToAnsi256` — a 6x6x6 CUBE rounding whose only
 * near-black entries are 0 and 95 — so `#151517` became pure black and `#2c2c2e`
 * became `#5f5f5f`. Worse, whole palettes collapsed: in five of the built-in
 * schemes `theme.bg` and `theme.element` (the page and the composer card's fill)
 * landed on the SAME index, so the hero's input box merged into the background
 * (user report, Ubuntu 24.04 — its terminal is 24-bit capable but exports no
 * `COLORTERM`, so chalk dropped to level 2).
 *
 * Fix: at level 2 the palette is ours to map. We snap every colour to the nearest
 * entry of the 256-colour palette by a perceptually weighted distance, and — the
 * part that actually removes the bug — force the three FILLS (`bg`, `panel`,
 * `element`) onto pairwise-DISTINCT entries, because "nearest" alone still
 * collides when two theme colours are closer to each other than the palette's own
 * step. Borders are mapped but not forced apart (see {@link FILL_KEYS}).
 *
 * What "nearest" can mean here needs care, because we do NOT get to pick the
 * index: we hand chalk a hex, chalk converts it with `cubeRound`, and the terminal
 * paints the palette entry that conversion lands on. So the colour the user sees
 * for a stored hex H is `RGB(cubeRound(H))`, and the reachable entries are the
 * IMAGE of `cubeRound` — not the entries that round-trip through their own RGB.
 * Requiring an entry to round-trip through its OWN RGB is a mistake: the six
 * brightest grey steps (250-255) do not (the ramp's spacing is 10, the converter's
 * 247/24 ≈ 10.29), yet each is reachable by storing a neighbouring hex. Filtering
 * them out pushed light schemes off the grey ramp and onto chroma-tinted cube
 * entries — measured: the `light` scheme's `element` `#e6e6e6` became pink
 * `#ffd7d7`. So an entry is represented by
 * `{index, hex}`: the index is what the user sees, and `hex` is an input that
 * converts to it (the entry's own RGB when that round-trips, otherwise the
 * closest grey input). The stored hex can therefore sit a few units away from the
 * painted colour (≤10/255, e.g. `#f0f0f0` paints `#eeeeee`), which keeps every
 * consumer that parses the palette working — the hero art, the tint maths — and is
 * invisible on screen.
 *
 * 86 of the 256 entries are reachable (measured); the palette below carries only
 * those, so the search can never ask for a colour the terminal would not show.
 *
 * Level 3 is identity (no change at all). Level 1 (16 colours) is left alone:
 * measured with chalk, every dark hex maps to black (SGR 30 as a foreground, 40 as
 * a background) there, so distinct surfaces are impossible without inventing
 * coloured panels; that mode is documented instead of faked.
 *
 * @module @yourname/dsh-tui-app/color-depth
 */

/** What the terminal can show: 1 = 16 colours, 2 = 256, 3 = 24-bit. */
export type ColorLevel = 1 | 2 | 3

/** `rgb` triple, 0-255 per channel. */
export type Rgb = readonly [number, number, number]

/** The FILLS that must never merge: the page, the raised panels (dialogs, sidebar)
 *  and the element surface (composer card, inline code) — a card or dialog that
 *  dissolves into the page is the reported bug.
 *
 *  Borders are deliberately NOT in this set: a theme that paints a border the same
 *  as its panel or page means "no visible frame", and forcing a distinct entry
 *  invents a colour the author never chose — measured on `solarized-light`, whose
 *  four non-`bg` roles are all `#eee8d5`, where the exclusion turned `borderSubtle`
 *  into a pink hairline. Borders therefore take their nearest entry like any other
 *  colour, even if that repeats a fill. */
export const FILL_KEYS: readonly string[] = ['bg', 'panel', 'element']

/** Parse `#rgb` / `#rrggbb` (an `#rrggbbaa` alpha suffix is accepted and ignored).
 *  @returns the channels, or null for anything else (the caller leaves it alone). */
export function parseHex(hex: string): Rgb | null {
  const h = hex.trim().replace(/^#/u, '')
  const body = h.length === 3 || h.length === 4
    ? h.slice(0, 3).split('').map((c) => c + c).join('')
    : h.slice(0, 6)
  if (!/^[0-9a-fA-F]{6}$/u.test(body)) return null
  const int = Number.parseInt(body, 16)
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff]
}

/** Format channels as `#rrggbb` (lowercase). */
export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}

/**
 * The explicit `DSH_TUI_COLOR` override, or null when it is unset/unrecognised.
 *
 * This table exists separately from {@link colorLevel} because it has to be
 * honoured in TWO bundles: this one decides whether the palette is pre-mapped,
 * while the SGR form is chosen by the code Injected into Ink's `output.js`
 * (`apps/tui-bin/build.mjs`, `__dshLevel`) — that copy owns the chalk instance
 * Ink colorizes with, so a palette-side override alone renders unmapped hexes at
 * level 2, which is the very collapse we are fixing. `tests/color-depth.test.ts`
 * extracts the build-side snippet and fails if the two tables ever drift.
 *
 * The terminal cannot be asked whether it speaks 24-bit (there is no such query,
 * and the reported Ubuntu 24.04 terminal is capable while exporting nothing),
 * hence an override at all.
 * @param env - environment to read (injected in tests).
 * @returns 3 (24-bit), 2 (256), 1 (16) or null.
 */
export function colorOverride(env: NodeJS.ProcessEnv = process.env): ColorLevel | null {
  const override = (env.DSH_TUI_COLOR ?? '').trim().toLowerCase()
  if (override === '24bit' || override === 'truecolor') return 3
  if (override === '256') return 2
  if (override === '16') return 1
  return null
}

/**
 * Which colour depth this process should render for.
 *
 * `DSH_TUI_COLOR` wins when set (see {@link colorOverride}); otherwise the rules
 * mirror chalk's vendored supports-color, including the measured detail that
 * `COLORTERM=24bit` is NOT treated as 24-bit (only the exact string `truecolor`,
 * or `TERM=xterm-kitty`).
 * @param env - environment to read (injected in tests).
 * @returns 1, 2 or 3.
 */
export function colorLevel(env: NodeJS.ProcessEnv = process.env): ColorLevel {
  const override = colorOverride(env)
  if (override !== null) return override
  const term = env.TERM ?? ''
  if (env.COLORTERM === 'truecolor' || term === 'xterm-kitty') return 3
  if (/256color|truecolor/iu.test(term)) return 2
  return 1
}

const CUBE = [0, 95, 135, 175, 215, 255] as const

/** The 256 xterm colours as RGB (16 system + 6x6x6 cube + 24 grey steps). */
export const ANSI256_RGB: readonly Rgb[] = (() => {
  const base: Rgb[] = [
    [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
    [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
  ]
  const cube: Rgb[] = []
  for (const r of CUBE) for (const g of CUBE) for (const b of CUBE) cube.push([r, g, b])
  const grey: Rgb[] = []
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    grey.push([v, v, v])
  }
  return [...base, ...cube, ...grey]
})()

/**
 * How chalk/the terminal turns an RGB into a 256 index at colour level 2 (the
 * `ansi-styles` rule): greys take the 24-step ramp, everything else the cube.
 * Exported for the reachability check and its tests.
 */
export function cubeRound([r, g, b]: Rgb): number {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5)
}

/** Perceptually weighted squared distance (cheap approximation: green matters
 *  most, blue least) — used to pick which palette entry a colour becomes. */
export function rgbDistance(a: Rgb, b: Rgb): number {
  return 2 * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + 3 * (a[2] - b[2]) ** 2
}

/** One usable palette entry: `index` is what the terminal paints, `hex` is an
 *  input that converts to it (see the module note on why they can differ). */
export interface PaletteEntry {
  readonly index: number
  readonly hex: string
}

/** The hex we must store for `index` so the terminal paints that entry, or null
 *  when the entry is unreachable: `RGB(index)` when that round-trips, else the
 *  closest grey input that converts back to `index` (only the top grey steps),
 *  else nothing — a neutral cube entry is swallowed by the converter's grey
 *  branch, and the base-16 entries are absorbed by the cube. */
function entryHex(index: number): string | null {
  const rgb = ANSI256_RGB[index]!
  if (cubeRound(rgb) === index) return rgbToHex(rgb)
  if (rgb[0] === rgb[1] && rgb[1] === rgb[2]) {
    let best = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (let v = 0; v <= 255; v++) {
      if (cubeRound([v, v, v]) !== index) continue
      const delta = Math.abs(v - rgb[0])
      if (delta < bestDelta) {
        bestDelta = delta
        best = v
      }
    }
    if (best >= 0) return rgbToHex([best, best, best])
  }
  return null
}

/** Every entry this terminal can be made to paint, with the hex to store for it. */
export const REACHABLE_ENTRIES: readonly PaletteEntry[] = ANSI256_RGB.flatMap((_, index) => {
  const hex = entryHex(index)
  return hex === null ? [] : [{ index, hex }]
})

/**
 * The palette entry a colour should become.
 * @param rgb - the authored colour.
 * @param avoid - indices already taken by a higher-priority surface (the
 *   distinctness rule); null when any entry is fine.
 * @returns the best entry, or undefined when every candidate is taken.
 */
export function nearestEntry(rgb: Rgb, avoid: ReadonlySet<number> | null = null): PaletteEntry | undefined {
  let best: PaletteEntry | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const entry of REACHABLE_ENTRIES) {
    if (avoid !== null && avoid.has(entry.index)) continue
    const distance = rgbDistance(rgb, ANSI256_RGB[entry.index]!)
    if (distance < bestDistance) {
      bestDistance = distance
      best = entry
    }
  }
  return best
}

/**
 * Snap a whole palette in place for the given colour depth: level 3 does nothing,
 * level 1 is left to the terminal (see the module note), level 2 maps every
 * colour to a reachable entry and keeps the surfaces pairwise distinct.
 * @param palette - the live palette (mutated in place).
 * @param level - from {@link colorLevel}.
 * @returns the number of colours that changed (0 at level 3 and level 1).
 */
export function quantizePalette(palette: Record<string, string>, level: ColorLevel): number {
  if (level !== 2) return 0
  const taken = new Set<number>()
  let changed = 0
  const map = (key: string, avoid: ReadonlySet<number> | null): void => {
    const value = palette[key]
    if (value === undefined) return
    // `#rgba` / `#rrggbbaa`: an alpha surface composites with whatever is under
    // it, so snapping it to an opaque palette entry would change its meaning.
    const body = value.trim().replace(/^#/u, '')
    if (body.length === 4 || body.length === 8) return
    const rgb = parseHex(value)
    if (rgb === null) return
    const entry = nearestEntry(rgb, avoid)
    if (entry === undefined) return
    taken.add(entry.index)
    if (entry.hex !== value) {
      palette[key] = entry.hex
      changed += 1
    }
  }
  // Fills first, in role order, each avoiding the ones already placed: that is the
  // whole point — the card must not merge into the page. Everything else (borders,
  // text, accents) takes its nearest entry.
  for (const key of FILL_KEYS) map(key, taken)
  const placed = new Set(FILL_KEYS)
  for (const key of Object.keys(palette)) {
    if (placed.has(key)) continue
    map(key, null)
  }
  return changed
}
