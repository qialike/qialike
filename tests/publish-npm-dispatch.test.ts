/**
 * Guards the `--dispatch` path of `scripts/release/publish-npm.sh` — the path that
 * publishes to npm **through CI** instead of from the machine running the script.
 *
 * WHY THIS EXISTS. Trusted publishing's credential is a short-lived OIDC token that
 * GitHub Actions mints per run; a workstation cannot mint one. So `--oidc` can only
 * ever work *inside* CI, and a local user who wants OIDC needs the script to trigger
 * the workflow rather than publish itself. Three ways to get that wrong are invisible
 * by reading:
 *   - the local path still stages binaries and calls `npm publish` (publishing with
 *     whatever stale credential the machine happens to hold — exactly what OIDC is
 *     meant to replace);
 *   - `--dry-run` is not forwarded, so a rehearsal publishes for real;
 *   - the workflow is dispatched before the Release carries the assets it downloads,
 *     which is the same failure the 0.8.3 release hit (published 2 s before the
 *     Windows zips finished uploading).
 * Each is pinned here as an observation: what `gh` was asked to do, and whether `npm`
 * was ever invoked.
 *
 * HOW. `gh` is stubbed on PATH and every invocation is appended to a log. The stub
 * answers the five subcommands the path uses (`api`, `release view`, `run list`,
 * `workflow run`, `run watch`) from environment switches, so the failure branches are
 * reachable without a network or a token.
 *
 * Run with `bun test tests/publish-npm-dispatch.test.ts`.
 *
 * @module qialike/publish-npm-dispatch-test
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const SCRIPT = join(REPO, 'scripts', 'release', 'publish-npm.sh')

let work = ''
let stubBin = ''
let callLog = ''
let runCounter = ''

/** The version the script resolves by default: the repo's own `package.json`. */
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version

/** The slug the fixture answers as; `GITHUB_REPO` pins it so the test is origin-independent. */
const SLUG = 'qialike/qialike'

/**
 * Stub `gh`: logs every call and answers from environment switches.
 *
 * `run list` returns nothing on its first call and a run id afterwards — that is the
 * shape the script relies on to tell "the run I just dispatched" from "the one that
 * was already there", so the stub has to reproduce the *transition*, not just a value.
 */
function writeGhStub(): void {
  const shim = `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> "$SHIM_LOG"
case "$1" in
  api)
    if [[ "\${SHIM_WF_STATUS:-200}" != 200 ]]; then
      printf '{"message":"Not Found","status":"%s"}\\n' "$SHIM_WF_STATUS" >&2
      exit 1
    fi
    printf '{"name":"publish-npm.yml"}\\n'
    ;;
  release)
    if [[ "\${SHIM_RELEASE_MISSING:-0}" == 1 ]]; then exit 1; fi
    if [[ "\${SHIM_RELEASE_NO_ASSETS:-0}" == 1 ]]; then printf 'qialike-linux-x64.tar.gz\\n'; exit 0; fi
    printf 'qialike-windows-x64.zip\\nqialike-windows-arm64.zip\\nsha256sums.txt\\n'
    ;;
  run)
    case "$2" in
      list)
        n="$(cat "$SHIM_RUNCOUNTER" 2>/dev/null || printf '0')"
        printf '%s' "$((n + 1))" > "$SHIM_RUNCOUNTER"
        [[ "$n" == 0 ]] || printf '4242\\n'
        ;;
      watch)
        printf 'run 4242 completed\\n'
        exit "\${SHIM_WATCH_RC:-0}"
        ;;
    esac
    ;;
  workflow) printf 'dispatched\\n' ;;
  auth)     exit 0 ;;
esac
exit 0
`
  writeFileSync(join(stubBin, 'gh'), shim)
  chmodSync(join(stubBin, 'gh'), 0o755)
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'qialike-npm-dispatch-'))
  stubBin = join(work, 'bin')
  callLog = join(work, 'calls.log')
  runCounter = join(work, 'runcounter')
  mkdirSync(stubBin)
  writeFileSync(callLog, '')
  writeGhStub()
})

afterAll(() => {
  if (work !== '') rmSync(work, { recursive: true, force: true })
})

/**
 * Drive the real script once, from a clean call log.
 * @param extra - flags to append after the shared ones.
 * @param env - environment overrides (stub switches).
 * @returns the exit status and the `gh` call log.
 */
function run(extra: string[], env: Record<string, string> = {}) {
  writeFileSync(callLog, '')
  writeFileSync(runCounter, '0')
  const result = spawnSync(
    'bash',
    [SCRIPT, '--yes', '--allow-dirty', '--allow-untagged', '--dispatch', ...extra],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        SHIM_LOG: callLog,
        SHIM_RUNCOUNTER: runCounter,
        // A token is present so the stub's `auth status` is not consulted; the API
        // calls themselves are what the assertions read.
        GH_TOKEN: 'fixture-token',
        GITHUB_REPO: SLUG,
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

describe('--dispatch hands the publish to CI instead of doing it here', () => {
  test('it never invokes npm, and dispatches the workflow for this version', () => {
    const { status, calls } = run([])
    expect(status).toBe(0)
    // The whole point: this machine uploaded nothing. A local `npm publish` here would
    // mean the OIDC guarantee was replaced by whatever credential the machine holds.
    expect(calls).not.toContain('npm publish')
    expect(calls).toContain(`gh workflow run publish-npm.yml --repo ${SLUG} -f version=${VERSION} -f dry_run=false`)
    // The run it just dispatched is the one it waits on.
    expect(calls).toContain('gh run watch 4242')
  })

  test('--dry-run is forwarded, so a rehearsal cannot publish for real', () => {
    const { status, calls } = run(['--dry-run'])
    expect(status).toBe(0)
    expect(calls).toContain(`-f version=${VERSION} -f dry_run=true`)
    expect(calls).not.toContain('dry_run=false')
  })

  test('the derived repository slug has no .git suffix', () => {
    // POSIX ERE has no lazy quantifier, so an optional `(\.git)?` in the same regex
    // as `[^/]+` is eaten by the greedy match and yields `owner/repo.git` — which then
    // 404s and masquerades as "the workflow is not on the default branch".
    const { status, calls } = run([], { GITHUB_REPO: '' })
    expect(status).toBe(0)
    const line = calls.split('\n').find((l) => l.includes('workflow run')) ?? ''
    expect(line).not.toContain('.git')
  })
})

describe('--dispatch refuses to trigger a publish CI cannot complete', () => {
  test('a Release without the Windows assets stops it before dispatching', () => {
    const { status, stderr, calls } = run([], { SHIM_RELEASE_NO_ASSETS: '1' })
    expect(status).toBe(1)
    expect(stderr).toContain('缺少资产')
    expect(calls).not.toContain('gh workflow run')
  })

  test('a missing Release stops it before dispatching', () => {
    const { status, calls } = run([], { SHIM_RELEASE_MISSING: '1' })
    expect(status).toBe(1)
    expect(calls).not.toContain('gh workflow run')
  })

  test('a workflow missing from the default branch names that cause, not a generic one', () => {
    const { status, stderr, calls } = run([], { SHIM_WF_STATUS: '404' })
    expect(status).toBe(1)
    expect(stderr).toContain('默认分支')
    expect(calls).not.toContain('gh workflow run')
  })

  test('an expired token is reported as auth, not as a missing workflow', () => {
    // Reporting 401 as "not on the default branch" sends the operator to push main,
    // which is a wasted trip: the workflow was fine, the credential was not.
    const { status, stderr } = run([], { SHIM_WF_STATUS: '401' })
    expect(status).toBe(1)
    expect(stderr).toContain('401')
    expect(stderr).not.toContain('默认分支')
  })

  test('a failing CI run is surfaced as a failure of this command', () => {
    const { status, stderr } = run([], { SHIM_WATCH_RC: '1' })
    expect(status).toBe(1)
    expect(stderr).toContain('CI 运行失败')
  })
})

describe('--dispatch does not silently combine with the other credential paths', () => {
  test('--oidc is refused: it means "inside CI", not "trigger CI"', () => {
    const { status, stderr, calls } = run(['--oidc'])
    expect(status).toBe(1)
    expect(stderr).toContain('互斥')
    expect(calls).not.toContain('gh workflow run')
  })

  test('--otp is refused: a one-time code is what OIDC replaces', () => {
    const { status, stderr, calls } = run(['--otp', '123456'])
    expect(status).toBe(1)
    expect(stderr).toContain('互斥')
    expect(calls).not.toContain('gh workflow run')
  })
})
