/**
 * Unit tests for the single-session title read (`sessionDisplayTitle` in
 * session-titles.ts) — the read behind the right-sidebar session title line:
 * remember → read round-trip, user rename (Ctrl+R) wins over the auto title,
 * forgetting removes it, and unknown/never-titled sessions read as undefined.
 *
 * The title cache persists to `$DSH_HOME/qialike-titles.json`, so the tests
 * point DSH_HOME at a throwaway temp directory BEFORE the first lazy cache
 * load and never touch the real `~/.dsh`.
 *
 * Run with `bun test tests/session-title.test.ts`.
 *
 * @module qialike/session-title-test
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  forgetTitle,
  rememberFoldedTitle,
  rememberTitle,
  renameTitle,
  sessionDisplayTitle,
} from '../packages/qialike-app/src/session-titles.ts'

// Isolate the title cache before any session-titles call triggers the lazy
// disk load (ensureDiskLoaded) against the real harness home.
const home = mkdtempSync(join(tmpdir(), 'qialike-title-test-'))
process.env.DSH_HOME = home

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Brand a plain string as a SessionId for cache-key purposes. */
function sid(text: string): SessionId {
  return text as SessionId
}

describe('sessionDisplayTitle', () => {
  test('returns undefined for an unknown session', () => {
    expect(sessionDisplayTitle(sid('00000000-0000-0000-0000-000000000000'))).toBeUndefined()
  })

  test('returns the auto title after rememberTitle', () => {
    const id = sid('11111111-1111-1111-1111-111111111111')
    expect(sessionDisplayTitle(id)).toBeUndefined()
    rememberTitle(id, 'auto title')
    expect(sessionDisplayTitle(id)).toBe('auto title')
  })

  test('a user rename wins over the remembered auto title', () => {
    const id = sid('22222222-2222-2222-2222-222222222222')
    rememberTitle(id, 'auto title')
    renameTitle(id, 'user title')
    expect(sessionDisplayTitle(id)).toBe('user title')
  })

  test('clearing the rename falls back to the auto title', () => {
    const id = sid('33333333-3333-3333-3333-333333333333')
    rememberTitle(id, 'auto title')
    renameTitle(id, 'user title')
    renameTitle(id, '')
    expect(sessionDisplayTitle(id)).toBe('auto title')
  })

  test('forgetTitle removes the cached title entirely', () => {
    const id = sid('44444444-4444-4444-4444-444444444444')
    rememberTitle(id, 'auto title')
    forgetTitle(id)
    expect(sessionDisplayTitle(id)).toBeUndefined()
  })
})

describe('rememberFoldedTitle', () => {
  /** A minimal session log whose latest title event names a fallback title. */
  const titledLog = [{
    type: 'session/title',
    seq: 3,
    time: 1788872945968,
    data: { title: 'how are you?', messageSeqs: [2], source: { kind: 'fallback' } },
  }] as unknown[]

  test('folds the latest session/title event into the cache', () => {
    const id = sid('55555555-5555-5555-5555-555555555555')
    expect(sessionDisplayTitle(id)).toBeUndefined()
    rememberFoldedTitle(id, titledLog)
    expect(sessionDisplayTitle(id)).toBe('how are you?')
  })

  test('a log without a session/title event leaves the cache empty', () => {
    const id = sid('66666666-6666-6666-6666-666666666666')
    rememberFoldedTitle(id, [{ type: 'user/message', seq: 0, time: 1, data: {} }] as unknown[])
    expect(sessionDisplayTitle(id)).toBeUndefined()
  })

  test('never overwrites a user rename', () => {
    const id = sid('77777777-7777-7777-7777-777777777777')
    renameTitle(id, 'user title')
    rememberFoldedTitle(id, titledLog)
    expect(sessionDisplayTitle(id)).toBe('user title')
  })
})
