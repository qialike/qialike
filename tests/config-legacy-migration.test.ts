/**
 * The one-time move of qialike's own switches out of the harness's legacy
 * `settings.yaml` into `qialike.json`.
 *
 * WHY IT EXISTS: through harness 0.1.5 qialike registered seven settings
 * namespaces at runtime (`qialike-llm`, `qialike-theme`, the four gateways,
 * `qialike-update`) and users' values live in `settings.yaml`. 0.1.7 removed
 * runtime namespace registration, and its own importer cannot take them either —
 * `update(ns, …)` rejects a namespace with no configurable plugin entry — so
 * without this migration every user switch would silently fall back to its
 * default (measured: the maintainer's own `dsh-tui-llm:` section is 1435 lines).
 *
 * The properties pinned here are the ones that make the move safe:
 *   * every current AND pre-rename spelling is read;
 *   * the current spelling wins when a document carries both;
 *   * a value already in `qialike.json` is never overwritten;
 *   * the marker is a LATCH, so a section the user deletes later stays deleted;
 *   * `.imported` (what the harness renames the file to) is preferred;
 *   * nothing unreadable ever blocks a boot or leaves a marker behind.
 *
 * Run with `bun test tests/config-legacy-migration.test.ts`.
 *
 * @module qialike/config-legacy-migration-test
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  migrateLegacySettings,
  onSectionChange,
  readConfig,
  readSection,
  writeSection,
} from '../packages/qialike-app/src/config.ts'

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qialike-legacy-migrate-'))
  process.env.DSH_HOME = home
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

const configFile = (): string => join(home, 'qialike.json')
const readJson = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf8')) as Record<string, unknown>
const readConfigOr = (): Record<string, unknown> => (existsSync(configFile()) ? readJson() : {})
const writeSettings = (text: string, name = 'settings.yaml'): void => { writeFileSync(join(home, name), text) }

/** One section per spelling that has to keep working, plus a harness-owned one. */
const FULL_DOCUMENT = `ui-onboarding:
  completed: true
dsh-tui-llm:
  providers:
    openrouter:
      displayName: OpenRouter
      apiKeyEnv: OPENROUTER_API_KEY
dsh-tui-theme:
  colorscheme: gruvbox
dsh-tui-azure:
  enabled: false
qialike-opencode:
  enabled: false
dsh-tui-china-gateways:
  enabled: false
dsh-tui-foreign-gateways:
  enabled: false
qialike-update:
  auto: notify
`

describe('legacy settings.yaml -> qialike.json', () => {
  test('every spelling moves, and harness-owned sections are left alone', () => {
    writeSettings(FULL_DOCUMENT)
    migrateLegacySettings()

    const cfg = readJson()
    expect((cfg.llm as { providers?: Record<string, { displayName?: string }> }).providers?.openrouter?.displayName)
      .toBe('OpenRouter')
    expect((cfg.theme as { colorscheme?: string }).colorscheme).toBe('gruvbox')
    expect((cfg.azure as { enabled?: boolean }).enabled).toBe(false)
    expect((cfg.opencode as { enabled?: boolean }).enabled).toBe(false)
    expect((cfg.china_gateways as { enabled?: boolean }).enabled).toBe(false)
    expect((cfg.foreign_gateways as { enabled?: boolean }).enabled).toBe(false)
    expect((cfg.update as { auto?: unknown }).auto).toBe('notify')
    // `ui-onboarding` belongs to the harness: copying it would put another
    // component's schema into our file.
    expect(cfg['ui-onboarding']).toBeUndefined()
    const marker = cfg.settings_migrated as { from: string; keys: readonly string[] }
    expect(marker.from).toBe('settings.yaml')
    expect([...marker.keys].sort()).toEqual(
      ['azure', 'china_gateways', 'foreign_gateways', 'llm', 'opencode', 'theme', 'update'])
  })

  test('the current spelling wins when a document carries both', () => {
    writeSettings(`dsh-tui-theme:
  colorscheme: gruvbox
qialike-theme:
  colorscheme: dracula
`)
    migrateLegacySettings()
    expect((readJson().theme as { colorscheme?: string }).colorscheme).toBe('dracula')
  })

  test('a value already in qialike.json is never overwritten', () => {
    writeFileSync(configFile(), JSON.stringify({ theme: { colorscheme: 'nord' }, sidebar_mode: 'off' }))
    writeSettings('dsh-tui-theme:\n  colorscheme: gruvbox\n')
    migrateLegacySettings()
    const cfg = readJson()
    expect((cfg.theme as { colorscheme?: string }).colorscheme).toBe('nord')
    expect(cfg.sidebar_mode).toBe('off') // unrelated keys survive the read-modify-write
  })

  test('the marker is a latch: a section deleted later stays deleted', () => {
    writeSettings('qialike-theme:\n  colorscheme: gruvbox\n')
    migrateLegacySettings()
    expect(readConfig().theme).toBeDefined()

    const { theme: _dropped, ...rest } = readJson()
    writeFileSync(configFile(), JSON.stringify(rest))
    migrateLegacySettings() // would re-add it if the marker did not latch
    expect(readConfig().theme).toBeUndefined()
    expect(existsSync(join(home, 'settings.yaml'))).toBe(true) // the source is never touched
  })

  test('.imported (what the harness renames the file to) is preferred', () => {
    writeSettings('qialike-theme:\n  colorscheme: gruvbox\n')
    writeSettings('qialike-theme:\n  colorscheme: dracula\n', 'settings.yaml.imported')
    migrateLegacySettings()
    expect((readJson().theme as { colorscheme?: string }).colorscheme).toBe('dracula')
    expect((readJson().settings_migrated as { from: string }).from).toBe('settings.yaml.imported')
  })

  test('no document at all: no marker, no throw', () => {
    expect(() => migrateLegacySettings()).not.toThrow()
    expect(existsSync(configFile())).toBe(false)
  })

  test('malformed YAML leaves qialike.json untouched and writes NO marker', () => {
    writeFileSync(configFile(), JSON.stringify({ sidebar_mode: 'on' }))
    writeSettings('qialike-theme: [unclosed\n')
    expect(() => migrateLegacySettings()).not.toThrow()
    expect(readJson()).toEqual({ sidebar_mode: 'on' })
    // No marker: the next launch retries (the source is still there, untouched).
    writeSettings('qialike-theme:\n  colorscheme: gruvbox\n')
    migrateLegacySettings()
    expect((readJson().theme as { colorscheme?: string }).colorscheme).toBe('gruvbox')
  })

  test('a non-mapping section is skipped; the rest still move', () => {
    writeSettings('dsh-tui-azure: [not, a, mapping]\nqialike-theme:\n  colorscheme: gruvbox\n')
    migrateLegacySettings()
    const cfg = readJson()
    expect(cfg.azure).toBeUndefined()
    expect((cfg.theme as { colorscheme?: string }).colorscheme).toBe('gruvbox')
    expect((cfg.settings_migrated as { keys: readonly string[] }).keys).toEqual(['theme'])
  })

  test('the written config is private (0600)', () => {
    writeSettings('qialike-theme:\n  colorscheme: gruvbox\n')
    migrateLegacySettings()
    expect(statSync(configFile()).mode & 0o777).toBe(0o600)
  })
})

describe('section accessors replace the settings service', () => {
  test('writeSection persists and notifies its watcher', () => {
    const seen: number[] = []
    const off = onSectionChange('theme', () => seen.push(1))
    expect(writeSection('theme', { colorscheme: 'nord' })).toBe(true)
    off()
    writeSection('theme', { colorscheme: 'dracula' })
    expect(seen).toHaveLength(1)
    expect(readSection('theme')?.colorscheme).toBe('dracula')
  })

  test('reading an absent section is undefined, not a throw', () => {
    expect(readSection('llm')).toBeUndefined()
    expect(readConfig().settings_migrated).toBeUndefined()
  })
})
