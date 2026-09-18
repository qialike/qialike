/**
 * Tests for `scripts/install`'s PATH handling.
 *
 * The installer writes into the user's shell profile, so its two failure modes
 * are silent by construction: it either claims a line is configured when it is
 * not, or it edits a file and says nothing useful about what the user still has
 * to fix. Both were hit for real:
 *
 *  - the "already configured" guard used `grep -F "$PATH_LINE"`, which also
 *    matched a COMMENTED-OUT copy of the same text — the state a profile ends up
 *    in when the line was disabled by hand. The installer then appended nothing
 *    and closed by telling the user to `source ~/.bashrc`, so `qialike: command
 *    not found` survived an install that reported success.
 *  - a PATH export naming the pre-rename product (`dsh-tui`) points at a
 *    checkout directory the rename removed. Nothing said so, and the failure
 *    reads as "the rename broke my command".
 *
 * Each case runs the real script against a throwaway HOME and a stand-in
 * `dist/qialike` (a 100 MB binary copy per case would pin nothing extra — the
 * script's own logic is the subject).
 *
 * Run with `bun test tests/install-script.test.ts`.
 *
 * @module qialike/install-script-test
 */

import { describe, expect, test } from 'bun:test'
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const INSTALL_SCRIPT = join(REPO, 'scripts', 'install')
/** The pre-rename command name. Tests are outside the rename-hygiene scan, so
 *  naming it here is how the guard's behaviour gets pinned. */
const LEGACY_NAME = 'dsh-tui'
const PATH_LINE = 'export PATH="$HOME/.dsh/bin:$PATH"'

const temporaries: string[] = []

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaries.push(dir)
  return dir
}

/** A throwaway checkout holding the real installer plus a stand-in binary. */
function fakeRepo(): string {
  const repo = tempDir('qialike-install-repo-')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'dist'), { recursive: true })
  copyFileSync(INSTALL_SCRIPT, join(repo, 'scripts', 'install'))
  const bin = join(repo, 'dist', 'qialike')
  writeFileSync(bin, '#!/bin/sh\necho qialike-stand-in\n')
  chmodSync(bin, 0o755)
  return repo
}

function fakeHome(bashrc?: string): string {
  const home = tempDir('qialike-install-home-')
  if (bashrc !== undefined) writeFileSync(join(home, '.bashrc'), bashrc)
  return home
}

/** Run the installer against `home`, with the install dir off PATH unless asked. */
function install(repo: string, home: string, options: { onPath?: boolean } = {}) {
  const path = options.onPath === true
    ? `${join(home, '.dsh', 'bin')}:${process.env.PATH ?? ''}`
    : process.env.PATH ?? ''
  const result = spawnSync('bash', [join(repo, 'scripts', 'install')], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home, PATH: path },
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function bashrcOf(home: string): string {
  return readFileSync(join(home, '.bashrc'), 'utf8')
}

/** Uncommented `export PATH=` lines only, i.e. what a shell would act on. */
function livePathLines(text: string): string[] {
  return text.split('\n').filter((line) => /^\s*export\s+PATH=/.test(line))
}

describe('the installer appends a PATH line the shell will actually read', () => {
  test('a commented-out copy does not count as configured', () => {
    const repo = fakeRepo()
    const home = fakeHome(`# ${LEGACY_NAME}\n# ${PATH_LINE}\nexport PATH="/opt/keep:$PATH"\n`)

    const { status, output } = install(repo, home)

    expect(status).toBe(0)
    expect(output).toContain('appended to')
    // The live line lands after the user's own lines, and the profile keeps
    // both of them: the installer adds a line, it never rewrites one.
    expect(bashrcOf(home).endsWith(`\n# qialike\n${PATH_LINE}\n`)).toBe(true)
    expect(livePathLines(bashrcOf(home))).toContain('export PATH="/opt/keep:$PATH"')
    expect(output).toContain('commented-out copy')
  })

  test('an existing live line is reported, never duplicated', () => {
    const repo = fakeRepo()
    const home = fakeHome(`${PATH_LINE}\n`)

    const first = install(repo, home)
    const second = install(repo, home)

    expect(first.status).toBe(0)
    expect(second.status).toBe(0)
    expect(second.output).toContain('already exports')
    expect(livePathLines(bashrcOf(home))).toEqual([PATH_LINE])
  })

  test('running twice leaves exactly one line (idempotent)', () => {
    const repo = fakeRepo()
    const home = fakeHome('# mine\n')

    install(repo, home)
    install(repo, home)

    expect(livePathLines(bashrcOf(home))).toEqual([PATH_LINE])
    expect(bashrcOf(home)).toContain('# qialike')
  })

  test('the closing hint never tells the user to source a profile that does not exist', () => {
    const repo = fakeRepo()
    const home = fakeHome() // fresh HOME: neither .bashrc nor .zshrc

    const { status, output } = install(repo, home)

    expect(status).toBe(0)
    expect(output).not.toContain('source ')
    expect(output).toContain(PATH_LINE)
  })

  test('a profile that already covers the install dir is not edited', () => {
    const repo = fakeRepo()
    const home = fakeHome('# keep me\n')

    const { status, output } = install(repo, home, { onPath: true })

    expect(status).toBe(0)
    expect(output).toContain('is already on PATH')
    expect(bashrcOf(home)).toBe('# keep me\n')
  })
})

describe('the rename is reported where a user can act on it', () => {
  test('a stale pre-rename PATH entry is named with its file and line', () => {
    const repo = fakeRepo()
    const home = fakeHome(`# ${LEGACY_NAME}\nexport PATH="$HOME/deepseek/${LEGACY_NAME}/dist:$PATH"\n`)

    const { status, output } = install(repo, home)

    expect(status).toBe(0)
    expect(output).toContain('warning')
    // Naming the exact line is the whole point: the installer must not edit it
    // for the user, so the message has to be actionable on its own.
    expect(output).toContain(`${join(home, '.bashrc')}:2:export PATH="$HOME/deepseek/${LEGACY_NAME}/dist:$PATH"`)
    expect(output).toContain(`\`${LEGACY_NAME}\` was renamed to \`qialike\``)
    // Reported, not rewritten.
    expect(bashrcOf(home)).toContain(`${LEGACY_NAME}/dist`)
    // A commented-out entry is not a live one and must not be reported.
    expect(output).not.toContain(`.bashrc:1:`)
  })

  test('a commented-out pre-rename entry is not reported as a live PATH entry', () => {
    const repo = fakeRepo()
    const home = fakeHome(`# export PATH="$HOME/deepseek/${LEGACY_NAME}/dist:$PATH"\n`)

    const { output } = install(repo, home)

    expect(output).not.toContain('warning')
  })

  test('a pre-rename binary in the install dir is removed, and the rename is named', () => {
    const repo = fakeRepo()
    const home = fakeHome('# mine\n')
    const legacyDest = join(home, '.dsh', 'bin', LEGACY_NAME)
    mkdirSync(join(home, '.dsh', 'bin'), { recursive: true })
    writeFileSync(legacyDest, 'old build\n')

    const { status, output } = install(repo, home)

    expect(status).toBe(0)
    expect(existsSync(legacyDest)).toBe(false)
    expect(existsSync(join(home, '.dsh', 'bin', 'qialike'))).toBe(true)
    expect(output).toContain(`removed the pre-rename binary ${legacyDest}`)
    expect(output).toContain(`${LEGACY_NAME} is now qialike`)
  })
})
