/**
 * Tests for `Store.statusBarLeft` — which line owns the status bar's LEFT slot.
 *
 * Why the ORDER is behaviour and not presentation: in the read-only phase
 * (S2-2b) the older-history marker is set and NO fold driver ever settles it,
 * so `historyLoadingVisible` is true for as long as the user only reads.
 * Anything ranked below the fold text is therefore invisible for that entire
 * phase. Measured on a real pty before the fix: `/sidebar` flipped the mode and
 * persisted it, Ctrl+Y copied the selection, and NEITHER left any visible
 * feedback, because the status bar is the only place those confirmations can
 * appear (a transcript row would re-layout the transcript).
 *
 * The render consumes this getter, so the ranking cannot drift from the test.
 *
 * Run with `bun test tests/status-bar-priority.test.ts`.
 *
 * @module dsh-tui/status-bar-priority-test
 */

import { describe, expect, test } from 'bun:test'
import { Store } from '../packages/dsh-tui-app/src/index.tsx'

/** A store sitting in the read-only phase: marker set, nothing will settle it. */
function readOnlyPhase(): Store {
  const store = new Store()
  store.beginHistory([], [], 11_431)
  return store
}

describe('statusBarLeft', () => {
  test('busy (Idle / Working) when nothing else claims the slot', () => {
    expect(new Store().statusBarLeft).toBe('busy')
  })

  test('the read-only fold marker owns the slot on its own', () => {
    const store = readOnlyPhase()
    expect(store.historyLoadingVisible).toBe(true)
    expect(store.statusBarLeft).toBe('history')
  })

  test('a flash outranks the never-settling fold marker (the F1 regression)', () => {
    const store = readOnlyPhase()
    store.flashStatus('Steps: hidden')
    // Still the read-only phase — this is exactly why the order matters.
    expect(store.historyLoadingVisible).toBe(true)
    expect(store.statusBarLeft).toBe('flash')
    expect(store.statusFlash?.text).toBe('Steps: hidden')
  })

  test('the fold text comes back on its own when the flash expires', async () => {
    const store = readOnlyPhase()
    store.flashStatus('Copied: hello (5 chars)', 1)
    expect(store.statusBarLeft).toBe('flash')
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(store.statusFlash).toBeNull()
    expect(store.statusBarLeft).toBe('history')
  })

  test('live phases still outrank a flash', () => {
    const store = new Store()
    store.flashStatus('x')
    store.beginSessionLoading({ id: 'session-3c1c6602-1ddc-40ee-a295-f34348c87153', startedAt: Date.now() })
    expect(store.statusBarLeft).toBe('loading')
    store.endSessionLoading()
    expect(store.statusBarLeft).toBe('flash')
    store.beginCompaction(Date.now())
    expect(store.statusBarLeft).toBe('compaction')
    store.endCompaction()
    expect(store.statusBarLeft).toBe('flash')
    store.beginPreparingRequest()
    expect(store.statusBarLeft).toBe('preparing')
    store.endPreparingRequest()
    expect(store.statusBarLeft).toBe('flash')
  })

  test('a recorded load failure outranks the fold (it is the only explanation)', () => {
    const store = readOnlyPhase()
    store.failSessionLoad('Load session failed: corrupt session log')
    expect(store.historyLoadingVisible).toBe(true)
    expect(store.statusBarLeft).toBe('error')
    expect(store.loadError).toContain('corrupt session log')
  })

  test('a fresh load clears the error, so it can never hide a live fold', () => {
    const store = readOnlyPhase()
    store.failSessionLoad('Load session failed: boom')
    expect(store.statusBarLeft).toBe('error')
    store.beginSessionLoading({ id: 'session-3c1c6602-1ddc-40ee-a295-f34348c87153', startedAt: Date.now() })
    expect(store.loadError).toBeNull()
    expect(store.statusBarLeft).toBe('loading')
  })

  test('a flash outranks a recorded error (the newer action is the visible one)', () => {
    const store = readOnlyPhase()
    store.failSessionLoad('Load session failed: boom')
    store.flashStatus('sessions: EACCES')
    expect(store.statusBarLeft).toBe('flash')
  })
})
