/**
 * The color-scheme plugin (`tui-theme`) — modeled on vim's `:colorscheme`:
 *
 *   - a **colorscheme** is a named palette applied onto the shared `theme`
 *     module object (the surface's "highlight groups"); switching is IMMEDIATE
 *     and persists into the `dsh-tui-theme:` settings section;
 *   - **built-in schemes**: `dark` (the default, shipped by theme.ts), `light`
 *     (opencode's official light), plus the classic third-party set in
 *     `classic-schemes.ts` (catppuccin, dracula, everforest, gruvbox,
 *     jellybeans, kanagawa, monokai, nord, rosepine, solarized — all
 *     MIT-licensed; see that module's header for sources and the 17-key
 *     mapping);
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
 * @module @yourname/dsh-tui-app/theme-plugin
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { theme, type ThemePalette } from './theme.ts'
import type { Store, TuiPanelDefinition } from './index.tsx'
import { openThemePicker, renderThemePicker, themePickerKey, type ThemePickerApi } from './theme-picker.tsx'
import { CLASSIC_SCHEMES } from './classic-schemes.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-theme'

/** Services required: settings (colorscheme persistence), tui (commands), tuiStore (live re-render). */
export const inject = ['settings', 'tui', 'tuiStore']

/** The `dsh-tui-theme:` settings namespace (vimrc-analogous persistence). */
const NS = settingsNamespace('dsh-tui-theme')

/** Schema: `colorscheme` name + optional per-role overrides. */
const ThemeSchema = z.object({
  colorscheme: z.string(),
  colors: z.dict(z.string()),
})

/** Directory that holds user colorschemes (`~/.dsh/themes/<name>.json`). */
function themesDir(): string {
  return dshHomePath('themes')
}

/**
 * Built-in schemes. `dark` snapshots the default palette at module load.
 *
 * `light` mirrors the OFFICIAL light definition shipped inside opencode's own
 * default theme (`opencode.json`, defs `lightStep1…12` / `lightSecondary` /
 * `lightAccent` / `lightRed`…): white page background, neutral-gray borders,
 * blue primary, purple secondary, orange accent/warning — the same curated
 * light skin whose dark half our `dark` scheme already mirrors 1:1. Semantic
 * text colors are deepened one step within the official hue family so they
 * hold WCAG AA (≥4.5:1) contrast on the white background:
 *   primary #3b7dd8→#3473c6 · accent/warning #d68c27→#a96410 ·
 *   success #3d9a57→#2f7d45 · info #318795→#2b7884 · yellow #b0851f→#8f6c13 ·
 *   muted #8a8a8a→#707070 (error #d1383d and secondary #7b5bb6 already pass).
 */
export const BUILTIN_SCHEMES: Record<string, ThemePalette> = {
  dark: { ...theme },
  light: {
    bg: '#ffffff', panel: '#fafafa', element: '#f5f5f5', borderSubtle: '#d4d4d4',
    border: '#b8b8b8', borderActive: '#a0a0a0', text: '#1a1a1a', textMuted: '#707070',
    primary: '#3473c6', secondary: '#7b5bb6', accent: '#a96410', success: '#2f7d45',
    warning: '#a96410', info: '#2b7884', error: '#d1383d', yellow: '#8f6c13',
  },
  // Classic third-party skins (all MIT: 9 from opencode theme assets +
  // jellybeans from a vim colorscheme) — provenance in classic-schemes.ts.
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

/** Current colorscheme name. */
export function currentScheme(): string { return applied }

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
  const settings = ctx.get('settings') as {
    register(ns: unknown, schema: unknown, options?: unknown): SettingsScope<unknown>
    get(ns: unknown): unknown
    update?(ns: unknown, patch: unknown): Promise<void>
  } | undefined
  const tui = ctx.get('tui') as {
    commands: { register(c: { name: string; hint: string; run: (arg: string) => void }): void }
    panels?: { register(def: TuiPanelDefinition): void }
  } | undefined
  const store = ctx.get('tuiStore') as Store | undefined
  if (settings === undefined || tui === undefined) return

  const rerender = (): void => { try { store?.bumpTheme?.() } catch { /* best-effort */ } }
  const scope = settings.register(NS, ThemeSchema as never, {})
  const read = (): { colorscheme?: string; colors?: Record<string, string> } =>
    (scope.get() as { colorscheme?: string; colors?: Record<string, string> } | undefined) ?? {}

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
    persist: (name) => { void settings.update?.(NS, { colorscheme: name, colors: read().colors ?? {} }) },
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
    render: (s) => renderThemePicker(s, api),
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
        void settings.update?.(NS, { colorscheme: resolved, colors: current.colors ?? {} })
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
          void settings.update?.(NS, { colorscheme: applied, colors: { ...current.colors, [key]: hex } })
          status(`theme: ${key} ${hex}`)
          return
        }
      }
      status(`theme: unknown "${text}" — schemes: ${Object.keys(schemeRegistry()).sort().join(', ')}`)
    },
  })
}
