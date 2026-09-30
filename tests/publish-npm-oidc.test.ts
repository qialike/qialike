/**
 * Guards the OIDC (Trusted Publishing) path of `scripts/release/publish-npm.sh`.
 *
 * WHY THIS EXISTS. In CI the script has no token to check — the npm CLI obtains a
 * short-lived credential from the workflow's OIDC identity instead — so the
 * credential pre-flight must be *skipped*, not merely tolerated. Two ways to get
 * that wrong are invisible by reading:
 *   - the pre-flight still runs, `npm whoami` fails with ENEEDAUTH, and the whole
 *     publish is refused on a machine that was perfectly authorised (this is the
 *     same class of bug as the 403 veto we already hit once);
 *   - OIDC is requested on a CLI too old to recognise the environment, so npm
 *     silently falls back to "no credentials" instead of saying why.
 * So both are pinned here, together with the automatic detection of GitHub
 * Actions' OIDC environment variables.
 *
 * HOW. `npm` is stubbed on PATH and every invocation is appended to a log, so
 * "the pre-flight was skipped" is asserted as *the absence of a `whoami` call*
 * rather than as a message we might reword. Binaries come from a fixture `dist/`
 * (`QIALIKE_DIST`) holding two 50 MiB sparse files with a PE header — the
 * script's size floor and magic check are exercised for real, no build is
 * needed, and nothing leaves the machine: the stub answers every publish.
 *
 * Run with `bun test tests/publish-npm-oidc.test.ts`.
 *
 * @module qialike/publish-npm-oidc-test
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const SCRIPT = join(REPO, 'scripts', 'release', 'publish-npm.sh')

/** The size floor the script enforces, in bytes — the fixture must clear it. */
const FIFTY_MIB = 50 * 1024 * 1024

let work = ''
let stubBin = ''
let callLog = ''
let distDir = ''
let pubDir = ''

/** The placeholder `publish-npm.sh` rewrites before publishing. */
const PLACEHOLDER = '0.0.0-template'

/** The version the script resolves by default: the repo's own `package.json`. */
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version

/**
 * Stub `npm`: logs every call, answers the handful of subcommands the script
 * uses, and never touches the network. `whoami` deliberately fails — a real CI
 * machine has no account credentials at all, so a test that let it succeed would
 * not prove the pre-flight was skipped.
 *
 * `publish` also files away the package's README. The script stages a copy, edits
 * it, and deletes it on exit, so the README has to be captured *at this moment* —
 * it is the exact text npm would upload, and therefore the only honest place to
 * assert that no `0.0.0-template` reaches the package page.
 */
function writeNpmStub(): void {
  const shim = `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$SHIM_LOG"
case "$1" in
  --version) printf '%s\\n' "\${NPM_VERSION_FIXTURE:-11.5.1}" ;;
  view)      exit 1 ;;
  pack)      printf 'npm notice filename: fixture.tgz\\nnpm notice package size: 1 B\\n' ;;
  publish)   printf 'published (stub)\\n'
             cp README.md "$SHIM_PUBDIR/$(basename "$PWD").README.md" 2>/dev/null || true ;;
  whoami)    printf 'npm error code ENEEDAUTH\\n' >&2; exit 1 ;;
  *)         : ;;
esac
`
  writeFileSync(join(stubBin, 'npm'), shim)
  chmodSync(join(stubBin, 'npm'), 0o755)
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'qialike-npm-oidc-'))
  stubBin = join(work, 'bin')
  callLog = join(work, 'calls.log')
  distDir = join(work, 'dist')
  pubDir = join(work, 'published')
  mkdirSync(stubBin)
  mkdirSync(pubDir)
  writeFileSync(callLog, '')
  writeNpmStub()

  // A PE header plus the size floor is all the script checks before staging, so a
  // sparse 50 MiB file stands in for the real 130 MB build.
  for (const arch of ['x64', 'arm64']) {
    const dir = join(distDir, `windows-${arch}`)
    mkdirSync(dir, { recursive: true })
    const exe = join(dir, 'qialike.exe')
    writeFileSync(exe, 'MZ')
    truncateSync(exe, FIFTY_MIB)
    chmodSync(exe, 0o755)
  }
})

afterAll(() => {
  if (work !== '') rmSync(work, { recursive: true, force: true })
})

/**
 * Drive the real script once, from a clean call log.
 * @param extra - flags to append after the shared ones.
 * @param env - environment overrides (OIDC variables, npm version fixture).
 * @returns the exit status, the captured output and the npm call log.
 */
function run(extra: string[], env: Record<string, string> = {}) {
  writeFileSync(callLog, '')
  // Fresh capture dir per run, so one test cannot read another's package.
  rmSync(pubDir, { recursive: true, force: true })
  mkdirSync(pubDir)
  const result = spawnSync(
    'bash',
    [SCRIPT, '--yes', '--allow-dirty', '--allow-untagged', '--tag', 'latest', ...extra],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        SHIM_LOG: callLog,
        SHIM_PUBDIR: pubDir,
        QIALIKE_DIST: distDir,
        NPM_VERSION_FIXTURE: '11.5.1',
        // No credentials of any kind: the token path must have nothing to fall back on.
        NODE_AUTH_TOKEN: '',
        NPM_TOKEN: '',
        ACTIONS_ID_TOKEN_REQUEST_URL: '',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
        ...env,
      },
    },
  )
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls: readFileSync(callLog, 'utf8'),
  }
}

/**
 * The README of a package **as npm received it**, or `undefined` when that
 * package carried none. Reads what the stub filed away during `npm publish`.
 * @param pkg - the package name, e.g. `@qialike/cli`.
 * @returns the published README text.
 */
function publishedReadme(pkg: string): string | undefined {
  const file = join(pubDir, `${pkg.replace(/^@/, '').replace(/\//g, '-')}.README.md`)
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

const OIDC_ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-request-token',
}

describe('--oidc skips the credential pre-flight and publishes with provenance', () => {
  test('a run with --oidc never asks whoami and passes --provenance', () => {
    const { status, calls } = run(['--oidc', '--provenance'])
    expect(status).toBe(0)
    // The whole point: no account-level probe happens on a tokenless machine.
    expect(calls).not.toContain('npm whoami')
    expect(calls).toContain('--provenance')
    // OIDC replaces the one-time password, it does not join it.
    expect(calls).not.toContain('--otp')
    // Two platform packages, then the main package, exactly as the token path does.
    expect(calls.match(/npm publish/g)?.length).toBe(3)
  })

  test('GitHub Actions OIDC variables are detected without the flag', () => {
    const { status, calls } = run([], OIDC_ENV)
    expect(status).toBe(0)
    expect(calls).not.toContain('npm whoami')
    expect(calls.match(/npm publish/g)?.length).toBe(3)
  })
})

describe('the token path is untouched when OIDC is not in play', () => {
  test('without --oidc and without the OIDC environment the pre-flight runs and refuses', () => {
    const { status, calls, stderr } = run([])
    // Control for the assertions above: with nothing to authenticate with, the
    // script must still probe whoami, refuse, and never reach a publish.
    expect(status).not.toBe(0)
    expect(calls).toContain('npm whoami')
    expect(calls).not.toContain('npm publish')
    expect(stderr).toContain('npm 未登录')
  })
})

describe('OIDC on a CLI that cannot use it is refused, not silently downgraded', () => {
  test('npm older than 11.5.1 stops the run before any publish', () => {
    const { status, calls, stderr } = run(['--oidc'], { NPM_VERSION_FIXTURE: '10.9.8' })
    expect(status).not.toBe(0)
    expect(stderr).toContain('11.5.1')
    expect(calls).not.toContain('npm publish')
  })
})

describe('the published README carries the release version, never the placeholder', () => {
  test('the reinstall example is rewritten on the copy npm receives', () => {
    // The npm package page IS this file, so a stale pin there is a user-facing
    // wrong command: 0.8.1 shipped with `…@0.8.2` in it (2026-09-30), and 0.8.3
    // would have shipped the same line again. Asserted on the staged copy at
    // publish time, which is the only version npm ever sees.
    const { status, calls } = run(['--oidc'])
    expect(status).toBe(0)
    expect(calls.match(/npm publish/g)?.length).toBe(3)

    const readme = publishedReadme('@qialike/cli')
    expect(readme, 'the main package must ship a README').toBeDefined()
    expect(readme).toContain(`@qialike/cli-win32-arm64@${VERSION}`)
    // One leftover placeholder would publish `npm i -g …@0.0.0-template`.
    expect(readme).not.toContain(PLACEHOLDER)
  })

  test('the platform packages carry no README to go stale', () => {
    // Control: the rewrite is scoped to the package that has one. If a platform
    // package ever grows a README, this fails and the guard needs widening.
    run(['--oidc'])
    expect(publishedReadme('@qialike/cli-win32-x64')).toBeUndefined()
    expect(publishedReadme('@qialike/cli-win32-arm64')).toBeUndefined()
  })
})
