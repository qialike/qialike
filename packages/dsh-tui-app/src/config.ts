/**
 * dsh-tui user configuration, stored as JSON at `$DSH_HOME/dsh-tui.json`
 * (default `~/.dsh/dsh-tui.json`).
 *
 * Resolution precedence for a setting: config file value > environment
 * variable > built-in default. When the environment variable is set at launch
 * the value is also written back into the config file, so it persists for later
 * runs without the variable (i.e. "env written into the config file").
 *
 * @module @yourname/dsh-tui-app/config
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Terminal width (columns) below which the right sidebar hides (auto). */
export const SIDEBAR_MIN_WIDTH = 110

/** Text columns actually available inside an embedded dock (approval /
 *  question) at terminal width `width`. The docks are flex children of the
 *  message column, so their real width excludes the sidebar (when shown),
 *  the message column's horizontal padding (2) and the dock's own border (2)
 *  + padding (2). Wrapping the detail window at this width keeps the rendered
 *  row count equal to the modalH estimate (conversation.tsx uses the same
 *  value); using the bare terminal width would re-wrap every line inside the
 *  narrower column and silently double the dock height. */
export function dockInnerWidth(width: number): number {
  const sidebar = width >= SIDEBAR_MIN_WIDTH ? Math.round(width * 0.3) + 2 : 0
  // Question dock content width: message column padding (1) + dock margins (3)
  // + dock border (1) + dock content padding (2) per side → content inset
  // 4 char-widths from each edge, matching the message content column.
  return Math.max(1, width - sidebar - 2 - 6 - 2 - 4)
}

/** Default for auto-resuming the newest same-directory session at launch. */
export const DEFAULT_RESUME_LAST = true

/** Environment variable that overrides the auto-resume default and is persisted. */
export const RESUME_LAST_ENV = 'DSH_TUI_RESUME_LAST'

/** The parsed config document. */
export interface TuiConfig {
  /** Whether launch auto-resumes the newest session in the same directory. */
  resume_last?: boolean
  /** Provider routes hidden from the /models first-level list (persisted). */
  hidden_providers?: string[]
}

/** Absolute path of the dsh-tui config file. */
export function configPath(): string {
  return dshHomePath('dsh-tui.json')
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

/** Write a config document atomically (create the home dir if needed). */
function persistConfig(config: TuiConfig): void {
  const path = configPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  } catch {
    // Persisting is best-effort; an unwritable home must not crash the TUI.
  }
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
