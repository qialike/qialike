/**
 * S2-2b: the read-only phase between phase 1's file-first paint and the harness
 * attach.
 *
 * `agents.resume()` decodes the whole durable log on the single JS thread and
 * cannot be interrupted, so the launch must not run it until the user actually
 * asks for the session (first submit / agent-dependent command). While that
 * window is open the docked chrome stays up, input is live, and the leading
 * "older history" marker must not claim a fold is running.
 *
 * Store-level behaviour is unit-tested here; the `start()` wiring (mount before
 * attach, the gate, the deferral hook and the replay) is a cordis closure with
 * no seam, so it is pinned source-level — same approach as
 * tests/assistant-stream.test.ts.
 *
 * Run with `bun test tests/read-only-attach.test.ts`.
 *
 * @module dsh-tui/read-only-attach-test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { Session, TranscriptItem } from '../packages/dsh-tui-app/src/index.tsx'
import {
  ATTACH_DEFERRED_COMMANDS,
  READ_ONLY_HINT,
  READ_ONLY_OLDER_HISTORY,
  Store,
} from '../packages/dsh-tui-app/src/index.tsx'

const source = readFileSync(join(process.cwd(), 'packages/dsh-tui-app/src/index.tsx'), 'utf8')
const conversation = readFileSync(join(process.cwd(), 'packages/dsh-tui-app/src/panels/conversation.tsx'), 'utf8')

const item = (kind: TranscriptItem['kind'], text: string): TranscriptItem => ({ key: 0, kind, text })

describe('Store read-only phase (S2-2b)', () => {
  test('keeps the docked view and answers the session id before the attach', () => {
    const store = new Store()
    // A launch with no session yet is the hero.
    expect(store.hero).toBe(true)
    expect(store.session).toBeUndefined()

    store.beginReadOnlySession('session-abc')
    // The painted transcript needs the docked chrome, not the hero.
    expect(store.hero).toBe(false)
    expect(store.readOnlySessionId).toBe('session-abc')
    expect(String(store.session?.id)).toBe('session-abc')

    store.endReadOnlySession()
    expect(store.hero).toBe(true)
    expect(store.session).toBeUndefined()
  })

  test('setSession ends the read-only phase and wins over its stand-in', () => {
    const store = new Store()
    store.beginReadOnlySession('session-old')
    const real = { id: 'session-real' } as unknown as Session
    store.setSession(real)
    expect(store.readOnlySessionId).toBeUndefined()
    expect(store.session).toBe(real)
  })

  test('the read-only marker states the truth instead of a frozen 0% bar', () => {
    const store = new Store()
    store.beginHistory([item('user', 'tail')], [], 900)
    const progress = store.getItems()[0]!.text
    expect(progress).toContain('0/900 events')

    store.setReadOnlyHistoryMarker(true)
    expect(store.getItems()[0]!.text).toBe(READ_ONLY_OLDER_HISTORY)
    expect(store.getItems()[1]!.text).toBe('tail') // transcript untouched

    // The attach's fold driver replaces it with real progress again.
    store.setReadOnlyHistoryMarker(false)
    expect(store.getItems()[0]!.text).toBe(progress)

    store.setReadOnlyHistoryMarker(true)
    store.setHistoryProgress(100, 900)
    expect(store.getItems()[0]!.text).toContain('100/900 events')
  })

  test('only agent-dependent commands are deferred until the attach', () => {
    for (const name of ['new', 'sessions', 'compact', 'goal', 'plan', 'models']) {
      expect(ATTACH_DEFERRED_COMMANDS.has(name)).toBe(true)
    }
    // Read-only commands must keep working while the attach is pending.
    for (const name of ['export', 'sidebar', 'theme', 'help']) {
      expect(ATTACH_DEFERRED_COMMANDS.has(name)).toBe(false)
    }
  })
})

describe('start() read-only wiring (S2-2b)', () => {
  test('the UI is mounted and painted before the attach, not after it', () => {
    const start = source.indexOf('async function start(')
    const paint = source.indexOf('const painted = await paintFileFirstScreen', start)
    const gate = source.indexOf('await attachGate', paint)
    expect(paint).toBeGreaterThan(start)
    expect(gate).toBeGreaterThan(paint)
    // The early mount must happen before the paint (Ink needs a surface first).
    const mount = source.indexOf('mountUi()', start)
    expect(mount).toBeGreaterThan(start)
    expect(mount).toBeLessThan(paint)
  })

  test('the first submit and agent-dependent commands pay the attach', () => {
    expect(source).toContain('store.submitMessage = (text) => { deferForAttach(text) }')
    expect(source).toContain('if (!ATTACH_DEFERRED_COMMANDS.has(name)) return true')
    expect(source).toContain('deferForAttach(text)')
    expect(source).toContain('void attachNow()')
  })

  test('the read-only path suspends on the gate instead of attaching eagerly', () => {
    expect(source).toContain('if (readOnly) {')
    expect(source).toContain('await attachGate')
    // The gate is opened only by a trigger calling attachNow.
    expect(source).toContain('releaseAttachGate?.()')
  })

  test('queued input is replayed through the normal Enter path', () => {
    const replay = source.indexOf('const replay = pendingInputs.splice')
    expect(replay).toBeGreaterThan(0)
    expect(source.slice(replay, replay + 260)).toContain('handleKey({ return: true })')
    expect(source).toContain('store.beforeCommand = undefined')
  })

  test('the conversation panel consults the deferral hook before running a command', () => {
    expect(conversation).toContain('store.beforeCommand?.(chosen.name, text) !== false')
  })

  test('the read-only hint is honest about the unpaid attach', () => {
    expect(READ_ONLY_HINT).toContain('attaches on your first message')
    expect(source).toContain("store.append('status', READ_ONLY_HINT, true)")
  })
})
