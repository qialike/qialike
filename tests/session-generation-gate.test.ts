/**
 * Regression: qialike must notice when the shared session store is NEWER than
 * the harness it embeds, and must explain a "session is owned" refusal instead
 * of printing the raw harness error.
 *
 * Why: a qialike TUI shares `~/.dsh/sessions` with `dsh web`. A newer harness
 * migrates by writing a NEW immutable generation file (`session.vN.jsonl.zstd`)
 * and never deletes the older one, so a build that only knows the older format
 * either silently reads stale history or fails every read with
 * `SessionFormatUnsupportedError`. `qialike web` now refuses up front, naming
 * the file that proves it. The second class — `SessionAlreadyOwnedError`, i.e.
 * another process holds the write lease — must tell the user to close the other
 * holder rather than suggest retrying a permanently damaged log.
 *
 * Run with `bun test tests/session-generation-gate.test.ts`.
 *
 * @module qialike/session-generation-gate-test
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeGenerationMismatch,
  highestStoredGeneration,
  sessionGenerationStatus,
  SUPPORTED_SESSION_FORMAT_VERSION,
} from '../packages/qialike-app/src/session-files.ts'
import { describeResumeFailure, isOwnedSessionMessage } from '../packages/qialike-app/src/resume-fold.ts'

const base = mkdtempSync(join(tmpdir(), 'qialike-generation-gate-'))

afterAll(() => { rmSync(base, { recursive: true, force: true }) })

/** A store root private to one test, so cases cannot see each other's files. */
function freshRoot(): string {
  return mkdtempSync(join(base, 'case-'))
}

/** Create `<root>/<project>/<id>/<file>` for each given log name. */
function store(root: string, project: string, id: string, names: readonly string[]): void {
  const dir = join(root, project, id)
  mkdirSync(dir, { recursive: true })
  for (const name of names) writeFileSync(join(dir, name), '')
}

describe('highestStoredGeneration', () => {
  test('reads the generation from the canonical filename', () => {
    const root = freshRoot()
    store(root, '--a--', 'session-v0', ['session.jsonl.zstd'])
    expect(highestStoredGeneration(root)?.version).toBe(0)
    store(root, '--a--', 'session-v3', ['session.jsonl.zstd', 'session.v3.jsonl.zstd'])
    expect(highestStoredGeneration(root)?.version).toBe(3)
  })

  test('a newer generation wins, and .zstd breaks the tie', () => {
    const root = freshRoot()
    store(root, '--b--', 'session-newer', ['session.v3.jsonl.zstd', 'session.v4.jsonl', 'session.v4.jsonl.zstd'])
    const highest = highestStoredGeneration(root)
    expect(highest?.version).toBe(4)
    // Same version, both encodings: report the one the harness would read.
    expect(highest?.path.endsWith('/session.v4.jsonl.zstd')).toBe(true)
  })

  test('non-canonical names are ignored', () => {
    const root = freshRoot()
    store(root, '--c--', 'session-junk', ['session.v5.jsonl.zstd.tmp', 'notes.txt', 'session.lock'])
    expect(highestStoredGeneration(root)).toBeUndefined()
  })

  test('an empty or missing root yields undefined', () => {
    expect(highestStoredGeneration(join(freshRoot(), 'nope'))).toBeUndefined()
  })
})

describe('sessionGenerationStatus / describeGenerationMismatch', () => {
  test('this build reads format v4 (the embedded harness version)', () => {
    expect(SUPPORTED_SESSION_FORMAT_VERSION).toBe(4)
  })

  test('a store at or below the supported version is readable here', () => {
    expect(describeGenerationMismatch(sessionGenerationStatus(join(freshRoot(), 'nope')))).toBeUndefined()
    const compatible = { supported: 4, highest: { version: 4, path: '/x/session.v4.jsonl.zstd' } }
    expect(describeGenerationMismatch(compatible)).toBeUndefined()
  })

  test('a newer store names both versions and the offending file', () => {
    const root = freshRoot()
    store(root, '--d--', 'session-too-new', ['session.v4.jsonl.zstd', 'session.v5.jsonl.zstd'])
    const status = sessionGenerationStatus(root)
    expect(status.highest?.version).toBe(5)
    const text = describeGenerationMismatch(status)
    expect(text).toContain('v5')
    expect(text).toContain('v4')
    expect(text).toContain('session.v5.jsonl.zstd')
  })
})

describe('ownership wording', () => {
  test('the harness ownership error is recognised', () => {
    expect(isOwnedSessionMessage('session "session-abc" is already owned by an active write handle')).toBe(true)
    expect(isOwnedSessionMessage('corrupt session log: seq gap')).toBe(false)
  })

  test('resume text tells the user to close the other writer', () => {
    const text = describeResumeFailure(new Error('session "session-abc" is already owned by an active write handle'))
    expect(text).toContain('open for WRITING in another process')
    expect(text).toContain('Close it there')
    expect(text).not.toContain('corrupt')
  })

  test('a corrupt log still gets the corrupt explanation', () => {
    const text = describeResumeFailure(new Error('corrupt session log: invalid committed event'))
    expect(text).toContain('corrupt')
    expect(text).toContain('another process is appending')
  })
})
