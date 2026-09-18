/**
 * qialike default theme: the **dark** palette mirrors the **dark** web UI of
 * the sibling MIT project `deepseek-harness` (Copyright (c) 2026 DeepSeek) —
 * the `body[data-ds-dark-theme]` alias block of `packages/client/ui-theme/
 * src/styles/design-platform.css`. Every hex maps 1:1 from one of its static
 * ramps (background layers `neutral-bluish 950/900/850`, borders composited
 * from the alias white alpha ramps over each background, text `neutral-bluish
 * 50`, muted `neutral-bluish 600`, brand `deepseek 300/400/450`, semantic
 * `green-500`/`amber-400`/`blue-400/600`/`red-400/600`). The `light` scheme
 * is Atom's One Light and `one-dark` is Atom One Dark (both live in
 * theme-plugin.ts; see its docstring for provenance). Ink renders hex colors
 * via chalk (truecolor), so the palette
 * below maps 1:1 when the terminal supports 24-bit color (GNOME
 * Terminal/VTE does) — and when it does NOT (a terminal that is 24-bit capable
 * but exports no `COLORTERM` falls back to 256 colours), `applyScheme()`
 * pre-maps every role through `color-depth.ts` instead of letting chalk's own
 * cube rounding collapse the surfaces. The conversation frame paints `bg` as a
 * full-screen background layer (see panels/conversation.tsx), so colorscheme
 * switches are visible even when the terminal background would otherwise show
 * through the transparent surfaces.
 *
 * The palette is backed by a PROCESS-WIDE bucket (a `globalThis` singleton
 * behind a Proxy): the SEA build bundles each plugin entry separately, which
 * would otherwise give every module its own copy of `theme` — a colorscheme
 * switch in one copy would never reach the panels that render with another.
 * Every import of this module reads/writes the same underlying object, so
 * live theme switches work across all surfaces.
 *
 * @module @yourname/qialike-app/theme
 */

/** The full palette type (all color keys used across the surface). */
export interface ThemePalette {
  bg: string
  panel: string
  element: string
  borderSubtle: string
  border: string
  borderActive: string
  text: string
  textMuted: string
  primary: string
  secondary: string
  accent: string
  success: string
  warning: string
  info: string
  error: string
  yellow: string
}

/** Harness web dark palette (hex) — the `body[data-ds-dark-theme]` alias
 *  block of `deepseek-harness`'s `design-platform.css` (MIT © 2026 DeepSeek),
 *  the default `dark` scheme. */
const DEFAULTS: ThemePalette = {
  /** Near-black page / transcript background (painted as full-screen layer). */
  bg: '#151517',
  /** Raised panel background (composer, sidebar, dialogs). */
  panel: '#1b1b1c',
  /** Element background (nested surfaces, code inline). */
  element: '#2c2c2e',
  /** Subtle border. */
  borderSubtle: '#313133',
  /** Border. */
  border: '#3a3a3c',
  /** Active border. */
  borderActive: '#444445',
  /** Primary text. */
  text: '#f9fafb',
  /** Muted text (status, hints, secondary). */
  textMuted: '#81858c',
  /** Primary accent (user role, links, function/primary). */
  primary: '#679efe',
  /** Secondary accent (agent roles, bold keys, file/path names). */
  secondary: '#5686fe',
  /** Accent (headings, command highlights). */
  accent: '#b7c8fe',
  /** Success / code. */
  success: '#22c55e',
  /** Warning / blockquote / type. */
  warning: '#f7ad31',
  /** Info / operator. */
  info: '#60a5fa',
  /** Error. */
  error: '#f25a5a',
  /** Emphasis / yellow. */
  yellow: '#f7ad31',
}

const GLOBAL = globalThis as {
  __dshTuiThemeBucket?: ThemePalette
  /** Latest `bg` hex, mirrored for the patched Ink frame writer (build.mjs). */
  __dshTuiBgColor?: string
  /** Latest `text` hex, mirrored for the patched Ink frame writer (build.mjs). */
  __dshTuiTextColor?: string
}

/** The one palette instance shared by every bundled copy of this module. */
const bucket: ThemePalette = GLOBAL.__dshTuiThemeBucket ??= { ...DEFAULTS }

// Mirror the page background and body-text colors to the patched Ink frame
// writer so it can paint them under/over every glyph that Ink leaves unstyled
// (Ink text/border glyph cells carry no background by default, and uncolored
// text relies on the terminal's default foreground — invisible on a painted
// light background). See the __dshForceBg helper in apps/tui-bin/build.mjs.
GLOBAL.__dshTuiBgColor = bucket.bg
GLOBAL.__dshTuiTextColor = bucket.text

const traps: ProxyHandler<ThemePalette> = {
  get: (target, key) => target[key as keyof ThemePalette],
  set: (target, key, value) => {
    ;(target as unknown as Record<string, string>)[key as string] = String(value)
    if (key === 'bg') GLOBAL.__dshTuiBgColor = String(value)
    else if (key === 'text') GLOBAL.__dshTuiTextColor = String(value)
    return true
  },
  has: (target, key) => key in target,
  ownKeys: (target) => Reflect.ownKeys(target) as (string | symbol)[],
  getOwnPropertyDescriptor: (target, key) =>
    Object.getOwnPropertyDescriptor(target, key) ?? {
      configurable: true,
      enumerable: true,
      value: (target as unknown as Record<string, string>)[key as string],
    },
}

/** The shared palette (all reads/writes land on the process-wide bucket). */
export const theme: ThemePalette = new Proxy(bucket, traps)
