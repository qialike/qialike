/**
 * Tests for `upgrade-policy.ts` — the gate matrix.
 *
 * Every case here is a pure function call: no network, no filesystem, no Cordis
 * tree. The gate order is the part worth pinning, because reordering two `if`s
 * silently changes whether users are told about a release or have one installed
 * for them.
 *
 * Run with `bun test tests/upgrade-policy.test.ts`.
 *
 * @module qialike/upgrade-policy-test
 */

import { describe, expect, test } from 'bun:test'
import {
  buildMode,
  decideUpdate,
  getReleaseType,
  readEnvPolicy,
  readUpdateSettings,
  registerUpdateSettings,
  UPDATE_NS,
  type PolicyInput,
} from '../packages/qialike-app/src/upgrade-policy.ts'

/** A policy input that would install, so each test changes exactly one field. */
function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    installed: '0.6.0',
    latest: '0.6.1',
    auto: true,
    buildMode: 'beta',
    method: 'curl',
    disabled: false,
    alwaysNotify: false,
    ...overrides,
  }
}

describe('release classification', () => {
  test('major and minor moves are classified, everything else is a patch', () => {
    expect(getReleaseType('0.6.0', '0.7.0')).toBe('minor')
    expect(getReleaseType('0.6.0', '1.0.0')).toBe('major')
    expect(getReleaseType('0.6.0', '0.6.1')).toBe('patch')
    // Same version is a patch too (opencode's semantics): the caller checks
    // equality separately, before classification.
    expect(getReleaseType('0.6.0', '0.6.0')).toBe('patch')
    // A pre-release suffix does not move the release type on its own.
    expect(getReleaseType('0.6.0', '0.6.1-beta')).toBe('patch')
  })

  test('a `v` prefix and surrounding space are tolerated', () => {
    expect(getReleaseType('v0.6.0', 'v0.7.0')).toBe('minor')
    expect(getReleaseType(' 0.6.0 ', '0.6.1')).toBe('patch')
  })

  test('an unparseable version fails towards "announce, do not install"', () => {
    // 0.0 vs a real version reads as a major move, i.e. notify-only. Failing the
    // other way would silently auto-install over a version we did not understand.
    expect(getReleaseType('local', '0.6.1')).toBe('minor')
    expect(getReleaseType('', '0.6.1')).toBe('minor')
  })
})

describe('the gate matrix', () => {
  test('a patch release on a managed install is installed silently', () => {
    expect(decideUpdate(input())).toEqual({ kind: 'install', version: '0.6.1' })
  })

  test('minor and major releases are announced, never auto-installed', () => {
    expect(decideUpdate(input({ latest: '0.7.0' }))).toEqual({ kind: 'notify', version: '0.7.0' })
    expect(decideUpdate(input({ latest: '1.0.0' }))).toEqual({ kind: 'notify', version: '1.0.0' })
  })

  test('`auto: "notify"` announces even a patch release', () => {
    expect(decideUpdate(input({ auto: 'notify' }))).toEqual({ kind: 'notify', version: '0.6.1' })
  })

  test('`auto: false` stops the check entirely', () => {
    expect(decideUpdate(input({ auto: false }))).toEqual({ kind: 'skip', reason: 'disabled' })
  })

  test('the env kill switch wins over everything', () => {
    expect(decideUpdate(input({ disabled: true, alwaysNotify: true }))).toEqual({ kind: 'skip', reason: 'disabled' })
  })

  test('a dev build is never touched and never nagged', () => {
    // The gate opencode does not have: its install-method probe covers a checkout
    // build, but qialike's installer puts the binary in ~/.dsh/bin, so a dev build
    // installed there is indistinguishable from a release by path alone.
    expect(decideUpdate(input({ buildMode: 'dev' }))).toEqual({ kind: 'skip', reason: 'dev-build' })
    expect(decideUpdate(input({ buildMode: 'dev', alwaysNotify: true }))).toEqual({ kind: 'skip', reason: 'dev-build' })
  })

  test('beta and prod builds behave identically', () => {
    expect(decideUpdate(input({ buildMode: 'beta' }))).toEqual(decideUpdate(input({ buildMode: 'prod' })))
  })

  test('an already-current version does nothing', () => {
    expect(decideUpdate(input({ latest: '0.6.0' }))).toEqual({ kind: 'up-to-date' })
  })

  test('`alwaysNotify` announces even an already-current version', () => {
    // It is checked before the equality short-circuit, matching opencode.
    expect(decideUpdate(input({ latest: '0.6.0', alwaysNotify: true }))).toEqual({ kind: 'notify', version: '0.6.0' })
  })

  test('an unmanaged install is skipped for patches but still told about minor releases', () => {
    // A ~/.local/bin or checkout install cannot self-update, so a patch is not
    // announced (nothing the user could do changes the outcome) — but a minor or
    // major release IS announced, because that is the news they must act on by
    // reinstalling. This mirrors opencode checking its notify branch before its
    // install-method branch.
    expect(decideUpdate(input({ method: 'unknown' }))).toEqual({ kind: 'skip', reason: 'unmanaged-install' })
    expect(decideUpdate(input({ method: 'unknown', latest: '0.7.0' }))).toEqual({ kind: 'notify', version: '0.7.0' })
  })
})

describe('environment overrides', () => {
  test('the documented truthy spellings are accepted', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      const policy = readEnvPolicy({ QIALIKE_DISABLE_AUTOUPDATE: value } as NodeJS.ProcessEnv)
      expect(policy.disabled, `${value} should disable`).toBe(true)
    }
    expect(readEnvPolicy({ QIALIKE_DISABLE_AUTOUPDATE: '0' } as NodeJS.ProcessEnv).disabled).toBe(false)
    expect(readEnvPolicy({} as NodeJS.ProcessEnv).disabled).toBe(false)
    expect(readEnvPolicy({ QIALIKE_ALWAYS_NOTIFY_UPDATE: 'on' } as NodeJS.ProcessEnv).alwaysNotify).toBe(true)
  })

  test('the build channel comes from the baked constant, not the environment', () => {
    // The channel must not be re-labellable by the environment the binary is
    // launched in (build-mode.ts is generated at build time).
    expect(['beta', 'dev', 'prod']).toContain(buildMode())
  })
})

describe('settings access', () => {
  test('the namespace is registered under the documented name', () => {
    let registered: string | undefined
    registerUpdateSettings({
      get: () => ({ register: (ns: string) => { registered = ns } }),
    } as never)
    expect(registered).toBe(UPDATE_NS)
    expect(UPDATE_NS).toBe('qialike-update')
  })

  test('a missing settings service is not fatal', () => {
    expect(() => registerUpdateSettings({ get: () => undefined } as never)).not.toThrow()
    expect(readUpdateSettings({ get: () => undefined } as never)).toBe(true)
  })

  test('auto defaults to true, and only explicit values are honoured', () => {
    const withNode = (node: unknown) => ({ get: () => ({ get: () => node }) }) as never
    expect(readUpdateSettings(withNode(undefined))).toBe(true)
    expect(readUpdateSettings(withNode({}))).toBe(true)
    expect(readUpdateSettings(withNode({ auto: true }))).toBe(true)
    expect(readUpdateSettings(withNode({ auto: false }))).toBe(false)
    expect(readUpdateSettings(withNode({ auto: 'notify' }))).toBe('notify')
    // A malformed value falls back to the default rather than disabling updates.
    expect(readUpdateSettings(withNode({ auto: 'bogus' }))).toBe(true)
    expect(readUpdateSettings(withNode('nonsense'))).toBe(true)
  })
})
