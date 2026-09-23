/**
 * qialike user configuration, stored as JSON at `$DSH_HOME/qialike.json`
 * (default `~/.dsh/qialike.json`).
 *
 * Resolution precedence for a setting: config file value > environment
 * variable > built-in default. When the environment variable is set at launch
 * the value is also written back into the config file, so it persists for later
 * runs without the variable (i.e. "env written into the config file").
 *
 * @module @qialike/qialike-app/config
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { homeFilePath } from './legacy-names.ts'
import { logErrorFileOnly } from './log.ts'

/** Terminal width (columns) below which the right sidebar hides (auto). */
export const SIDEBAR_MIN_WIDTH = 110

/** Rows scrolled per mouse-wheel tick in the transcript. Shared by the
 *  conversation panel and the plan-review dock (which rolls the message list
 *  behind it), so both scroll at the same rate. */
export const WHEEL_STEP = 3

/** Text columns actually available inside an embedded dock (approval /
 *  question) at terminal width `width`. The docks are flex children of the
 *  message column, so their real width excludes the sidebar (when shown),
 *  the message column's horizontal padding (2) and the dock's own border (2)
 *  + padding (2). Wrapping the detail window at this width keeps the rendered
 *  row count equal to the modalH estimate (conversation.tsx uses the same
 *  value); using the bare terminal width would re-wrap every line inside the
 *  narrower column and silently double the dock height. */
export function dockInnerWidth(width: number, mode: SidebarMode = 'auto'): number {
  // Reserve the sidebar only when it is actually VISIBLE for this mode
  // (mirrors conversation.tsx sidebarVisibleFor: 'on' = always, 'auto' =
  // width ≥ SIDEBAR_MIN_WIDTH, 'off' = never). Hiding the sidebar widens the
  // message column — and the floating question dock that spans it. Subtracting
  // a phantom sidebar here wrapped every dock line ~30% short of the real
  // column, so popup text filled only the LEFT part of the dialog.
  const visible = mode === 'on' || (mode === 'auto' && width >= SIDEBAR_MIN_WIDTH)
  const sidebar = visible ? Math.round(width * 0.3) + 2 : 0
  // Question dock content width: message column padding (1) + dock margins (3)
  // + dock border (1) + dock content padding (2) per side → content inset
  // 4 char-widths from each edge, matching the message content column.
  return Math.max(1, width - sidebar - 2 - 6 - 2 - 4)
}

/** Default for auto-resuming the newest same-directory session at launch. */
/** Auto-resume on launch is now OPT-IN: a bare `qialike` opens an unused New
 *  Session placeholder (hero screen, web parity); `qialike resume` continues
 *  the newest content session instead. Set `resume_last: true` (or
 *  QIALIKE_RESUME_LAST=1) to restore the old always-continue behavior. */
export const DEFAULT_RESUME_LAST = false

/** Environment variable that overrides the auto-resume default and is persisted. */
export const RESUME_LAST_ENV = 'QIALIKE_RESUME_LAST'

/** Right-sidebar visibility mode: `auto` follows the terminal width threshold,
 *  `on`/`off` pin it regardless of width. Persisted so a manual choice
 *  survives restarts; the `/sidebar` command and a Steps-title click cycle it. */
export type SidebarMode = 'auto' | 'on' | 'off'

/** A qialike-owned switch section, stored in `qialike.json`.
 *
 *  Harness 0.1.5 let a plugin register an arbitrary settings namespace at runtime
 *  (`settings.register(ns, schema)`), and qialike kept its own switches there.
 *  0.1.7 removed that capability — a section now belongs to a plugin's own
 *  `Config` — so they live in the config file this app already owns. The
 *  `qialike-*` spelling is current, `dsh-tui-*` is the pre-rename one. */
export type PluginSectionKey =
  | 'llm' | 'opencode' | 'azure' | 'china_gateways' | 'foreign_gateways' | 'theme' | 'update'

/** The settings namespaces each section used to be registered under, CURRENT
 *  spelling first so it wins when a document carries both. */
export const SECTION_NAMESPACES: Record<PluginSectionKey, readonly string[]> = {
  llm: ['qialike-llm', 'dsh-tui-llm'],
  opencode: ['qialike-opencode', 'dsh-tui-opencode'],
  azure: ['qialike-azure', 'dsh-tui-azure'],
  china_gateways: ['qialike-china-gateways', 'dsh-tui-china-gateways'],
  foreign_gateways: ['qialike-foreign-gateways', 'dsh-tui-foreign-gateways'],
  theme: ['qialike-theme', 'dsh-tui-theme'],
  update: ['qialike-update'],
}

/** The parsed config document. */
export interface TuiConfig {
  /** Whether launch auto-resumes the newest session in the same directory. */
  resume_last?: boolean
  /** Provider routes hidden from the /models first-level list (persisted). */
  hidden_providers?: string[]
  /** Right-sidebar visibility mode (persisted). */
  sidebar_mode?: SidebarMode
  /** LLM provider routes/templates (`TuiLlmSection`, typed at its consumer). */
  llm?: Record<string, unknown>
  opencode?: { enabled?: boolean }
  azure?: { enabled?: boolean }
  china_gateways?: { enabled?: boolean }
  foreign_gateways?: { enabled?: boolean }
  theme?: { colorscheme?: string; colors?: Record<string, string> }
  update?: { auto?: boolean | 'notify' }
  /** One-time record of the settings.yaml migration. Its PRESENCE is the latch:
   *  a section the user deletes later is never resurrected by a re-run. */
  settings_migrated?: { from: string; at: string; keys: readonly string[] }
}

/** Absolute path of the qialike config file. */
export function configPath(): string {
  return homeFilePath('qialike.json')
}

/** Read the config file; `{}` when absent or unparsable (never throws). */
export function readConfig(): TuiConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as TuiConfig
  } catch {
    // Missing or malformed file -> defaults.
  }
  return {}
}

/** Parse a boolean environment value; `undefined` when unrecognized. */
function parseBool(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case '1': case 'true': case 'yes': case 'on': return true
    case '0': case 'false': case 'no': case 'off': return false
    default: return undefined
  }
}

/**
 * Whether launch auto-resumes the newest same-directory session: config file
 * value, else the environment variable, else {@link DEFAULT_RESUME_LAST}. When
 * the environment variable is set it is also persisted into the config file so
 * it survives subsequent launches.
 * @returns the effective auto-resume flag.
 */
export function resolveResumeLast(): boolean {
  const envValue = process.env[RESUME_LAST_ENV]
  if (envValue !== undefined && envValue.trim() !== '') {
    const fromEnv = parseBool(envValue)
    if (fromEnv !== undefined) {
      persistConfig({ ...readConfig(), resume_last: fromEnv })
      return fromEnv
    }
  }
  const fromConfig = readConfig().resume_last
  return fromConfig ?? DEFAULT_RESUME_LAST
}

/** Write the config document (create the home dir if needed).
 *  @returns whether the write landed; callers that report failure need this. */
function persistConfig(config: TuiConfig): boolean {
  const path = configPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    // `mode` only applies when the file is CREATED; an older 0664 file keeps its
    // bits, so tighten explicitly (user configuration, like profiles/tui's 0700).
    chmodSync(path, 0o600)
    return true
  } catch {
    // Persisting is best-effort; an unwritable home must not crash the TUI.
    return false
  }
}

const sectionListeners = new Map<PluginSectionKey, Set<() => void>>()

/** One qialike-owned switch section, or `undefined` when unset (never throws). */
export function readSection<K extends PluginSectionKey>(key: K): TuiConfig[K] {
  return readConfig()[key]
}

/** Persist one section and notify its in-process watchers.
 *  @returns whether the write landed (watchers run either way). */
export function writeSection<K extends PluginSectionKey>(key: K, value: TuiConfig[K]): boolean {
  const written = persistConfig({ ...readConfig(), [key]: value } as TuiConfig)
  for (const listener of sectionListeners.get(key) ?? []) {
    try {
      listener()
    } catch (error) {
      logErrorFileOnly('config', error)
    }
  }
  return written
}

/** Watch one section; returns the unsubscribe. This replaces the settings
 *  service's `scope.watch()`, which 0.1.7 no longer offers. */
export function onSectionChange(key: PluginSectionKey, listener: () => void): () => void {
  const set = sectionListeners.get(key) ?? new Set<() => void>()
  sectionListeners.set(key, set)
  set.add(listener)
  return () => { set.delete(listener) }
}

/** Provider routes hidden from the /models first-level list (never throws). */
export function readHiddenProviders(): string[] {
  const list = readConfig().hidden_providers
  return Array.isArray(list) ? list.filter((route): route is string => typeof route === 'string') : []
}

/** Persist the hidden-provider route list (best-effort, merged into the config). */
export function setHiddenProviders(routes: readonly string[]): void {
  persistConfig({ ...readConfig(), hidden_providers: [...routes] })
}

/** The persisted right-sidebar mode; `auto` when unset or invalid (never throws). */
export function readSidebarMode(): SidebarMode {
  const mode = readConfig().sidebar_mode
  return mode === 'on' || mode === 'off' ? mode : 'auto'
}

/** Persist the right-sidebar visibility mode (best-effort). */
export function setSidebarMode(mode: SidebarMode): void {
  persistConfig({ ...readConfig(), sidebar_mode: mode })
}

/** The harness's pre-0.1.7 settings document and the name it renames it to.
 *  0.1.7's own importer renames `settings.yaml` to `.imported` before its first
 *  write, so BOTH spellings have to be read — `.imported` is the newer state. */
function legacySettingsSource(): string | undefined {
  const home = dirname(configPath())
  const imported = join(home, 'settings.yaml.imported')
  if (existsSync(imported)) return imported
  const plain = join(home, 'settings.yaml')
  return existsSync(plain) ? plain : undefined
}

/** One section's raw value from a legacy document, current namespace first. */
function legacySection(document: Record<string, unknown>, key: PluginSectionKey): unknown {
  for (const ns of SECTION_NAMESPACES[key]) {
    const value = document[ns]
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Move qialike's own switches from the harness's legacy `settings.yaml` into
 * `qialike.json`, ONCE, at the very start of `main()`.
 *
 * WHY IT IS NEEDED: through 0.1.5 qialike registered seven settings namespaces at
 * runtime (`qialike-llm`, `qialike-theme`, the four gateways, `qialike-update`)
 * and users' values live in `settings.yaml`. 0.1.7 removed runtime namespace
 * registration, and its own importer cannot take these either: `update(ns, …)`
 * rejects a namespace with no configurable plugin entry (`No configurable plugin
 * entry "…"`), so every qialike section would be logged and left behind in the
 * renamed document — i.e. silently dropped from the app's point of view.
 *
 * ORDERING: it runs before the plugin tree boots (and therefore before the
 * settings service's importer can rename the file), right after
 * `migrateLegacyHomeFiles()`. Whatever happens, the source file is left ALONE —
 * renaming it is the harness's job and two writers would corrupt it.
 *
 * SAFETY: only ADDS keys, never overwrites one already present in `qialike.json`
 * (a user's newer choice wins), never blocks boot, and leaves no marker behind
 * when it could not read the document, so the next launch retries.
 */
export function migrateLegacySettings(): void {
  try {
    const current = readConfig()
    if (current.settings_migrated !== undefined) return
    const source = legacySettingsSource()
    if (source === undefined) return
    const parsed: unknown = parseYaml(readFileSync(source, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logErrorFileOnly('config', new Error(`legacy settings ${source}: not a mapping; left in place`))
      return
    }
    const document = parsed as Record<string, unknown>
    const next: Record<string, unknown> = { ...current }
    const keys: string[] = []
    const skipped: string[] = []
    for (const key of Object.keys(SECTION_NAMESPACES) as PluginSectionKey[]) {
      if (next[key] !== undefined) continue
      const value = legacySection(document, key)
      if (value === undefined) continue
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        skipped.push(key)
        continue
      }
      next[key] = value
      keys.push(key)
    }
    next.settings_migrated = { from: basename(source), at: new Date().toISOString(), keys }
    persistConfig(next as TuiConfig)
    if (skipped.length > 0) {
      logErrorFileOnly('config', new Error(`legacy settings: skipped non-mapping section(s): ${skipped.join(', ')}`))
    }
  } catch (error) {
    // A migration hiccup must never keep the app from booting. No marker is
    // written, and the source stays untouched, so the next launch retries.
    logErrorFileOnly('config', error)
  }
}
