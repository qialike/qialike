/**
 * A glob pattern is judged by what it can MATCH, not by its literal spelling.
 *
 * `glob`'s `pattern` is a path glob, so the secret guard has to hold for every
 * spelling that can name the same file. It did not: `.env*` was allowed while
 * `*.env` was refused, so a caller could enumerate secret FILE NAMES (not their
 * contents) just by choosing the prefix form — the guard's guarantee depended on
 * how the pattern happened to be written.
 *
 * Run with `bun test tests/read-policy-glob.test.ts`.
 *
 * @module qialike/read-policy-glob-test
 */

import { describe, expect, test } from 'bun:test'
import { isBlockedSecretSegment } from '../packages/qialike-app/src/read-policy.ts'

describe('a glob segment is judged by what it can match', () => {
  test('every spelling that can name a secret is refused', () => {
    for (const pattern of ['*.env', '.env*', '.env.*', '.env.local*', '**/.env', '**/.git/**', '*.credentials.yaml']) {
      expect(isBlockedSecretSegment(pattern)).toBe(true)
    }
  })

  test('ordinary patterns are still allowed', () => {
    for (const pattern of ['*.md', 'src/**/*.ts', 'README*', '*.tsx']) {
      expect(isBlockedSecretSegment(pattern)).toBe(false)
    }
  })

  test('the committed template stays readable however it is spelled', () => {
    expect(isBlockedSecretSegment('.env.example')).toBe(false)
  })

  test('plain segments keep their previous verdicts', () => {
    // The `.env` family is this helper's job; `.git` and `.credentials.yaml` are
    // matched by name in the caller's set, so they are not asserted here.
    for (const segment of ['.env', '.env.local']) {
      expect(isBlockedSecretSegment(segment)).toBe(true)
    }
    for (const segment of ['src', 'index.ts', '.gitignore', 'README.md']) {
      expect(isBlockedSecretSegment(segment)).toBe(false)
    }
  })
})
