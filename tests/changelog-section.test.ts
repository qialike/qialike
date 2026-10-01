/**
 * Guards `scripts/release/changelog-section.sh`, the one place that decides what a
 * release *says*.
 *
 * WHY THIS EXISTS. GitHub and GitCode show a release's `body` when you click a tag,
 * and that body used to be the literal string `qialike <version>` — thirteen
 * characters, so **no release ever showed what changed** (measured on 0.9.0). The
 * extractor is what feeds that body (and the annotated tag's message) from the
 * repository's own CHANGELOG, so "what shipped" is never hand-copied and cannot
 * drift from the file developers edit.
 *
 * The boundary that matters most is the version match: a naive `grep "## \[$v\]"`
 * would let `0.9.0` match a `## [0.9.0-beta]` heading and publish the wrong
 * section's text under a released version.
 *
 * Run with `bun test tests/changelog-section.test.ts`.
 *
 * @module qialike/changelog-section-test
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const SCRIPT = join(REPO, 'scripts', 'release', 'changelog-section.sh')

function run(args: string[], repo = REPO) {
  const r = spawnSync('bash', [SCRIPT, ...args, '--repo', repo], { encoding: 'utf8' })
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

/** A throwaway repo whose two CHANGELOGs are written by the test. */
function fixture(en: string, zh: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-section-'))
  writeFileSync(join(dir, 'CHANGELOG.md'), en)
  writeFileSync(join(dir, 'CHANGELOG.zh.md'), zh)
  return dir
}

describe('the extractor finds the version section in both languages', () => {
  test('the released 0.9.0 section comes back, English above Chinese', () => {
    const { status, out } = run(['0.9.0'])

    expect(status).toBe(0)
    // Both languages are present…
    expect(out).toContain('Rebuilt on DeepSeek Harness')
    expect(out).toContain('重建于 DeepSeek Harness')
    // …separated by a horizontal rule, English first.
    const en = out.indexOf('Rebuilt on DeepSeek Harness')
    const zh = out.indexOf('重建于 DeepSeek Harness')
    const rule = out.indexOf('---')
    expect(en).toBeLessThan(rule)
    expect(rule).toBeLessThan(zh)
  })

  test('--lang selects one language, and a section never leaks its header', () => {
    const en = run(['0.9.0', '--lang', 'en'])
    expect(en.status).toBe(0)
    expect(en.out).toContain('### Changed')
    expect(en.out).not.toContain('### 变更')
    // The `## [0.9.0] - <date>` heading itself is a boundary, not content.
    expect(en.out).not.toContain('## [0.9.0]')

    const zh = run(['0.9.0', '--lang', 'zh'])
    expect(zh.status).toBe(0)
    expect(zh.out).toContain('### 变更')
    expect(zh.out).not.toContain('### Changed')
  })

  test('the section stops at the next version, so no later entry bleeds in', () => {
    const { out } = run(['0.9.0', '--lang', 'en'])
    // 0.8.3's first bullet must not appear under 0.9.0.
    expect(out).not.toContain('no longer repeats or contradicts itself')
  })
})

describe('the version match is exact, not a prefix match', () => {
  test('0.9.0 does not match a 0.9.0-beta heading', () => {
    // The failure this pins: `grep "## [0.9.0]"`-style matching would publish the
    // beta section's text under the released 0.9.0 — wrong notes, silently.
    const dir = fixture(
      '## [0.9.0-beta] - 2026-01-01\n\n- BETA ONLY\n\n## [0.9.0] - 2026-02-02\n\n- RELEASED ONLY\n',
      '## [0.9.0-beta] - 2026-01-01\n\n- 内测\n\n## [0.9.0] - 2026-02-02\n\n- 正式\n',
    )
    try {
      const { status, out } = run(['0.9.0', '--lang', 'en'], dir)
      expect(status).toBe(0)
      expect(out).toContain('RELEASED ONLY')
      expect(out).not.toContain('BETA ONLY')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a version with a pre-release suffix is found by its full name', () => {
    const dir = fixture(
      '## [0.9.0-beta] - 2026-01-01\n\n- BETA ONLY\n\n## [0.9.0] - 2026-02-02\n\n- RELEASED ONLY\n',
      '## [0.9.0-beta] - 2026-01-01\n\n- 内测\n',
    )
    try {
      const { status, out } = run(['0.9.0-beta', '--lang', 'en'], dir)
      expect(status).toBe(0)
      expect(out).toContain('BETA ONLY')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a missing section is a refusal the caller can fall back from', () => {
  test('an unknown version exits non-zero with an empty stdout', () => {
    // The release scripts treat this as "keep the old one-line body" rather than as
    // a fatal error: tagging must not fail because the changelog lacks an entry.
    const { status, out } = run(['9.9.9'])
    expect(status).toBe(1)
    expect(out).toBe('')
  })

  test('a language with no file at all is skipped, not fatal', () => {
    const dir = fixture('## [1.0.0] - x\n\n- EN ONLY\n', '')
    try {
      const { status, out } = run(['1.0.0'], dir)
      expect(status).toBe(0)
      expect(out).toContain('EN ONLY')
      // No separator, because nothing was there to separate.
      expect(out).not.toContain('---')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the section is trimmed to its own content', () => {
  test('leading and trailing blank lines are dropped', () => {
    const dir = fixture(
      '## [1.2.3] - x\n\n\n- FIRST\n- LAST\n\n\n\n## [1.2.2] - y\n\n- other\n',
      '',
    )
    try {
      const { out } = run(['1.2.3', '--lang', 'en'], dir)
      expect(out.startsWith('- FIRST')).toBe(true)
      expect(out.endsWith('- LAST\n')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
