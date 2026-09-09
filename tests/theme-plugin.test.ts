/**
 * Unit tests for the vim-style color-scheme plugin (`tui-theme`,
 * `packages/dsh-tui-app/src/theme-plugin.ts`).
 *
 * Run with `bun test tests/theme-plugin.test.ts`.
 *
 * @module dsh-tui/theme-plugin-test
 */

import { describe, expect, test, afterEach } from 'bun:test'
import { theme } from '../packages/dsh-tui-app/src/theme.ts'
import {
  BUILTIN_SCHEMES, DEFAULT_SCHEME, applyScheme, resolveScheme, schemeRegistry, apply,
} from '../packages/dsh-tui-app/src/theme-plugin.ts'

const ORIGINAL = { ...theme }

afterEach(() => { applyScheme(DEFAULT_SCHEME); Object.assign(theme, ORIGINAL) })

describe('colorscheme registry', () => {
  test('built-in schemes cover every palette key', () => {
    const keys = Object.keys(ORIGINAL)
    expect(Object.keys(BUILTIN_SCHEMES.dark ?? {})).toEqual(keys)
    expect(Object.keys(BUILTIN_SCHEMES.light ?? {})).toEqual(keys)
    expect(Object.keys(schemeRegistry())).toContain('dark')
  })

  test('applyScheme switches live and falls back on unknown names', () => {
    applyScheme('light')
    expect(theme.bg).toBe(BUILTIN_SCHEMES.light.bg)
    applyScheme('nope')
    // The applied scheme is observable through the shared `theme` object: an
    // unknown name falls back to the default (dark) scheme.
    expect(theme.bg).toBe(BUILTIN_SCHEMES[DEFAULT_SCHEME].bg)
  })

  test('resolveScheme matches exact or a unique prefix', () => {
    expect(resolveScheme('light')).toBe('light')
    expect(resolveScheme('lig')).toBe('light')
    expect(resolveScheme('x')).toBeUndefined()
  })

  test('per-role overrides apply on top of the scheme', () => {
    applyScheme('light', { accent: '#ff8800' })
    expect(theme.accent).toBe('#ff8800')
    expect(theme.bg).toBe(BUILTIN_SCHEMES.light.bg)
  })
})

describe('plugin apply wiring', () => {
  test('registers /theme (dialog) + themes panel and applies the configured scheme at startup', () => {
    const commands: { name: string; run: (arg: string) => void }[] = []
    const panels: { id?: string; mode?: string }[] = []
    const opened: string[] = []
    const ctx = {
      get(id: string) {
        if (id === 'settings') return { register: () => ({ get: () => ({ colorscheme: 'light', colors: {} }) }) }
        if (id === 'tui') return {
          commands: { register: (c: { name: string; run: (arg: string) => void }) => commands.push(c) },
          panels: { register: (d: { id?: string; mode?: string }) => panels.push(d) },
        }
        if (id === 'tuiStore') return { bumpTheme: () => {}, append: () => {}, setPanel: (p: string) => opened.push(p) }
        return undefined
      },
    }
    apply(ctx as never)
    expect(theme.bg).toBe(BUILTIN_SCHEMES.light.bg)
    expect(commands.map((c) => c.name)).toContain('theme')
    expect(panels.some((p) => p.id === 'themes' && p.mode === 'fullscreen')).toBe(true)
    commands.find((c) => c.name === 'theme')!.run('dark')
    expect(theme.bg).toBe(BUILTIN_SCHEMES.dark.bg)
    // Bare /theme opens the picker dialog instead of requiring an argument.
    commands.find((c) => c.name === 'theme')!.run('')
    expect(opened).toContain('themes')
  })
})

describe('scheme palettes', () => {
  // The light skin is Atom's One Light — the former `one-light` optional
  // skin promoted to the default light name (atom/one-light-syntax +
  // atom/one-light-ui, GitHub Inc., MIT). Official hexes are kept verbatim:
  // like every non-dark skin it is deliberately not re-pushed to AA (see the
  // AA test below).
  test('light palette equals Atom One Light (promoted from one-light)', () => {
    expect(BUILTIN_SCHEMES.light).toEqual({
      bg: '#fafafa', panel: '#f0f0f0', element: '#e6e6e6', borderSubtle: '#dcdcdc',
      border: '#c9c9c9', borderActive: '#a0a1a7', text: '#383a42', textMuted: '#696c77',
      primary: '#4078f2', secondary: '#a626a4', accent: '#986801', success: '#50a14f',
      warning: '#986801', info: '#0184bc', error: '#e45649', yellow: '#986801',
    })
    expect(Object.keys(schemeRegistry())).not.toContain('one-light')
  })

  test('Atom one-dark skin keeps the official hexes verbatim', () => {
    expect(BUILTIN_SCHEMES['one-dark']).toEqual({
      bg: '#282c34', panel: '#31353f', element: '#393f4a', borderSubtle: '#3b3f4c',
      border: '#5c6370', borderActive: '#828997', text: '#abb2bf', textMuted: '#848b98',
      primary: '#d19a66', secondary: '#61afef', accent: '#c678dd', success: '#98c379',
      warning: '#e2c08d', info: '#56b6c2', error: '#e06c75', yellow: '#e5c07b',
    })
    expect(Object.keys(schemeRegistry())).toContain('one-dark')
  })

  test('dark tracks the DeepSeek Harness web dark design tokens', () => {
    // Resolved from deepseek-harness's design-platform.css (MIT © 2026
    // DeepSeek): the body[data-ds-dark-theme] alias block; borders are the
    // white alpha ramps composited over each background. `dark` keeps the
    // web chip background for inline code — its element #2c2c2e IS the dark
    // alias' markdown-inline-code token.
    expect(BUILTIN_SCHEMES.dark).toEqual({
      bg: '#151517', panel: '#1b1b1c', element: '#2c2c2e', borderSubtle: '#313133',
      border: '#3a3a3c', borderActive: '#444445', text: '#f9fafb', textMuted: '#81858c',
      primary: '#679efe', secondary: '#5686fe', accent: '#b7c8fe', success: '#22c55e',
      warning: '#f7ad31', info: '#60a5fa', error: '#f25a5a', yellow: '#f7ad31',
    })
    expect(Object.keys(schemeRegistry())).toContain('dark')
  })

  test('text-bearing roles hold WCAG AA contrast on the dark default', () => {
    // Roles rendered as text on the page/panel background must keep ≥4.5:1
    // (border-only roles are excluded — they pair with text of their own).
    // Only the CURATED dark default (DeepSeek Harness's web dark tokens) is
    // held to AA: the light default (Atom's One Light, promoted from the
    // one-light skin) keeps the official hexes verbatim — its muted #696c77
    // and secondary #a626a4 sit below 4.5:1 on the near-white #fafafa
    // background — and third-party/optional schemes (classic-schemes.ts,
    // one-dark) keep their upstream contrast by design (e.g. dracula muted
    // ≈ 3:1).
    const textRoles = ['text', 'textMuted', 'primary', 'secondary', 'accent', 'success', 'warning', 'info', 'error', 'yellow']
    for (const schemeName of ['dark'] as const) {
      const { bg, ...rest } = BUILTIN_SCHEMES[schemeName]!
      for (const role of textRoles) {
        const ratio = contrastRatio(rest[role as keyof typeof rest]!, bg)
        expect(ratio, `${schemeName}.${role} (#${rest[role as keyof typeof rest]} on #${bg})`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('classic schemes are registered and structurally complete', () => {
    const classic = ['bespin', 'blackboard', 'catppuccin', 'dracula', 'everforest', 'falcon', 'flexoki', 'gruvbox', 'jellybeans', 'kanagawa', 'monokai', 'nord', 'panda', 'rosepine', 'solarized', 'solarized-light', 'twilight']
    for (const name of classic) {
      const palette = BUILTIN_SCHEMES[name]
      expect(palette, name).toBeDefined()
      expect(Object.keys(palette ?? {}).sort(), name).toEqual(Object.keys(BUILTIN_SCHEMES.dark ?? {}).sort())
      for (const [role, hex] of Object.entries(palette ?? {})) {
        expect(hex, `${name}.${role}`).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
    for (const name of Object.keys(schemeRegistry())) expect(name).toBeDefined()
    for (const name of classic) expect(Object.keys(schemeRegistry())).toContain(name)
  })

  test('classic scheme anchor backgrounds match their sources', () => {
    const anchors: Record<string, string> = {
      bespin: '#2a211c', blackboard: '#0c1021',
      catppuccin: '#1e1e2e', dracula: '#282a36', everforest: '#2d353b', falcon: '#020221',
      flexoki: '#100f0f', gruvbox: '#282828',
      jellybeans: '#151515', kanagawa: '#1f1f28', monokai: '#272822', nord: '#2e3440',
      panda: '#292a2b', rosepine: '#191724', solarized: '#002b36',
      'solarized-light': '#fdf6e3', twilight: '#141414',
    }
    for (const [name, bg] of Object.entries(anchors)) {
      expect(BUILTIN_SCHEMES[name]?.bg, name).toBe(bg)
    }
  })

  test('solarized-light mirrors the official light side of solarized', () => {
    // Same upstream (altercation/solarized, MIT): the accent roles are shared
    // verbatim with the dark side; only the base ramp inverts to the official
    // light recommendation — bg base3 #fdf6e3, layers base2 #eee8d5, muted /
    // borderActive base1 #93a1a1, text base00 #657b83.
    const darkSide = BUILTIN_SCHEMES.solarized!
    const lightSide = BUILTIN_SCHEMES['solarized-light']!
    expect(lightSide.bg).toBe('#fdf6e3')
    expect(lightSide.panel).toBe('#eee8d5')
    expect(lightSide.text).toBe('#657b83')
    expect(lightSide.textMuted).toBe('#93a1a1')
    for (const role of ['primary', 'secondary', 'accent', 'success', 'warning', 'info', 'error', 'yellow'] as const) {
      expect(lightSide[role], `solarized-light.${role}`).toBe(darkSide[role])
    }
  })
})

/** WCAG relative luminance of a `#rrggbb` hex color. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * chan[0]! + 0.7152 * chan[1]! + 0.0722 * chan[2]!
}

/** WCAG contrast ratio between two hex colors (≥1). */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
