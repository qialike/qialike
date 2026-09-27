/**
 * `qialike uninstall` clears the harness home but KEEPS its `bin/` directory —
 * that is where the program itself lives, and on Windows a running executable
 * cannot be deleted — and it prints the exact command that removes that
 * directory by hand.
 *
 * The behaviour only exists behind the launcher's argv dispatch, so this test
 * bundles `apps/tui-bin/src/bin.ts` with bun (the same bundler the release build
 * uses) and runs the subcommand in a throwaway HOME. That keeps the promise
 * honest end to end instead of asserting on the source text.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const PATH_LINE = 'export PATH="$HOME/.dsh/bin:$PATH"'

/** A HOME with the install directory, some state, a dev symlink and the PATH line. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'qialike-uninstall-'))
  for (const dir of [['.dsh', 'bin'], ['.dsh', 'sessions'], ['.dsh', 'cache'], ['.local', 'bin']]) {
    mkdirSync(join(home, ...dir), { recursive: true })
  }
  writeFileSync(join(home, '.dsh', 'qialike.json'), '{}\n')
  writeFileSync(join(home, '.dsh', 'bin', 'qialike'), 'BIN\n')
  writeFileSync(join(home, '.bashrc'), `# mine\n\n${PATH_LINE}\n`)
  symlinkSync('/nowhere/qialike', join(home, '.local', 'bin', 'qialike'))
  return home
}

/** The launcher, bundled once for the whole file. */
function bundleLauncher(): string {
  const out = join(mkdtempSync(join(tmpdir(), 'qialike-bundle-')), 'launcher.js')
  const built = spawnSync('bun', ['build', '--target=node', `--outfile=${out}`, join(ROOT, 'apps/tui-bin/src/bin.ts')], {
    encoding: 'utf8',
  })
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr || built.stdout}`)
  return out
}

const LAUNCHER = bundleLauncher()

/** Run the launcher with `HOME`/`DSH_HOME` pointed at `home`. */
function run(home: string, args: readonly string[]): { status: number | null; out: string } {
  const done = spawnSync('bun', [LAUNCHER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh') },
  })
  return { status: done.status, out: `${done.stdout}${done.stderr}` }
}

describe('qialike uninstall keeps the install directory', () => {
  test('state goes, bin/ stays, the dev symlink and the PATH line go', () => {
    const home = fakeHome()
    try {
      const { status, out } = run(home, ['uninstall'])
      expect(status, out).toBe(0)
      // The program itself survives — that is the whole point of the change.
      expect(existsSync(join(home, '.dsh', 'bin', 'qialike')), 'the binary in bin/ must survive').toBe(true)
      // Everything else under the home is state, and state goes.
      expect(existsSync(join(home, '.dsh', 'qialike.json'))).toBe(false)
      expect(existsSync(join(home, '.dsh', 'sessions'))).toBe(false)
      expect(existsSync(join(home, '.dsh', 'cache'))).toBe(false)
      // The dev symlink and the PATH line are still cleaned up.
      expect(lstatSync(join(home, '.local', 'bin', 'qialike'), { throwIfNoEntry: false })).toBeUndefined()
      expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('# mine\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('it prints the kept path and the exact command that removes it', () => {
    const home = fakeHome()
    try {
      const { out } = run(home, ['uninstall'])
      const kept = join(home, '.dsh', 'bin')
      expect(out).toContain(`kept ${kept}`)
      // Platform-appropriate and quoted, so it can be pasted as-is.
      const command = process.platform === 'win32' ? `Remove-Item -Recurse -Force "${kept}"` : `rm -rf "${kept}"`
      expect(out, `expected the run to print ${command}`).toContain(command)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('--help names both spellings and points at the printed command', () => {
    const home = fakeHome()
    try {
      const { status, out } = run(home, ['uninstall', '--help'])
      expect(status).toBe(0)
      expect(out).toContain('~/.dsh/bin')
      expect(out).toContain('%USERPROFILE%\\.dsh\\bin')
      expect(out).toContain('prints')
      // `--help` must never remove anything.
      expect(existsSync(join(home, '.dsh', 'qialike.json')), '--help must not uninstall').toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
