/**
 * Guards for the GitHub branch of `scripts/release/push-qialike-release.sh`.
 *
 * WHY THIS EXISTS. The script used to answer "does this release already exist?"
 * by asking whether the GET response *body* was non-empty. That body comes from
 * `gh_api`, which deliberately runs `curl --fail-with-body` so a 4xx body still
 * reaches stdout for the caller to print. So "body non-empty" was never a
 * success test: the 404 that means "no release yet — create it" was read as
 * "already exists", the create branch was never taken, `jq '.id'` came back
 * empty, and every re-run stopped at the same line. The first release of any
 * version necessarily 404s, so this blocked the whole upload path — 0.7.1 hit it
 * and could not be published until the judgment was changed (see
 * qialike-development.md §9.4.16). The same misreading turned a 401 into the
 * same confusing "拿不到 release id" message.
 *
 * WHAT IS PINNED. Two behaviors, both of which have a live failure behind them:
 *   1. the judgment is the **status code** — 404 must reach CREATE, 401 must be
 *      reported as a token problem, and neither may be mistaken for "已存在";
 *   2. the token/repo pre-flight runs **before any remote write** — a bad token
 *      must stop with git never asked to push, because the alternative (the way
 *      0.7.1 actually failed) is a tag already pushed and no release built.
 *
 * HOW. `curl` and `git` are stubbed on PATH, so nothing leaves the machine and
 * no credential is needed: the real script is driven end to end against a
 * fixture `dist/` with six assets and a real manifest. The stubs append every
 * invocation to a log, which is what "a POST happened" and "git was never
 * called" are asserted against — a unit test of a helper would not have caught
 * the original bug, because the bug was in how the caller read the helper.
 *
 * Run with `bun test tests/push-release-script.test.ts`.
 *
 * @module qialike/push-release-script-test
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const SCRIPT = join(REPO, 'scripts', 'release', 'push-qialike-release.sh')

/** The six release assets, in the order `sha256sums.txt` lists them. */
const ASSETS = [
  'qialike-linux-x64.tar.gz',
  'qialike-linux-arm64.tar.gz',
  'qialike-darwin-arm64.zip',
  'qialike-darwin-x64.zip',
  'qialike-windows-x64.zip',
  'qialike-windows-arm64.zip',
]

const TAG_SHA = '1111111111111111111111111111111111111111'
const VERSION = '0.7.1'

/** The script under test assumes GNU userland in its own manifest self-check
 *  (`sha256sum`, `stat -c%s`). Where those are missing — a macOS dev box — this
 *  suite cannot drive it meaningfully, so it skips instead of failing for a
 *  reason that has nothing to do with what it guards. */
const canRun =
  spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0
  && spawnSync('sha256sum', ['--version'], { stdio: 'ignore' }).status === 0
  && spawnSync('stat', ['-c%s', SCRIPT], { stdio: 'ignore' }).status === 0

/** Fixture `curl`: canned status + body per URL, and every call logged.
 *  4xx/5xx exit non-zero the way `--fail-with-body` does, so the script's
 *  `|| true` paths are exercised for real rather than assumed. */
const CURL_SHIM = `#!/usr/bin/env bash
args=("$@")
last="\${args[\${#args[@]}-1]}"
printf 'curl %s\\n' "\${args[*]}" >> "$SHIM_LOG"

status=200
body='{}'
case "$last" in
  */user)                     status="\${FIX_USER_STATUS:-200}"; body='{"login":"fixture"}' ;;
  */releases/tags/*)          status="\${FIX_RELEASE_STATUS:-200}"; body="\${FIX_RELEASE_BODY:-}"; [ -n "$body" ] || body='{"id":42}' ;;
  */releases)                 status=201; body='{"id":42}' ;;
  */releases/*/assets*)       status=200; body='[]' ;;
  */releases/assets/*)        status=204; body='' ;;
  */releases/download/*)      status="\${FIX_MANIFEST_STATUS:-200}"; body="$(cat "$FIX_MANIFEST")" ;;
  */repos/qialike/qialike)    status="\${FIX_REPO_STATUS:-200}"; body='{"full_name":"qialike/qialike"}' ;;
esac

want_code=0
for a in "\${args[@]}"; do case "$a" in *'%{http_code}'*) want_code=1 ;; esac; done
if [ "$want_code" = 1 ]; then printf '%s' "$status"; else printf '%s\\n' "$body"; fi

[ "$status" -ge 400 ] && exit 22
exit 0
`

/** Fixture `git`: the tag is already on the remote and identical to the local
 *  one, so tag sync takes its "no change needed" path and never pushes. */
const GIT_SHIM = `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$SHIM_LOG"
case "$*" in
  *'rev-parse refs/tags/'*) echo "${TAG_SHA}" ;;
  *'ls-remote --tags'*)     printf '%s\\trefs/tags/%s\\n' "${TAG_SHA}" "${VERSION}" ;;
  *'remote get-url'*)       echo 'https://github.com/qialike/qialike.git' ;;
esac
exit 0
`

let root = ''
let distDir = ''
let binDir = ''
let manifestPath = ''
let seq = 0

beforeAll(() => {
  if (!canRun) return
  root = mkdtempSync(join(tmpdir(), 'qialike-push-'))
  distDir = join(root, 'dist')
  binDir = join(root, 'bin')
  mkdirSync(distDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(join(root, 'repo'), { recursive: true })

  const lines: string[] = []
  for (const name of ASSETS) {
    const content = `fixture:${name}\n`
    writeFileSync(join(distDir, name), content)
    lines.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`)
  }
  manifestPath = join(distDir, 'sha256sums.txt')
  writeFileSync(manifestPath, `${lines.join('\n')}\n`)

  writeFileSync(join(binDir, 'curl'), CURL_SHIM, { mode: 0o755 })
  writeFileSync(join(binDir, 'git'), GIT_SHIM, { mode: 0o755 })
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function run(extraEnv: Record<string, string>) {
  const log = join(root, `calls-${++seq}.log`)
  const res = spawnSync('bash', [SCRIPT, '--source', 'github', VERSION], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SHIM_LOG: log,
      FIX_MANIFEST: manifestPath,
      QIALIKE_REPO: join(root, 'repo'),
      QIALIKE_DIST: distDir,
      GITHUB_TOKEN: 'fixture-token',
      GITHUB_REMOTE: 'https://github.com/qialike/qialike.git',
      GITHUB_REPO: 'qialike/qialike',
      ...extraEnv,
    },
  })
  return {
    status: res.status,
    out: res.stdout ?? '',
    err: res.stderr ?? '',
    calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
  }
}

const uploadCount = (calls: string) => calls.split('\n').filter((l) => l.includes('uploads.github.com')).length

describe('the GitHub release branch judges by status code, not by a non-empty body', () => {
  test.skipIf(!canRun)('a 404 goes to CREATE instead of being read as "已存在"', () => {
    const r = run({ FIX_RELEASE_STATUS: '404', FIX_RELEASE_BODY: '{"message":"Not Found","status":"404"}' })

    expect(r.err).not.toContain('拿不到 release id')
    expect(r.out).not.toContain('已存在')
    expect(r.out).toContain('release 0.7.1 已创建')
    expect(r.calls).toMatch(/-X POST .*\/repos\/qialike\/qialike\/releases$/m)
    expect(uploadCount(r.calls)).toBe(7)
    expect(r.out).toContain('推送完成')
    expect(r.status).toBe(0)
  })

  test.skipIf(!canRun)('a 401 on the probe is reported as a token problem, with nothing created', () => {
    const r = run({ FIX_RELEASE_STATUS: '401', FIX_RELEASE_BODY: '{"message":"Bad credentials","status":"401"}' })

    expect(r.status).toBe(1)
    expect(r.err).toContain('令牌无效')
    expect(r.err).not.toContain('已存在')
    expect(r.calls).not.toMatch(/-X POST/)
  })

  test.skipIf(!canRun)('a 200 reuses the existing release and uploads the manifest-checked set', () => {
    const r = run({ FIX_RELEASE_STATUS: '200', FIX_RELEASE_BODY: '{"id":42}' })

    expect(r.status).toBe(0)
    expect(r.out).toContain('release 0.7.1 已存在')
    expect(r.calls).not.toMatch(/-X POST .*\/repos\/qialike\/qialike\/releases$/m)
    expect(uploadCount(r.calls)).toBe(7)
    expect(r.out).toContain('GitHub 的 sha256sums.txt 与本地逐字节一致')
    expect(r.out).toContain('推送完成')
  })
})

describe('the token pre-flight runs before any remote write', () => {
  test.skipIf(!canRun)('an invalid token stops before git is even called', () => {
    const r = run({ FIX_USER_STATUS: '401' })

    expect(r.status).toBe(1)
    expect(r.err).toContain('令牌无效')
    expect(r.calls).not.toMatch(/^git /m)
    expect(r.calls).not.toMatch(/-X POST/)
  })

  test.skipIf(!canRun)('a token that cannot see the repository is named as such', () => {
    const r = run({ FIX_USER_STATUS: '200', FIX_REPO_STATUS: '404' })

    expect(r.status).toBe(1)
    expect(r.err).toContain('看不到')
    expect(r.calls).not.toMatch(/^git /m)
  })

  test.skipIf(!canRun)('a good token passes both probes and only then reaches the remotes', () => {
    const r = run({ FIX_USER_STATUS: '200', FIX_REPO_STATUS: '200', FIX_RELEASE_STATUS: '200' })

    expect(r.out).toContain('GitHub 令牌有效（GET /user）')
    expect(r.out).toContain('GitHub 令牌可访问 qialike/qialike')
    expect(r.calls).toMatch(/^git .*ls-remote/m)
    expect(r.status).toBe(0)
  })
})
