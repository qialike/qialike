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

/**
 * The release body the scripts should compute for a version — read from the real
 * extractor rather than retyped, so this test cannot drift from what ships.
 * @param version - the version whose CHANGELOG entry is wanted.
 * @returns the section text the release body should carry.
 */
function notesFor(version: string): string {
  const r = spawnSync('bash', [join(REPO, 'scripts', 'release', 'changelog-section.sh'), version], { encoding: 'utf8' })
  return (r.stdout ?? '').replace(/\n$/, '')
}

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
  # GET /releases/<id> — the draft probe that decides whether to emit the single
  # published event. null is valid JSON, so an unset fixture leaves the release
  # looking already-published (the idempotent re-run path).
  */releases/42)              status=200; body="\${FIX_DRAFT_BODY:-null}" ;;
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

/** Index of the first logged line matching `re`, or -1. Used to assert ORDER. */
const lineAt = (calls: string, re: RegExp) => calls.split('\n').findIndex((l) => re.test(l))
/** Index of the LAST logged upload, or -1. */
const lastUploadAt = (calls: string) =>
  calls.split('\n').reduce((acc, l, i) => (l.includes('uploads.github.com') ? i : acc), -1)

describe('the release is published only after every asset is uploaded', () => {
  // WHY THIS EXISTS. A release created with `draft:false` makes GitHub emit
  // `release: published` in the same second the POST returns — before the assets
  // exist. `publish-npm.yml` triggers on that event and downloads the Windows zips,
  // so 0.8.3 measured published_at 14:58:43Z against assets finishing at
  // 14:59:26Z/14:59:38Z: the workflow's asset step could only 404. Creating the
  // release as a draft and publishing it last is what removes the window, and it is
  // an ORDER property — invisible in the two calls read separately.

  test.skipIf(!canRun)('a created release is a draft, then PATCHed after the uploads', () => {
    // FIX_DRAFT_BODY models the state the fixture's POST just left behind: the shim is
    // stateless across curl invocations, so the follow-up GET has to be told that the
    // release it created IS a draft (otherwise it answers `null` and the script
    // correctly concludes there is nothing to publish).
    const r = run({ FIX_RELEASE_STATUS: '404', FIX_DRAFT_BODY: '{"draft":true}' })

    expect(r.status).toBe(0)
    expect(r.out).toContain('已创建（draft')
    // The creation itself must NOT publish, or the event fires before the assets.
    expect(r.calls).toMatch(/-X POST[^\n]*"draft":true/)
    // …and the publish happens, by PATCH, strictly after the last upload.
    const patchAt = lineAt(r.calls, /-X PATCH/)
    expect(patchAt).toBeGreaterThan(-1)
    expect(r.calls).toMatch(/-X PATCH[^\n]*\{"draft":false\}/)
    expect(patchAt).toBeGreaterThan(lastUploadAt(r.calls))
    expect(uploadCount(r.calls)).toBe(7)
    expect(r.out).toContain('已发布（资产齐备后才发出 published 事件）')
  })

  test.skipIf(!canRun)('a draft left behind by an earlier run is published by this one', () => {
    // Re-running after a failure lands on the 200 branch with a draft on the remote;
    // it must still end published, or the release stays invisible forever.
    const r = run({ FIX_RELEASE_STATUS: '200', FIX_DRAFT_BODY: '{"draft":true}' })

    expect(r.status).toBe(0)
    expect(r.out).toContain('已存在')
    // Which PATCH matters here: the draft→published one. (A second PATCH may legitimately
    // appear — the release-body sync — and it is supposed to run BEFORE the uploads.)
    expect(lineAt(r.calls, /-X PATCH[^\n]*"draft"/)).toBeGreaterThan(lastUploadAt(r.calls))
  })

  test.skipIf(!canRun)('an already-published release is left alone, so no second event fires', () => {
    // The body is already the CHANGELOG entry, so neither PATCH should happen: not the
    // draft→published one (already published) nor the notes sync (already current).
    const r = run({
      FIX_RELEASE_STATUS: '200',
      FIX_RELEASE_BODY: JSON.stringify({ id: 42, body: notesFor(VERSION) }),
      FIX_DRAFT_BODY: '{"draft":false}',
    })

    expect(r.status).toBe(0)
    expect(r.calls).not.toMatch(/-X PATCH/)
    expect(r.out).toContain('已是发布状态（未改动，不重发事件）')
  })
})

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

describe('the release body is the CHANGELOG entry, not a placeholder', () => {
  // WHY THIS EXISTS. GitHub and GitCode show a release's body when you click a tag, and
  // it was the literal string `qialike <version>` — so no release ever showed what
  // changed (measured on 0.9.0: 13 characters). These pin the wiring: the body comes
  // from the repository CHANGELOG, in both languages, and an existing release whose body
  // does not match is PATCHed.

  test('the create request carries this version\'s CHANGELOG text, both languages', () => {
    const r = run({ FIX_RELEASE_STATUS: '404', FIX_DRAFT_BODY: '{"draft":true}' })

    expect(r.status).toBe(0)
    // Phrases only the 0.7.1 entry (the fixture version) contains, one per language.
    expect(r.calls).toContain('The installer verifies what it downloads')
    expect(r.calls).toContain('安装器会校验下载到的东西')
    // …and the old one-line placeholder is not what the create payload says.
    expect(r.calls).toMatch(/-X POST[^\n]*"body":"### Added/)
    expect(r.calls).not.toContain('"body":"qialike 0.7.1"')
  })

  test('an existing release with a stale body is PATCHed to the CHANGELOG', () => {
    const r = run({ FIX_RELEASE_STATUS: '200', FIX_RELEASE_BODY: '{"id":42,"body":"qialike 0.7.1"}' })

    expect(r.status).toBe(0)
    expect(r.calls).toMatch(/-X PATCH[^\n]*"body":"### Added/)
  })

  test('an existing release already carrying the CHANGELOG is left alone', () => {
    // Idempotence matters because re-running a push is routine: an unconditional PATCH
    // would rewrite the body on every run, and the drift it corrects is rare.
    const notes = notesFor(VERSION)
    const r = run({ FIX_RELEASE_STATUS: '200', FIX_RELEASE_BODY: JSON.stringify({ id: 42, body: notes }) })

    expect(r.status).toBe(0)
    expect(r.calls).not.toMatch(/-X PATCH/)
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
