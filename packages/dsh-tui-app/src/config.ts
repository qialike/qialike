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

/** Built-in default below which the right sidebar hides. */
export const DEFAULT_SIDEBAR_MIN = 110

/** Environment variable that overrides {@link DEFAULT_SIDEBAR_MIN} and is persisted. */
export const SIDEBAR_MIN_ENV = 'DSH_TUI_SIDEBAR_MIN'

/** The parsed config document. */
export interface TuiConfig {
  /** Terminal width (columns) below which the sidebar hides. */
  sidebar_min?: number
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

/**
 * Effective sidebar-min threshold: config file value, else the environment
 * variable, else the default. When the environment variable is set it is also
 * persisted into the config file so it survives subsequent launches.
 * @returns the effective minimum width for showing the sidebar.
 */
export function resolveSidebarMin(): number {
  const envValue = process.env[SIDEBAR_MIN_ENV]
  const fromEnv = envValue !== undefined && envValue.trim() !== '' ? Number(envValue) : undefined
  const fromConfig = readConfig().sidebar_min
  if (fromEnv !== undefined && Number.isFinite(fromEnv) && fromEnv >= 0) {
    persistConfig({ ...readConfig(), sidebar_min: fromEnv })
    return fromEnv
  }
  if (fromConfig !== undefined && Number.isFinite(fromConfig) && fromConfig >= 0) return fromConfig
  return DEFAULT_SIDEBAR_MIN
}

/** Persist the given sidebar-min value into the config file. */
export function persistSidebarMin(min: number): void {
  persistConfig({ ...readConfig(), sidebar_min: min })
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
