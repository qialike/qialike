/**
 * dsh-tui default theme: the classic **Atom One Dark** palette, so the
 * terminal looks like GitHub's Atom editor dark theme. Ink renders hex colors
 * via chalk (truecolor), so the palette below maps 1:1 when the terminal
 * supports 24-bit color (GNOME Terminal/VTE does). The conversation frame
 * paints `bg` as a full-screen background layer (see panels/conversation.tsx),
 * so colorscheme switches are visible even when the terminal background would
 * otherwise show through the transparent surfaces.
 *
 * Sources (all MIT): the hues come from Atom's official One Dark repos —
 * `atom/one-dark-syntax` (syntax bg `hsl(220,13%,18%)` = #282c34, the mono
 * ramp, and the 10 syntax colors) and `atom/one-dark-ui` (its `text-color-*`
 * UI tones); the structure steps between them (panel/element/border tones)
 * are cross-checked against `navarasu/onedark.nvim`'s palette.lua (MIT),
 * which reproduces the same ramp for terminal ports. Two text roles are
 * nudged one lightness step *within their official hue family* so they hold
 * WCAG AA (≥4.5:1) on the #282c34 background — same policy the light skin
 * applies (see theme-plugin.ts):
 *   textMuted #828997→#9096a2 · error #e06c75→#e27881.
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

/** Atom One Dark palette (hex); two roles AA-adjusted — see the header. */
const DEFAULTS: ThemePalette = {
  /** Blue-gray page / transcript background (Atom syntax background). */
  bg: '#282c34',
  /** Raised panel background (composer, sidebar, dialogs). */
  panel: '#31353f',
  /** Element background (nested surfaces, code inline). */
  element: '#393f4a',
  /** Subtle border. */
  borderSubtle: '#3b3f4c',
  /** Border. */
  border: '#5c6370',
  /** Active border. */
  borderActive: '#828997',
  /** Primary text. */
  text: '#abb2bf',
  /** Muted text (status, hints, secondary). AA-lightened one step (#828997). */
  textMuted: '#9096a2',
  /** Primary accent (user role, links, function/primary). */
  primary: '#d19a66',
  /** Secondary accent (agent roles, bold keys, file/path names). */
  secondary: '#61afef',
  /** Accent (headings, command highlights). */
  accent: '#c678dd',
  /** Success / code. */
  success: '#98c379',
  /** Warning / blockquote / type. */
  warning: '#e2c08d',
  /** Info / operator. */
  info: '#56b6c2',
  /** Error. AA-lightened one step (#e06c75). */
  error: '#e27881',
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
