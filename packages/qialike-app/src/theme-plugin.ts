import React from 'react'
/**
 * The color-scheme plugin (`tui-theme`) — modeled on vim's `:colorscheme`:
 *
 *   - a **colorscheme** is a named palette applied onto the shared `theme`
 *     module object (the surface's "highlight groups"); switching is IMMEDIATE
 *     and persists into the `qialike-theme:` settings section;
 *   - **built-in schemes**: `dark` (the default, shipped by theme.ts — the
 *     DeepSeek Harness web dark design tokens, MIT repo `deepseek-harness`)
 *     and `light` (Atom's One Light — the former `one-light` skin promoted to
 *     the default light name, GitHub Inc. MIT); the optional skin `one-dark`
 *     (Atom, GitHub Inc. MIT); plus the classic third-party set
 *     in `classic-schemes.ts` — 13 MIT skins (catppuccin, dracula,
 *     everforest, falcon, flexoki, gruvbox, jellybeans, kanagawa, nord,
 *     panda, rosepine, solarized, solarized-light — see that module's
 *     header for sources and the
 *     17-key mapping);
 *   - **user schemes** live in `~/.dsh/themes/<name>.json` — like vim's
 *     `colors/*.vim`. Each file is a small JSON palette:
 *
 *     ```json
 *     { "name": "my-scheme", "palette": { "bg": "#000000", "accent": "#ff8800", ... } }
 *     ```
 *     (`name` optional — falls back to the file name; unknown keys ignored.)
 *
 *   - `/theme`             → open the picker dialog listing every scheme
 *   - `/theme <name>`      → switch (exact, or a unique prefix like vim's
 *                            abbreviations); persists the choice
 *   - `/theme <role> <hex>`→ override one palette role (persisted on top of
 *                            the scheme)
 *
 * The plugin re-renders the whole surface live by bumping the store's theme
 * epoch (`store.bumpTheme()`), which invalidates the memoized transcript rows.
 *
 * @module @qialike/qialike-app/theme-plugin
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { readSection, writeSection } from './config.ts'
import { theme, type ThemePalette } from './theme.ts'
import { colorLevel, quantizePalette } from './color-depth.ts'
import type { Store, TuiPanelDefinition } from './index.tsx'
import { openThemePicker, ThemePicker, themePickerKey, type ThemePickerApi } from './theme-picker.tsx'
import { CLASSIC_SCHEMES } from './classic-schemes.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-theme'

/** Services required: tui (commands), tuiStore (live re-render). The colorscheme
 *  persists in `qialike.json` since 0.1.7 (`readSection`/`writeSection`), so the
 *  harness settings service is no longer an injected dependency. */
export const inject = ['tui', 'tuiStore']

/** Directory that holds user colorschemes (`~/.dsh/themes/<name>.json`). */
function themesDir(): string {
  return dshHomePath('themes')
}

/**
 * Built-in schemes. `dark` snapshots the default palette at module load
 * (theme.ts — the DeepSeek Harness web dark design tokens, see its header)
 * and is the ONE scheme held to the WCAG AA bar: its text-bearing roles keep
 * ≥4.5:1 contrast on its background.
 *
 * `light` is Atom's One Light — the former `one-light` optional skin
 * promoted to the default light name, official hexes verbatim: hues from
 * the official repos `atom/one-light-syntax` / `atom/one-light-ui` (GitHub
 * Inc., MIT — archived, which does not affect their MIT grant), structure
 * steps cross-checked against `navarasu/onedark.nvim`'s palette.lua (MIT),
 * which reproduces the same ramps for terminal ports. Like every non-dark
 * skin it is not held to the AA bar `dark` is: muted #696c77 and secondary
 * #a626a4 keep the official values rather than being re-pushed.
 *
 * `one-dark` keeps Atom's One Dark hexes verbatim from the same family of
 * sources (`atom/one-dark-syntax` / `atom/one-dark-ui`, GitHub Inc., MIT —
 * archived, which does not affect their MIT grant). Optional skins
 * (one-dark, classic) are not held to the AA bar `dark` is.
 */
export const BUILTIN_SCHEMES: Record<string, ThemePalette> = {
  dark: { ...theme },
  // light = Atom's One Light, promoted from the former `one-light` optional
  // skin to the default light name — pure official hexes (provenance in the
  // docstring above). Its inline-code element #e6e6e6 differs from bg, so
  // inline code renders as a chip here, like in one-dark.
  light: {
    bg: '#fafafa', panel: '#f0f0f0', element: '#e6e6e6', borderSubtle: '#dcdcdc',
    border: '#c9c9c9', borderActive: '#a0a1a7', text: '#383a42', textMuted: '#696c77',
    primary: '#4078f2', secondary: '#a626a4', accent: '#986801', success: '#50a14f',
    warning: '#986801', info: '#0184bc', error: '#e45649', yellow: '#986801',
  },
  // Atom One Dark — optional skin, pure official hexes (provenance in the
  // docstring above).
  'one-dark': {
    bg: '#282c34', panel: '#31353f', element: '#393f4a', borderSubtle: '#3b3f4c',
    border: '#5c6370', borderActive: '#828997', text: '#abb2bf', textMuted: '#848b98',
    primary: '#d19a66', secondary: '#61afef', accent: '#c678dd', success: '#98c379',
    warning: '#e2c08d', info: '#56b6c2', error: '#e06c75', yellow: '#e5c07b',
  },
  // Classic third-party skins (12 from upstream official repos + jellybeans
  // from an MIT vim colorscheme) — provenance in classic-schemes.ts.
  ...CLASSIC_SCHEMES,
}

/** The default scheme when nothing is configured (vim's default). */
export const DEFAULT_SCHEME = 'dark'

/** Load one user scheme file → palette (best-effort, unknown keys dropped). */
function loadUserScheme(file: string): { name: string; palette: ThemePalette } | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      name?: unknown
      palette?: Record<string, unknown>
    } | Record<string, unknown>
    const obj = raw as Record<string, unknown>
    const pal = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && typeof (raw as { palette?: unknown }).palette === 'object'
      ? (raw as { palette: Record<string, unknown> }).palette
      : obj) as Record<string, unknown>
    const palette = {} as ThemePalette
    for (const key of Object.keys(theme) as (keyof ThemePalette)[]) {
      const v = pal[key as string]
      if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) palette[key] = v as never
    }
    if (Object.keys(palette).length === 0) return undefined
    const base = file.split(/[\\/]/).pop() ?? ''
    const name = typeof raw === 'object' && raw !== null && typeof (raw as { name?: unknown }).name === 'string'
      ? (raw as { name: string }).name
      : base.replace(/\.json$/i, '')
    return { name, palette }
  } catch {
    return undefined
  }
}

/** Load every user scheme (like vim sourcing `colors/*`). */
export function userSchemes(): Record<string, ThemePalette> {
  const dir = themesDir()
  if (!existsSync(dir)) return {}
  const out: Record<string, ThemePalette> = {}
  for (const entry of readdirSync(dir)) {
    if (!/\.json$/i.test(entry)) continue
    const loaded = loadUserScheme(join(dir, entry))
    if (loaded !== undefined) out[loaded.name] = loaded.palette
  }
  return out
}

/** Full scheme registry (built-ins + user files), built-ins win on name clash. */
export function schemeRegistry(): Record<string, ThemePalette> {
  return { ...userSchemes(), ...BUILTIN_SCHEMES }
}

/** The scheme currently applied (for `/theme` status). */
let applied = DEFAULT_SCHEME

/** Apply a scheme (+ optional overrides) onto the shared theme object. */
export function applyScheme(name: string, overrides?: Record<string, string>): void {
  const all = schemeRegistry()
  const base = all[name] ?? BUILTIN_SCHEMES[DEFAULT_SCHEME]
  applied = name in all ? name : DEFAULT_SCHEME
  for (const key of Object.keys(theme) as (keyof ThemePalette)[]) theme[key] = base[key]
  if (overrides !== undefined) {
    const mutable = theme as unknown as Record<string, string>
    for (const key of Object.keys(overrides)) {
      if (key in theme) mutable[key] = overrides[key]!
    }
  }
  // Last stop before Ink/chalk sees the palette: if this terminal cannot show
  // 24-bit colour, bake in the mapping ourselves (see color-depth.ts — chalk's
  // own fallback collides, which is what merged the card into the page).
  quantizePalette(theme as unknown as Record<string, string>, colorLevel())
}

/** Resolve a name argument: exact match, else a UNIQUE prefix (vim-like). */
export function resolveScheme(text: string): string | undefined {
  const names = Object.keys(schemeRegistry()).sort()
  if (names.includes(text)) return text
  const matches = names.filter((n) => n.startsWith(text))
  return matches.length === 1 ? matches[0]! : undefined
}

function parseHex(value: string): string | undefined {
  const m = value.replace(/^#/, '').match(/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{4}$|^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/)
  return m === null ? undefined : `#${m[0].toLowerCase()}`
}

export function apply(ctx: Context): void {
  const tui = ctx.get('tui') as {
    commands: { register(c: { name: string; hint: string; run: (arg: string) => void }): void }
    panels?: { register(def: TuiPanelDefinition): void }
  } | undefined
  const store = ctx.get('tuiStore') as Store | undefined
  if (tui === undefined) return

  const rerender = (): void => { try { store?.bumpTheme?.() } catch { /* best-effort */ } }
  const read = (): { colorscheme?: string; colors?: Record<string, string> } =>
    readSection('theme') ?? {}

  // Startup: apply the configured colorscheme (+ overrides).
  const cfg = read()
  applyScheme(cfg.colorscheme ?? DEFAULT_SCHEME, cfg.colors)
  rerender()

  // The picker dialog talks to the plugin only through this api (no cycles):
  // preview applies live, Enter persists, Esc restores the opening snapshot.
  const api: ThemePickerApi = {
    schemes: () => Object.keys(schemeRegistry()).sort((a, b) => a.localeCompare(b)),
    isUserScheme: (name) => name in userSchemes(),
    current: () => applied,
    apply: (name) => { applyScheme(name, read().colors ?? {}); rerender() },
    persist: (name) => { writeSection('theme', { colorscheme: name, colors: read().colors ?? {} }) },
    rerender,
    restore: (palette, name) => {
      applied = name
      for (const key of Object.keys(theme) as (keyof ThemePalette)[]) theme[key] = palette[key]
      rerender()
    },
  }
  tui.panels?.register({
    id: 'themes',
    mode: 'fullscreen',
    render: (s) => React.createElement(ThemePicker, { store: s, api }),
    handleKey: (k, s) => themePickerKey(k, s, api),
  })

  tui.commands.register({
    name: 'theme',
    hint: 'switch colorscheme — Enter opens the theme list',
    run: (arg) => {
      const text = (arg ?? '').trim()
      const current = read()
      const status = (msg: string): void => { try { store?.append?.('status', msg, true) } catch { /* noop */ } }
      if (text === '') {
        // Bare `/theme`: browse schemes in the picker dialog (no name needed).
        if (store !== undefined) { openThemePicker(store, api); return }
        status(`colorscheme: ${applied} (available: ${Object.keys(schemeRegistry()).sort().join(', ')})`)
        return
      }
      const resolved = resolveScheme(text.toLowerCase())
      if (resolved !== undefined) {
        applyScheme(resolved, current.colors)
        rerender()
        writeSection('theme', { colorscheme: resolved, colors: current.colors ?? {} })
        status(`colorscheme: ${resolved}`)
        return
      }
      const m = text.match(/^([a-zA-Z]+)\s+(.+)$/)
      if (m !== null) {
        const key = m[1]!
        const hex = parseHex(m[2]!.trim())
        if (key in theme && hex !== undefined) {
          applyScheme(applied, { ...current.colors, [key]: hex })
          rerender()
          writeSection('theme', { colorscheme: applied, colors: { ...current.colors, [key]: hex } })
          status(`theme: ${key} ${hex}`)
          return
        }
      }
      status(`theme: unknown "${text}" — schemes: ${Object.keys(schemeRegistry()).sort().join(', ')}`)
    },
  })
}
