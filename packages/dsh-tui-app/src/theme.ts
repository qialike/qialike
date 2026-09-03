/**
 * dsh-tui theme: approximates the opencode default dark theme (`opencode.json`)
 * so the terminal looks like opencode TUI. Ink renders hex colors via chalk
 * (truecolor), so the palette below maps 1:1 when the terminal supports 24-bit
 * color (GNOME Terminal/VTE does). The conversation frame paints `bg` as a
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
 * @module @yourname/dsh-tui-app/theme
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

/** opencode default-dark palette (hex). */
const DEFAULTS: ThemePalette = {
  /** Near-black page / transcript background (painted as full-screen layer). */
  bg: '#0a0a0a',
  /** Raised panel background (composer, sidebar, dialogs). */
  panel: '#141414',
  /** Element background (nested surfaces, code inline). */
  element: '#1e1e1e',
  /** Subtle border. */
  borderSubtle: '#3c3c3c',
  /** Border. */
  border: '#484848',
  /** Active border. */
  borderActive: '#606060',
  /** Primary text. */
  text: '#eeeeee',
  /** Muted text (status, hints, secondary). */
  textMuted: '#808080',
  /** Primary accent (user role, links, function/primary). */
  primary: '#fab283',
  /** Secondary accent (agent roles). */
  secondary: '#5c9cf5',
  /** Accent (headings, command highlights). */
  accent: '#9d7cd8',
  /** Success / code. */
  success: '#7fd88f',
  /** Warning / blockquote / type. */
  warning: '#f5a742',
  /** Info / operator. */
  info: '#56b6c2',
  /** Error. */
  error: '#e06c75',
  /** Emphasis / yellow. */
  yellow: '#e5c07b',
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
