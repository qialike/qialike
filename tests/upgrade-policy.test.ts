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

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildMode,
  decideUpdate,
  getReleaseType,
  platformKind,
  readEnvPolicy,
  readUpdateSettings,
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
    platform: 'unix',
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

  test('a LAGGING source that reports an older tag must never be installed', () => {
    // The realistic shape of this: the user is on 0.6.1, GitHub is unreachable, and
    // the gitcode mirror has only caught up to 0.6.0. `getReleaseType` compares just
    // major and minor, so 0.6.0 against 0.6.1 classifies as a PATCH — without the
    // guard this would have been a silent downgrade, and the next check (with GitHub
    // reachable again) would have pushed the user back up, and so on.
    expect(decideUpdate(input({ installed: '0.6.1', latest: '0.6.0' }))).toEqual({ kind: 'up-to-date' })
    expect(decideUpdate(input({ installed: '0.6.1', latest: '0.5.9' }))).toEqual({ kind: 'up-to-date' })
    expect(decideUpdate(input({ installed: '1.0.0', latest: '0.9.9' }))).toEqual({ kind: 'up-to-date' })
    // ...and an unparseable tag is not "newer" either, so it cannot be installed
    // over a version we do understand.
    expect(decideUpdate(input({ installed: '0.6.1', latest: 'nightly' }))).toEqual({ kind: 'up-to-date' })
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

  test('Windows is announce-only: even a patch is news, never an install', () => {
    // The platform, not a preference: the installer's `mv` cannot replace a
    // running `.exe`, and the installer itself is bash, which Windows does not
    // ship. So the "patch installs silently" rule has no implementation there and
    // every newer release must reach the notice — including from a copy nobody's
    // installer manages, because a hand-placed binary is exactly the case that
    // still has to be told where to download.
    expect(decideUpdate(input({ platform: 'windows' }))).toEqual({ kind: 'notify', version: '0.6.1' })
    expect(decideUpdate(input({ platform: 'windows', method: 'unknown' }))).toEqual({ kind: 'notify', version: '0.6.1' })
    expect(decideUpdate(input({ platform: 'windows', latest: '0.7.0' }))).toEqual({ kind: 'notify', version: '0.7.0' })
    // The other gates still come first, Windows or not.
    expect(decideUpdate(input({ platform: 'windows', installed: '0.6.1' }))).toEqual({ kind: 'up-to-date' })
    expect(decideUpdate(input({ platform: 'windows', disabled: true }))).toEqual({ kind: 'skip', reason: 'disabled' })
    // ...and `auto: "notify"` is not where the platform gate lives: a POSIX copy
    // asked for notify-only still never installs either.
    expect(decideUpdate(input({ auto: 'notify' }))).toEqual({ kind: 'notify', version: '0.6.1' })
  })

  test('every platform maps onto the two families the policy distinguishes', () => {
    expect(platformKind('win32')).toBe('windows')
    expect(platformKind('linux')).toBe('unix')
    expect(platformKind('darwin')).toBe('unix')
    expect(platformKind('freebsd')).toBe('unix')
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
  // The switch moved from a runtime-registered settings namespace to
  // `qialike.json` (`update.auto`) when 0.1.7 removed those namespaces, so these
  // cases write that file instead of faking the settings service.
  let home = ''
  const withSection = (section: unknown): void => {
    home = mkdtempSync(join(tmpdir(), 'qialike-update-settings-'))
    process.env.DSH_HOME = home
    writeFileSync(join(home, 'qialike.json'), JSON.stringify(section === undefined ? {} : { update: section }))
  }
  afterEach(() => {
    if (home !== '') rmSync(home, { recursive: true, force: true })
    home = ''
    delete process.env.DSH_HOME
  })

  test('auto defaults to true, and only explicit values are honoured', () => {
    withSection(undefined)
    expect(readUpdateSettings()).toBe(true)
    withSection({})
    expect(readUpdateSettings()).toBe(true)
    withSection({ auto: true })
    expect(readUpdateSettings()).toBe(true)
    withSection({ auto: false })
    expect(readUpdateSettings()).toBe(false)
    withSection({ auto: 'notify' })
    expect(readUpdateSettings()).toBe('notify')
    // A malformed value falls back to the default rather than disabling updates.
    withSection({ auto: 'bogus' })
    expect(readUpdateSettings()).toBe(true)
    withSection('nonsense')
    expect(readUpdateSettings()).toBe(true)
  })
})
