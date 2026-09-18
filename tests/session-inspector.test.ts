/**
 * Regression: the blank-reuse paths must not depend on a service method that
 * no longer exists.
 *
 * Harness 0.1.3 replaced `SessionPersistence.inspect` with the per-session
 * handle API (`open`/`read`), so on the 0.1.5 composition qialike now binds,
 * the persistence service answers `list()` but has NO `inspect`. The launch
 * reuse guarded on `persistence.inspect !== undefined`, so on 0.1.5 it
 * silently skipped and EVERY flat launch minted a fresh empty session —
 * measured as one `session-*` directory holding only the header plus the three
 * preset events, per launch (the pile-up the reuse exists to prevent).
 *
 * `sessionInspector` is the version-independent adapter pinned here: the
 * service when it still offers `inspect` (≤ 0.1.2), the generation-aware log
 * reader otherwise (0.1.3+).
 *
 * Run with `bun test tests/session-inspector.test.ts`.
 *
 * @module qialike/session-inspector-test
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { sessionDir, sessionInspector, type SessionInspectService } from '../packages/qialike-app/src/session-files.ts'
import { findReusableBlank } from '../packages/qialike-app/src/session-titles.ts'

const home = mkdtempSync(join(tmpdir(), 'qialike-session-inspector-'))
process.env.DSH_HOME = home

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

const CWD = '/work/project'
const BLANK = 'session-blank-0000-0000-0000-000000000001'
const BLANK_OLD = 'session-blank-0000-0000-0000-000000000002'
const CONTENT = 'session-content-000-0000-0000-000000000003'

function sid(text: string): SessionId {
  return text as SessionId
}

/** One zstd frame from a list of JSON lines (what one append flush produces). */
function frame(lines: readonly unknown[]): Uint8Array {
  return Bun.zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n'))
}

/** Write a session log the way the 0.1.5 writer does: header frame, then one
 *  frame holding the events (the header frame is exactly one header line). */
function writeLog(id: string, events: readonly { type: string }[]): void {
  const dir = sessionDir(CWD, sid(id))
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 3, id, createdAt: 1, cwd: CWD, isSeeded: false, delegationDepth: 0 }
  const rows = events.map((event, seq) => ({ ...event, seq, time: 1_000 + seq }))
  const parts = [frame([header])]
  if (rows.length > 0) parts.push(frame(rows))
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), Buffer.concat(parts))
}

const PRESETS = [
  { type: 'permission/preset' },
  { type: 'sandbox/mode' },
  { type: 'approval/policy' },
]

writeLog(BLANK, PRESETS)
writeLog(BLANK_OLD, PRESETS)
// A real conversation without turn markers: the `/fork`-child case that must
// never be adopted as the blank placeholder.
writeLog(CONTENT, [...PRESETS, { type: 'user/message' }])

/** The 0.1.5 service shape: it lists, but it has no `inspect`. */
const withoutInspect = { list: async (): Promise<readonly unknown[]> => [] } as unknown as SessionInspectService

describe('sessionInspector', () => {
  test('a 0.1.5 service (list, no inspect) still answers from the session log', async () => {
    const inspection = sessionInspector(withoutInspect, CWD)
    expect(typeof inspection.inspect).toBe('function')
    const { events } = await inspection.inspect(sid(BLANK))
    expect((events as { type?: string }[]).map((event) => event.type)).toEqual([
      'permission/preset',
      'sandbox/mode',
      'approval/policy',
    ])
  })

  test('a service that still offers inspect (0.1.2) is used instead of the file', async () => {
    const service: SessionInspectService = {
      inspect: async () => ({ events: [{ type: 'service-marker' }] }),
    }
    // The id has no log at all: reaching the file would throw instead.
    const { events } = await sessionInspector(service, CWD).inspect(sid('session-no-such-log'))
    expect((events as { type?: string }[]).map((event) => event.type)).toEqual(['service-marker'])
  })

  test('an id with no readable log still throws, so reuse skips that candidate', async () => {
    await expect(sessionInspector(undefined, CWD).inspect(sid('session-missing'))).rejects.toThrow()
  })
})

describe('flat-launch blank reuse on a composition without service inspect', () => {
  test('reuses the newest same-cwd blank instead of minting a new session', async () => {
    const headers = [
      { id: sid(BLANK_OLD), cwd: CWD, createdAt: 1 },
      { id: sid(BLANK), cwd: CWD, createdAt: 2 },
    ]
    const found = await findReusableBlank(sessionInspector(withoutInspect, CWD), headers, CWD, undefined)
    expect(String(found)).toBe(BLANK)
  })

  test('a conversation without turn markers is never adopted as the blank', async () => {
    const headers = [{ id: sid(CONTENT), cwd: CWD, createdAt: 3 }]
    const found = await findReusableBlank(sessionInspector(withoutInspect, CWD), headers, CWD, undefined)
    expect(found).toBeUndefined()
  })

  test('no blank at all yields undefined (the caller then creates exactly one)', async () => {
    const found = await findReusableBlank(sessionInspector(withoutInspect, CWD), [], CWD, undefined)
    expect(found).toBeUndefined()
  })
})
