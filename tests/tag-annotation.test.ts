/**
 * Guards the annotated tag's message — what `git show <tag>` prints, and what a host
 * shows for a tag that has no release page.
 *
 * WHY THIS EXISTS. The annotation is built from the CHANGELOG entry, and `git tag -F`
 * defaults to `--cleanup=strip`, which **deletes every line starting with `#`** because
 * git treats those as commentary. Markdown section headings are `### Changed` /
 * `### 变更`, so the naive form silently published a bullet list with no indication of
 * whether each item was a change, a fix or an addition — a data-loss bug that no test
 * would notice by reading the script, and that the operator cannot see without
 * inspecting the tag object itself.
 *
 * The other invariant: the first line must still contain `qialike <version>`, because
 * `tag-qialike.sh`'s own three-way verification asserts it.
 *
 * Run with `bun test tests/tag-annotation.test.ts`.
 *
 * @module qialike/tag-annotation-test
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
/** The version whose CHANGELOG entry the fixture carries. */
const VERSION = '0.9.0'

let work = ''

/** Run a git command in the fixture repo and return its stdout. */
function git(args: string[]): string {
  const r = spawnSync('git', ['-C', work, ...args], { encoding: 'utf8' })
  return r.stdout ?? ''
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'qialike-tag-'))
  git(['init', '-q'])
  git(['config', 'user.email', 'fixture@example.invalid'])
  git(['config', 'user.name', 'fixture'])
  mkdirSync(join(work, 'scripts', 'release'), { recursive: true })
  mkdirSync(join(work, 'packages', 'qialike-app'), { recursive: true })
  mkdirSync(join(work, 'apps', 'tui-bin'), { recursive: true })
  for (const f of ['changelog-section.sh', 'tag-qialike.sh']) {
    copyFileSync(join(REPO, 'scripts', 'release', f), join(work, 'scripts', 'release', f))
  }
  for (const f of ['CHANGELOG.md', 'CHANGELOG.zh.md']) {
    copyFileSync(join(REPO, f), join(work, f))
  }
  // The three manifests the tag script's verification cross-checks.
  writeFileSync(join(work, 'package.json'), `{"name":"x","version":"${VERSION}"}\n`)
  writeFileSync(join(work, 'packages', 'qialike-app', 'package.json'), `{"name":"a","version":"${VERSION}"}\n`)
  writeFileSync(join(work, 'apps', 'tui-bin', 'package.json'), `{"name":"b","version":"${VERSION}"}\n`)
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  // The script refuses to run outside a checkout with a version; tagging is what we want.
  spawnSync('bash', [join(work, 'scripts', 'release', 'tag-qialike.sh'), '-y'], { cwd: work, encoding: 'utf8' })
})

afterAll(() => {
  if (work !== '') rmSync(work, { recursive: true, force: true })
})

describe('the tag message carries the CHANGELOG entry, headings included', () => {
  test('markdown headings survive (git tag -F would otherwise strip them as comments)', () => {
    const msg = git(['cat-file', '-p', `v${VERSION}`])

    expect(msg).toContain('### Changed')
    expect(msg).toContain('### 变更')
    // The content on both sides of those headings has to be there too.
    expect(msg).toContain('Rebuilt on DeepSeek Harness')
    expect(msg).toContain('重建于 DeepSeek Harness')
  })

  test('the first line still names the version, so verification keeps passing', () => {
    const msg = git(['cat-file', '-p', `v${VERSION}`])
    // `tag-qialike.sh` asserts the annotation contains "qialike <version>".
    expect(msg).toContain(`qialike ${VERSION}`)
  })

  test('both languages are present, English first', () => {
    const msg = git(['cat-file', '-p', `v${VERSION}`])
    const en = msg.indexOf('Rebuilt on DeepSeek Harness')
    const zh = msg.indexOf('重建于 DeepSeek Harness')
    expect(en).toBeGreaterThan(-1)
    expect(zh).toBeGreaterThan(en)
  })
})
