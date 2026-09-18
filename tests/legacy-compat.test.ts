/**
 * Tests for the pre-rename name compatibility layer (`legacy-names.ts`).
 *
 * The rename to `qialike` must not cost a user anything that lives OUTSIDE the
 * shipped code: `$DSH_HOME` state files, `settings.yaml` sections, and exported
 * environment variables. Each rule is covered here, plus the two artifacts whose
 * spelling IS the product: the ASCII fallback wordmark and the embedded plugin
 * specifiers.
 *
 * Run with `bun test tests/legacy-compat.test.ts`.
 *
 * @module qialike/legacy-compat-test
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  ENV_PREFIX,
  HOME_FILE_NAMES,
  LEGACY_ENV_PREFIX,
  migrateLegacyHomeFiles,
  homeFilePath,
  legacyAwarePath,
  mirrorLegacyEnv,
  registerWithLegacy,
  type LegacySettingsHost,
} from '../packages/qialike-app/src/legacy-names.ts'
import { HERO_WORDMARK } from '../packages/qialike-app/src/hero-layout.ts'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const previousHome = process.env.DSH_HOME
const temps: string[] = []

function tempDshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qialike-legacy-'))
  temps.push(dir)
  process.env.DSH_HOME = dir
  return dir
}

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('legacy $DSH_HOME state files', () => {
  test('every legacy file is migrated once, and only when the current name is free', () => {
    const home = tempDshHome()
    writeFileSync(join(home, 'dsh-tui.json'), '{"resume_last":true}')
    writeFileSync(join(home, 'dsh-tui-titles.json'), '{"titles":{}}')
    // An already-current file always wins: a second boot must never clobber it.
    writeFileSync(join(home, 'qialike-activity.json'), '{"new":1}')
    writeFileSync(join(home, 'dsh-tui-activity.json'), '{"old":1}')

    const migrated = migrateLegacyHomeFiles()
    expect(migrated.sort()).toEqual(['qialike-titles.json', 'qialike.json'])
    expect(readFileSync(join(home, 'qialike.json'), 'utf8')).toBe('{"resume_last":true}')
    expect(existsSync(join(home, 'dsh-tui.json'))).toBe(false)
    expect(existsSync(join(home, 'dsh-tui-titles.json'))).toBe(false)
    expect(readFileSync(join(home, 'qialike-activity.json'), 'utf8')).toBe('{"new":1}')
    expect(existsSync(join(home, 'dsh-tui-activity.json'))).toBe(true)
    // Idempotent: nothing left to move on the next boot.
    expect(migrateLegacyHomeFiles()).toEqual([])
  })

  test('homeFilePath reads the legacy name when the rename could not happen', () => {
    const home = tempDshHome()
    // Neither file: the current name is the write target.
    expect(homeFilePath('qialike.json')).toBe(join(home, 'qialike.json'))
    // Only the legacy file: read it in place (a read-only home never migrates).
    writeFileSync(join(home, 'dsh-tui.json'), '{}')
    expect(homeFilePath('qialike.json')).toBe(join(home, 'dsh-tui.json'))
    // Both: the current name wins.
    writeFileSync(join(home, 'qialike.json'), '{}')
    expect(homeFilePath('qialike.json')).toBe(join(home, 'qialike.json'))
    // A name this app never renamed is returned untouched.
    expect(homeFilePath('sessions')).toBe(join(home, 'sessions'))
  })

  test('legacyAwarePath applies the same rule inside a caller-chosen directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qialike-cache-'))
    temps.push(dir)
    const current = join(dir, 'qialike-charwidth.json')
    expect(legacyAwarePath(dir, 'qialike-charwidth.json')).toBe(current)
    writeFileSync(join(dir, 'dsh-tui-charwidth.json'), '{"sentinels":[1,1,1]}')
    expect(legacyAwarePath(dir, 'qialike-charwidth.json')).toBe(join(dir, 'dsh-tui-charwidth.json'))
    writeFileSync(current, '{"sentinels":[2,2,2]}')
    expect(legacyAwarePath(dir, 'qialike-charwidth.json')).toBe(current)
  })

  test('the rename table itself is the full, documented set', () => {
    expect(HOME_FILE_NAMES.map(([current, legacy]) => [current, legacy])).toEqual([
      ['qialike.json', 'dsh-tui.json'],
      ['qialike.log', 'dsh-tui.log'],
      ['qialike-titles.json', 'dsh-tui-titles.json'],
      ['qialike-activity.json', 'dsh-tui-activity.json'],
      ['qialike-pinned.json', 'dsh-tui-pinned.json'],
      ['qialike-charwidth.json', 'dsh-tui-charwidth.json'],
    ])
  })
})

describe('legacy environment variables', () => {
  test('a legacy variable fills the current name, and never overwrites one', () => {
    const env: NodeJS.ProcessEnv = {
      DSH_TUI_HERO_ART: 'off',
      DSH_TUI_STALL_MS: '2500',
      QIALIKE_STALL_MS: '9000',
      UNRELATED: 'x',
    }
    expect(mirrorLegacyEnv(env).sort()).toEqual(['QIALIKE_HERO_ART'])
    expect(env.QIALIKE_HERO_ART).toBe('off')
    expect(env.QIALIKE_STALL_MS, 'an explicit current name wins').toBe('9000')
    expect(env.UNRELATED).toBe('x')
    expect(ENV_PREFIX).toBe('QIALIKE_')
    expect(LEGACY_ENV_PREFIX).toBe('DSH_TUI_')
  })

  test('importing the module mirrors the process environment before any reader runs', () => {
    // The real proof of the module-load side effect: a fresh process with only
    // the legacy variable set must see the current one after the import. This is
    // what keeps module-scope reads (index.tsx debug flags, bin.ts splash) alive.
    const env = { ...process.env, DSH_TUI_HERO_ART: 'off' }
    delete env.QIALIKE_HERO_ART
    const script = `import('${REPO}/packages/qialike-app/src/legacy-names.ts')`
      + `.then(() => console.log('mirrored=' + String(process.env.QIALIKE_HERO_ART)))`
    const run = spawnSync('bun', ['-e', script], { cwd: REPO, env, encoding: 'utf8' })
    expect(run.stdout).toContain('mirrored=off')
    expect(run.status).toBe(0)
  })
})

describe('legacy settings namespaces', () => {
  const scope = { get: () => ({}), update: async () => {}, replace: async () => {}, watch: () => () => {} }

  function host(legacyUser: unknown, onRegister?: (ns: string) => void): LegacySettingsHost {
    return {
      register(ns: string) {
        onRegister?.(ns)
        return scope as never
      },
      describe: () => (legacyUser === undefined ? [] : [{ ns: 'dsh-tui-theme', user: legacyUser }]),
    }
  }

  test('the legacy user section becomes the base layer of the current namespace', () => {
    const registered: string[] = []
    registerWithLegacy(host({ colorscheme: 'gruvbox' }, (ns) => registered.push(ns)), 'qialike-theme', 'dsh-tui-theme', {})
    expect(registered, 'the legacy namespace is read first').toEqual(['dsh-tui-theme', 'qialike-theme'])
  })

  test('the base is the legacy USER layer, so a current write still wins', () => {
    // The scope receives `{ base }`; schema defaults and the current user layer
    // resolve on top, which is exactly "read the old name, write the new one".
    let options: unknown
    const settings: LegacySettingsHost = {
      register(ns: string, _schema: unknown, opts?: unknown) {
        if (ns === 'qialike-theme') options = opts
        return scope as never
      },
      describe: () => [{ ns: 'dsh-tui-theme', user: { colorscheme: 'gruvbox' } }],
    }
    registerWithLegacy(settings, 'qialike-theme', 'dsh-tui-theme', {})
    expect(options).toEqual({ base: { colorscheme: 'gruvbox' } })
  })

  test('no legacy section, or a non-object one, registers with no base', () => {
    for (const legacyUser of [undefined, null, 'nonsense']) {
      let options: unknown = 'unset'
      const settings: LegacySettingsHost = {
        register(_ns: string, _schema: unknown, opts?: unknown) { options = opts; return scope as never },
        describe: () => (legacyUser === undefined ? [] : [{ ns: 'dsh-tui-theme', user: legacyUser }]),
      }
      registerWithLegacy(settings, 'qialike-theme', 'dsh-tui-theme', {})
      expect(options).toEqual({})
    }
  })

  test('an unreadable legacy section never blocks the current registration', () => {
    const registered: string[] = []
    const settings: LegacySettingsHost = {
      register(ns: string) {
        registered.push(ns)
        if (ns === 'dsh-tui-theme') throw new Error('legacy section fails the schema')
        return scope as never
      },
      describe: () => [],
    }
    expect(() => registerWithLegacy(settings, 'qialike-theme', 'dsh-tui-theme', {})).not.toThrow()
    expect(registered).toEqual(['dsh-tui-theme', 'qialike-theme'])
  })
})

describe('renamed product surfaces', () => {
  test('the ASCII fallback wordmark spells the new name at the same 5x27 size', () => {
    expect(HERO_WORDMARK).toHaveLength(5)
    expect([...new Set(HERO_WORDMARK.map((l) => l.length))]).toEqual([27])
    expect(HERO_WORDMARK.join('')).toMatch(/^[# ]+$/)
    // Letters q i a l i k e, in the 3-column glyph grid the map defines.
    expect(HERO_WORDMARK).toEqual([
      '### ### ### #   ### #   ###',
      '# #  #    # #    #  # # # #',
      '# #  #  ### #    #  ##  ###',
      '###  #  # # #    #  # # #  ',
      '  # ### ### ### ### # # ###',
    ])
  })

  test('every settings namespace keeps a legacy read-through constant', () => {
    const files: readonly (readonly [file: string, marker: string])[] = [
      ['llm.ts', "export const TUI_LLM_LEGACY_NS = 'dsh-tui-llm'"],
      ['theme-plugin.ts', "const LEGACY_NS = 'dsh-tui-theme'"],
      ['opencode.ts', "const LEGACY_NS = 'dsh-tui-opencode'"],
      ['azure.ts', "const LEGACY_NS = 'dsh-tui-azure'"],
      ['china-gateways.ts', "const LEGACY_NS = 'dsh-tui-china-gateways'"],
      ['foreign-gateways.ts', "const LEGACY_NS = 'dsh-tui-foreign-gateways'"],
    ]
    for (const [file, marker] of files) {
      const source = readFileSync(join(REPO, 'packages/qialike-app/src', file), 'utf8')
      expect(source, `${file} declares its legacy namespace`).toContain(marker)
      expect(source, `${file} registers through the fallback helper`).toContain('registerWithLegacy(settings,')
    }
  })
})
