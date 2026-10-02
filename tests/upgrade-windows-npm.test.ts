/**
 * `/upgrade` on Windows must install an npm copy instead of printing the
 * manual-download notice.
 *
 * The reported bug: on Windows, `/upgrade` asked only `platform !== 'win32'`, so
 * EVERY Windows copy took the detect-only hint path — including an npm install.
 * The user was told "download it and replace the file by hand" with two `.zip`
 * links, while `npm i -g @qialike/cli` (the one command their layout can actually
 * run, and the one the launcher already supports there) went unmentioned.
 *
 * The platform is not the question; the OWNER is. That predicate now lives once in
 * `upgrade-policy.ts` (`canSelfInstall`) because the launcher and the TUI both need
 * it, and this file pins both halves:
 *
 *  - BEHAVIOUR: the real `installMethod` probe against real Windows paths, fed into
 *    the real `canSelfInstall`, decides install-vs-notice for each layout.
 *  - WIRING: `index.tsx`'s `/upgrade` consults that predicate (a source-level pin,
 *    like the other TUI invariants that need a booted binary to reach at runtime).
 *
 * Run with `bun test tests/upgrade-windows-npm.test.ts`.
 *
 * @module qialike/upgrade-windows-npm-test
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canSelfInstall } from '../packages/qialike-app/src/upgrade-policy.ts'
import { INSTALLED_VIA_ENV, installMethod } from '../packages/qialike-app/src/self-update.ts'
import { updateNotice } from '../apps/tui-bin/src/upgrade-command.ts'

const WIN = 'win32'
/** Where `npm i -g @qialike/cli` puts the payload on Windows. */
const NPM_EXE = join('C:', 'Users', 'u', 'AppData', 'Roaming', 'npm', 'node_modules', '@qialike', 'cli-win32-x64', 'qialike.exe')
/** Where `scripts/install` would put it, were the installer able to run there. */
const home = join('C:', 'Users', 'u')
const CURL_EXE = join(home, '.dsh', 'bin', 'qialike.exe')
/** A hand-placed copy: a downloads folder, or a checkout build. */
const MANUAL_EXE = join('C:', 'Users', 'u', 'Downloads', 'qialike.exe')

/** The whole decision `/upgrade` makes, from the executable alone. */
function routesToInstall(execPath: string, env: NodeJS.ProcessEnv = {}): boolean {
  return canSelfInstall(installMethod(execPath, home, env), WIN)
}

describe('the Windows decision is the install owner, not the platform', () => {
  test('an npm copy installs itself — no manual download', () => {
    // Both signals the probe reads, since either can be the one present: the
    // launcher's variable, and the payload's own path under node_modules.
    expect(routesToInstall(NPM_EXE, { [INSTALLED_VIA_ENV]: 'npm' })).toBe(true)
    expect(routesToInstall(NPM_EXE, {})).toBe(true)
  })

  test('a hand-placed copy still gets the manual route', () => {
    // Nothing owns this file, so a download genuinely is the only way forward —
    // and that is the ONLY Windows case that should say so.
    expect(routesToInstall(MANUAL_EXE, {})).toBe(false)
  })

  test('an installer-managed copy cannot self-install on Windows either', () => {
    // The shell installer is bash plus `mv`; Windows has neither. Reaching this
    // path means the copy sits in the install dir, which the installer would own.
    expect(installMethod(CURL_EXE, home, {})).toBe('curl')
    expect(routesToInstall(CURL_EXE, {})).toBe(false)
  })

  test('the notice an npm copy must NOT be shown', () => {
    // The exact string the bug produced. Asserted against the real notice builder
    // so the wording cannot drift away from this test unnoticed.
    const manual = updateNotice({
      installed: '0.6.2', version: '0.6.3', canSelfInstall: false, urls: ['https://example/qialike-windows-x64.zip'],
    }).join('\n')
    expect(manual).toContain('replace the file by hand')
    // Which is why the predicate must be true for this copy: that notice is the
    // branch it would otherwise fall into, and an npm user cannot act on a `.zip`.
    const notice = updateNotice({
      installed: '0.6.2', version: '0.6.3', canSelfInstall: routesToInstall(NPM_EXE, {}), urls: [],
    }).join('\n')
    expect(notice).not.toContain('replace the file by hand')
    expect(notice).toContain("run 'qialike upgrade'")
  })
})

describe('the TUI /upgrade is wired to that predicate', () => {
  const index = readFileSync(join(import.meta.dir, '..', 'packages', 'qialike-app', 'src', 'index.tsx'), 'utf8')

  /** The body of the `/upgrade` command registration. */
  const upgradeRun = (): string => {
    const at = index.indexOf("name: 'upgrade'")
    expect(at, "the /upgrade command is registered").toBeGreaterThan(-1)
    const end = index.indexOf('})\n', at)
    return index.slice(at, end === -1 ? index.length : end)
  }

  test('it consults canSelfInstall instead of the platform alone', () => {
    const body = upgradeRun()
    expect(body).toContain('canSelfInstall(installMethod(), process.platform)')
    // The predicate gates the hint path: only a copy it rejects may reach it.
    const gate = body.indexOf('canSelfInstall(')
    const hint = body.indexOf('checkUpdateOnWindows()')
    expect(gate, 'the predicate is consulted').toBeGreaterThan(-1)
    expect(hint, 'the Windows hint path is still there').toBeGreaterThan(-1)
    expect(gate, 'the predicate is checked BEFORE the hint path').toBeLessThan(hint)
  })

  test('the platform is still the outer gate, so POSIX is untouched', () => {
    // Linux/macOS keep the pre-existing flow byte for byte: their `/upgrade` runs
    // the launcher (which installs, or refuses an unmanaged copy) and never takes
    // the Windows hint path.
    const body = upgradeRun()
    const platformGate = body.indexOf("process.platform !== 'win32'")
    expect(platformGate, 'the non-Windows early return exists').toBeGreaterThan(-1)
    expect(platformGate).toBeLessThan(body.indexOf('canSelfInstall('))
    expect(body).toContain('installUpdate(); return')
  })

  test('the hint path is documented as the manual copy it now serves', () => {
    // `updateNoticeLines` says "download it and replace the file by hand", which is
    // only true for the copy that reaches it. The docstring has to say so, or the
    // next reader will re-widen the gate thinking it is "the Windows path".
    // Asserted as booleans: a `toContain` on a 7k-line file prints the whole thing.
    expect(index.includes('The `/upgrade` for a Windows copy the updater CANNOT replace')).toBe(true)
    expect(index.includes("Reached only for a copy nobody's package manager owns")).toBe(true)
  })
})

describe('the launcher still owns the route (no second implementation in the TUI)', () => {
  test('canSelfInstall is defined once, in the shared policy module', () => {
    const policy = readFileSync(join(import.meta.dir, '..', 'packages', 'qialike-app', 'src', 'upgrade-policy.ts'), 'utf8')
    const launcher = readFileSync(join(import.meta.dir, '..', 'apps', 'tui-bin', 'src', 'upgrade-command.ts'), 'utf8')
    expect(policy).toContain('export function canSelfInstall(')
    // The launcher re-exports the shared one rather than defining its own.
    expect(launcher).toContain('export { canSelfInstall }')
    expect(launcher).not.toContain('export function canSelfInstall(')
  })
})
