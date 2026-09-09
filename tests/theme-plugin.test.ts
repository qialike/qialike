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

describe('light scheme quality', () => {
  // The light skin mirrors the OFFICIAL light definition of opencode's own
  // default theme (sst/opencode, MIT — packages/tui/src/theme/assets/
  // opencode.json, defs lightStep1..12 / lightSecondary / lightAccent /
  // lightRed…), with semantic text colors deepened one step within the
  // official hue family to hold WCAG AA (≥4.5:1) on white.
  test('light palette equals the official opencode light mapping', () => {
    expect(BUILTIN_SCHEMES.light).toEqual({
      bg: '#ffffff', panel: '#fafafa', element: '#f5f5f5', borderSubtle: '#d4d4d4',
      border: '#b8b8b8', borderActive: '#a0a0a0', text: '#1a1a1a', textMuted: '#707070',
      primary: '#3473c6', secondary: '#7b5bb6', accent: '#a96410', success: '#2f7d45',
      warning: '#a96410', info: '#2b7884', error: '#d1383d', yellow: '#8f6c13',
    })
  })

  test('Atom one-dark / one-light skins keep the official hexes verbatim', () => {
    expect(BUILTIN_SCHEMES['one-dark']).toEqual({
      bg: '#282c34', panel: '#31353f', element: '#393f4a', borderSubtle: '#3b3f4c',
      border: '#5c6370', borderActive: '#828997', text: '#abb2bf', textMuted: '#848b98',
      primary: '#d19a66', secondary: '#61afef', accent: '#c678dd', success: '#98c379',
      warning: '#e2c08d', info: '#56b6c2', error: '#e06c75', yellow: '#e5c07b',
    })
    expect(BUILTIN_SCHEMES['one-light']).toEqual({
      bg: '#fafafa', panel: '#f0f0f0', element: '#e6e6e6', borderSubtle: '#dcdcdc',
      border: '#c9c9c9', borderActive: '#a0a1a7', text: '#383a42', textMuted: '#696c77',
      primary: '#4078f2', secondary: '#a626a4', accent: '#986801', success: '#50a14f',
      warning: '#986801', info: '#0184bc', error: '#e45649', yellow: '#986801',
    })
    for (const name of ['one-dark', 'one-light']) {
      expect(Object.keys(schemeRegistry())).toContain(name)
    }
  })

  test('text-bearing roles hold WCAG AA contrast on their scheme background', () => {
    // Roles rendered as text on the page/panel background must keep ≥4.5:1
    // (border-only roles are excluded — they pair with text of their own).
    // Only the two CURATED defaults are held to AA: third-party classic
    // schemes (classic-schemes.ts) keep their upstream comment/muted contrast
    // by design (e.g. dracula/monokai muted ≈ 3:1).
    const textRoles = ['text', 'textMuted', 'primary', 'secondary', 'accent', 'success', 'warning', 'info', 'error', 'yellow']
    for (const schemeName of ['dark', 'light'] as const) {
      const { bg, ...rest } = BUILTIN_SCHEMES[schemeName]!
      for (const role of textRoles) {
        const ratio = contrastRatio(rest[role as keyof typeof rest]!, bg)
        expect(ratio, `${schemeName}.${role} (#${rest[role as keyof typeof rest]} on #${bg})`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('classic schemes are registered and structurally complete', () => {
    const classic = ['catppuccin', 'dracula', 'everforest', 'falcon', 'flexoki', 'gruvbox', 'jellybeans', 'kanagawa', 'monokai', 'nord', 'panda', 'rosepine', 'solarized']
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
      catppuccin: '#1e1e2e', dracula: '#282a36', everforest: '#2d353b', falcon: '#020221',
      flexoki: '#100f0f', gruvbox: '#282828',
      jellybeans: '#151515', kanagawa: '#1f1f28', monokai: '#272822', nord: '#2e3440',
      panda: '#292a2b', rosepine: '#191724', solarized: '#002b36',
    }
    for (const [name, bg] of Object.entries(anchors)) {
      expect(BUILTIN_SCHEMES[name]?.bg, name).toBe(bg)
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
