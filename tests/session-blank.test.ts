/**
 * Unit tests for the ported web "blank session" semantics (session-titles.ts):
 * a created-but-unused session is a blank "New Session" placeholder —
 *  - `foldSessionBlank` (blank until the first `turn/start`);
 *  - `rememberBlank` / `sessionBlank` (titled sessions are never blank);
 *  - `hideUnselectedBlanks` (only the SELECTED blank stays in the list);
 *  - `findReusableBlank` ("New Session" reuses an existing blank for the same
 *    workspace instead of minting a new id).
 *
 * DSH_HOME is pointed at a throwaway temp dir BEFORE the first lazy load so the
 * real ~/.dsh title cache is never touched.
 *
 * Run with `bun test tests/session-blank.test.ts`.
 *
 * @module dsh-tui/session-blank-test
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  findReusableBlank,
  foldSessionBlank,
  hideUnselectedBlanks,
  rememberBlank,
  rememberTitle,
  sessionBlank,
  type SessionTitlesPersistence,
} from '../packages/dsh-tui-app/src/session-titles.ts'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-session-blank-test-'))
process.env.DSH_HOME = home

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

function sid(text: string): SessionId {
  return text as SessionId
}

const preset = (type: string): { type: string } => ({ type })

describe('foldSessionBlank', () => {
  test('a fresh log (header + presets only) is blank', () => {
    expect(foldSessionBlank([preset('session'), preset('permission/preset'), preset('sandbox/mode')])).toBe(true)
  })

  test('any turn/start makes it history, wherever it sits', () => {
    expect(foldSessionBlank([preset('session'), preset('turn/start'), preset('turn/end')])).toBe(false)
    expect(foldSessionBlank([preset('session'), preset('session/end-seed')])).toBe(true)
  })
})

describe('sessionBlank / rememberBlank', () => {
  test('records the bit and reports unknown as undefined', () => {
    expect(sessionBlank(sid('unknown-blank-id'))).toBeUndefined()
    rememberBlank(sid('blank-id-1'), true)
    expect(sessionBlank(sid('blank-id-1'))).toBe(true)
    rememberBlank(sid('blank-id-1'), false)
    expect(sessionBlank(sid('blank-id-1'))).toBe(false)
  })

  test('a titled session is never blank even without an explicit bit', () => {
    rememberTitle(sid('titled-id-1'), 'some task')
    expect(sessionBlank(sid('titled-id-1'))).toBe(false)
  })
})

describe('hideUnselectedBlanks', () => {
  const rows = [
    { id: sid('content-1'), label: 'a', blank: false },
    { id: sid('blank-1'), label: 'b', blank: true },
  ]

  test('hides a blank row while another session is selected', () => {
    expect(hideUnselectedBlanks(rows, sid('content-1')).map((r) => String(r.id))).toEqual(['content-1'])
  })

  test('keeps the selected blank row', () => {
    expect(hideUnselectedBlanks(rows, sid('blank-1')).map((r) => String(r.id))).toEqual(['content-1', 'blank-1'])
  })

  test('with no selection nothing is hidden (unknown state is never destructive)', () => {
    expect(hideUnselectedBlanks(rows, undefined)).toHaveLength(2)
  })
})

describe('findReusableBlank', () => {
  const cwd = '/work'
  const log = (events: { type: string }[]): SessionTitlesPersistence => ({
    inspect: async () => ({ events }),
  })

  test('picks the newest blank for the same cwd, skipping content and other cwds', async () => {
    const headers = [
      { id: sid('content-a'), cwd, createdAt: 5 },
      { id: sid('blank-new'), cwd, createdAt: 4 },
      { id: sid('blank-old'), cwd, createdAt: 1 },
      { id: sid('other-cwd-blank'), cwd: '/elsewhere', createdAt: 9 },
    ]
    const eventsOf: Record<string, { type: string }[]> = {
      'content-a': [preset('turn/start')],
      'blank-new': [preset('session')],
      'blank-old': [preset('session')],
    }
    const persistence: SessionTitlesPersistence = {
      inspect: async (id) => ({ events: eventsOf[String(id)] ?? [] }),
    }
    const found = await findReusableBlank(persistence, headers, cwd, sid('content-a'))
    expect(String(found)).toBe('blank-new')
  })

  test('never reuses the excluded (current) session', async () => {
    const headers = [{ id: sid('blank-current'), cwd, createdAt: 3 }]
    const found = await findReusableBlank(log([preset('session')]), headers, cwd, sid('blank-current'))
    expect(found).toBeUndefined()
  })

  test('returns undefined when every candidate has content', async () => {
    const headers = [{ id: sid('content-b'), cwd, createdAt: 2 }]
    const found = await findReusableBlank(log([preset('turn/start')]), headers, cwd, undefined)
    expect(found).toBeUndefined()
  })

  test('an unreadable candidate is skipped, not fatal', async () => {
    const headers = [
      { id: sid('broken'), cwd, createdAt: 3 },
      { id: sid('blank-ok'), cwd, createdAt: 2 },
    ]
    const persistence: SessionTitlesPersistence = {
      inspect: async (id) => {
        if (String(id) === 'broken') throw new Error('unreadable')
        return { events: [preset('session')] }
      },
    }
    const found = await findReusableBlank(persistence, headers, cwd, undefined)
    expect(String(found)).toBe('blank-ok')
  })
})
