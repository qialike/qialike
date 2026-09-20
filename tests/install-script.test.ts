/**
 * Behaviour of `scripts/install` — the networked downloader.
 *
 * The installer writes into the user's shell profile and replaces a binary that
 * may be running, so its interesting behaviours are the ones with silent failure
 * modes: claiming a line is configured when it is not, editing a file it cannot
 * write, or reporting success for an install that cannot work. Those are pinned
 * here; the download path itself is covered end to end in P5's fixture test.
 *
 * Everything runs offline: the cases that need no network source the modules and
 * call them directly, and the cases that need a refusal assert it happens BEFORE
 * any network access.
 *
 * Run with `bun test tests/install-script.test.ts`.
 *
 * @module qialike/install-script-test
 */

import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SCRIPT = join(REPO, 'scripts', 'install')

/** The exact text `qialike uninstall` matches when it takes the line back out. */
const PATH_LINE = 'export PATH="$HOME/.dsh/bin:$PATH"'

/** A PATH that cannot contain the install dir, so `ensure_path` always works. */
const BARE_PATH = '/usr/bin:/bin'

const temporaries: string[] = []
process.on('exit', () => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaries.push(dir)
  return dir
}

/** Run the installer as the user would (`bash scripts/install …`). */
function install(args: string[], options: { home: string; env?: Record<string, string> }) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: options.home, PATH: BARE_PATH, ...options.env },
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/**
 * Source the assembled bundle and run `snippet` against it. `LIB_ONLY` stops the
 * bundle's trailing `main "$@"`, so this exercises the modules without installing.
 */
function library(snippet: string, options: { home: string; env?: Record<string, string> }) {
  const result = spawnSync('bash', ['-c', `source "$1/scripts/install"; ${snippet}`, 'bash', REPO], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: options.home,
      PATH: BARE_PATH,
      QIALIKE_INSTALL_LIB_ONLY: '1',
      ...options.env,
    },
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** Uncommented `export PATH=` lines only, i.e. what a shell would act on. */
function livePathLines(text: string): string[] {
  return text.split('\n').filter((line) => /^\s*export\s+PATH=/.test(line))
}

function bashrcOf(home: string): string {
  return readFileSync(join(home, '.bashrc'), 'utf8')
}

function fakeHome(bashrc?: string): string {
  const home = tempDir('qialike-install-home-')
  if (bashrc !== undefined) writeFileSync(join(home, '.bashrc'), bashrc)
  return home
}

describe('the artifact keeps the contracts other code depends on', () => {
  const text = readFileSync(SCRIPT, 'utf8')

  /** The script with comment lines removed — these contracts are about CODE.
   *  The modules deliberately name `DSH_HOME` and `$BASH_SOURCE` in prose to
   *  explain why neither is used, and matching that prose would be meaningless. */
  const code = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

  test('installs to ~/.dsh/bin, which is where uninstall looks', () => {
    // `uninstallSelf()` scans exactly $HOME/.local/bin and $HOME/.dsh/bin, so a
    // DSH_HOME override here would put the binary out of its reach.
    expect(code.includes('INSTALL_DIR="$HOME/.dsh/bin"'), 'INSTALL_DIR must be exactly $HOME/.dsh/bin').toBe(true)
    expect(code.includes('DSH_HOME'), 'INSTALL_DIR must not follow $DSH_HOME').toBe(false)
  })

  test('writes the exact PATH line and marker that uninstall removes', () => {
    expect(text.includes(`PATH_LINE='${PATH_LINE}'`), 'PATH_LINE must be the exact text uninstall matches').toBe(true)
    expect(text.includes("MARKER='# qialike'"), 'MARKER must be the exact comment uninstall drops').toBe(true)
  })

  test('never resolves BASH_SOURCE: it may arrive on stdin', () => {
    // Under `curl … | bash` there is no $0 and no $BASH_SOURCE to resolve, and
    // `set -u` would turn a reference into a fatal unbound variable.
    expect(code.includes('BASH_SOURCE'), 'the artifact must not reference $BASH_SOURCE').toBe(false)
  })

  test('has no local-binary channel and no pre-rename migration left', () => {
    // Both were removed by decision: the installer is a downloader now, and the
    // dsh-tui cleanup moved out of the install path.
    expect(code.includes('--binary'), 'the local-binary channel was removed').toBe(false)
    expect(code.includes('dsh-tui'), 'the pre-rename migration was removed').toBe(false)
  })
})

describe('arguments', () => {
  test('--help explains itself and exits 0', () => {
    const { status, output } = install(['--help'], { home: fakeHome() })
    expect(status).toBe(0)
    expect(output).toContain('Usage: install [options]')
    expect(output).toContain('--no-modify-path')
    expect(output).toContain('curl -fsSL https://qialike.com/install | bash')
  })

  test('an unknown option is an error, not a warning', () => {
    // A typo like `--no-modify-pth` must not silently edit the shell profile.
    const home = fakeHome('# mine\n')
    const { status, output } = install(['--no-modify-pth'], { home })
    expect(status).not.toBe(0)
    expect(output).toContain("unknown option '--no-modify-pth'")
    expect(bashrcOf(home)).toBe('# mine\n')
  })

  test('an option missing its argument is refused', () => {
    for (const flag of ['--version', '--base-url']) {
      const { status, output } = install([flag], { home: fakeHome() })
      expect(status, `${flag} without a value should fail`).not.toBe(0)
      expect(output).toContain('requires')
    }
  })

  test('a requested version is normalised to the bare tag', () => {
    // Local git tags carry a `v`; the GitHub release tag does not, and only the
    // bare form resolves (…/download/v0.5.4/… 404s).
    const home = fakeHome()
    const { status, output } = library(
      'REQUESTED_VERSION=v0.6.0; printf "tag=%s\\n" "$(qialike_resolve_version qialike-linux-x64.tar.gz)"',
      { home },
    )
    expect(status).toBe(0)
    expect(output).toContain('tag=0.6.0')
  })
})

describe('platforms without a published build are refused before any write', () => {
  test('a recognized-but-unreleased platform names itself and writes nothing', () => {
    const home = fakeHome()
    const { status, output } = install([], { home, env: { QIALIKE_INSTALL_TARGET: 'darwin-arm64' } })
    expect(status).not.toBe(0)
    expect(output).toContain("no published build for 'darwin-arm64'")
    expect(output).toContain('pnpm build --package')
    expect(existsSync(join(home, '.dsh'))).toBe(false)
  })

  test('an unknown platform is refused too', () => {
    const home = fakeHome()
    const { status, output } = install([], { home, env: { QIALIKE_INSTALL_TARGET: 'plan9-mips' } })
    expect(status).not.toBe(0)
    expect(output).toContain("unsupported platform 'plan9-mips'")
    expect(existsSync(join(home, '.dsh'))).toBe(false)
  })

  test ('--dry-run on the host platform reports the plan and writes nothing', () => {
    const home = fakeHome()
    const { status, output } = install(['--dry-run'], { home, env: { QIALIKE_INSTALL_TARGET: 'linux-x64' } })
    expect(status).toBe(0)
    expect(output).toContain('dry run — nothing will be written')
    expect(output).toContain('qialike-linux-x64.tar.gz')
    expect(output).toContain(join(home, '.dsh', 'bin', 'qialike'))
    expect(output).toContain(PATH_LINE)
    expect(existsSync(join(home, '.dsh'))).toBe(false)
  })
})

describe('the PATH line the shell will actually read', () => {
  test('a commented-out copy does not count as configured', () => {
    // The state a profile ends up in when the line was disabled by hand. Treating
    // it as configured is what let `qialike: command not found` survive an install
    // that reported success.
    const home = fakeHome(`# ${PATH_LINE}\nexport PATH="/opt/keep:$PATH"\n`)
    const { status, output } = library('qialike_ensure_path', { home })

    expect(status).toBe(0)
    expect(output).toContain('appended to')
    expect(bashrcOf(home).endsWith(`\n# qialike\n${PATH_LINE}\n`)).toBe(true)
    // The user's own line is never rewritten, only appended after.
    expect(livePathLines(bashrcOf(home))).toContain('export PATH="/opt/keep:$PATH"')
  })

  test('an equivalent live spelling counts, and is not duplicated', () => {
    // Matching on `.dsh/bin` rather than the whole line accepts a different
    // spelling; opencode's exact-line `grep -Fxq` would append a duplicate here.
    const home = fakeHome('export PATH="/home/someone/.dsh/bin:$PATH"\n')
    const { status, output } = library('qialike_ensure_path', { home })

    expect(status).toBe(0)
    expect(output).toContain('already exports')
    expect(livePathLines(bashrcOf(home))).toEqual(['export PATH="/home/someone/.dsh/bin:$PATH"'])
  })

  test('running twice leaves exactly one line', () => {
    const home = fakeHome('# mine\n')
    library('qialike_ensure_path', { home })
    library('qialike_ensure_path', { home })

    expect(livePathLines(bashrcOf(home))).toEqual([PATH_LINE])
    expect(bashrcOf(home)).toContain('# qialike')
  })

  test('an install dir already on PATH leaves the profile alone', () => {
    const home = fakeHome('# keep me\n')
    const { status, output } = library('qialike_ensure_path', {
      home,
      env: { PATH: `${join(home, '.dsh', 'bin')}:${BARE_PATH}` },
    })

    expect(status).toBe(0)
    expect(output).toContain('is already on PATH')
    expect(bashrcOf(home)).toBe('# keep me\n')
  })

  test('a fresh HOME is never told to source a profile that does not exist', () => {
    const home = fakeHome() // neither .bashrc nor .zshrc
    const { status, output } = library('qialike_ensure_path', { home })

    expect(status).toBe(0)
    expect(output).not.toContain('source ')
    expect(output).toContain(PATH_LINE)
  })

  test.skipIf(process.getuid?.() === 0)('an unwritable profile is reported, not fatal', () => {
    // `set -euo pipefail` would otherwise abort at the append and leave the user
    // with no idea which line to add.
    const home = fakeHome('# mine\n')
    chmodSync(join(home, '.bashrc'), 0o444)
    const { status, output } = library('qialike_ensure_path', { home })

    expect(status).toBe(0)
    expect(output).toContain('not writable')
    expect(output).toContain(PATH_LINE)
    expect(bashrcOf(home)).toBe('# mine\n')
  })
})

describe('--no-modify-path', () => {
  test('leaves the profile untouched and says so', () => {
    const home = fakeHome('# mine\n')
    const { status, output } = install(['--no-modify-path', '--dry-run'], {
      home,
      env: { QIALIKE_INSTALL_TARGET: 'linux-x64' },
    })

    expect(status).toBe(0)
    expect(output).toContain('left alone (--no-modify-path)')
    expect(bashrcOf(home)).toBe('# mine\n')
  })
})
