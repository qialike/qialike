/**
 * Regression: the /sessions highlight follows the SELECTED SESSION across a
 * background refresh, not its row index.
 *
 * `refreshSessionsDialog` replaces the rows in place (background title folding,
 * a pin, a rename reload). Before the 0.1.5 HEAD-probe fix, folding learned no
 * `blank` bits, so a refresh never dropped a row; once the probe answered, the
 * fold hides the unused placeholders and the rows below them shift up. The
 * index used to survive that, so Ctrl+F/Ctrl+D acted on whatever row inherited
 * the index — measured on a real home as "Ctrl+F pinned the CURRENT session
 * right after renaming a different one" (`lifecycle` scenario).
 *
 * Run with `bun test tests/sessions-dialog-highlight.test.ts`.
 *
 * @module dsh-tui/sessions-dialog-highlight-test
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummary } from '../packages/dsh-tui-app/src/index.tsx'
import { Store } from '../packages/dsh-tui-app/src/index.tsx'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-dialog-highlight-'))
process.env.DSH_HOME = home

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/** One row; `at` drives the newest-first order the dialog sorts by. */
function row(id: string, at: number): SessionSummary {
  return { id: id as never, label: id, activityAt: at, createdAt: at }
}

describe('refreshSessionsDialog highlight', () => {
  test('keeps the highlighted session when a hidden row above it disappears', () => {
    const store = new Store()
    const current = row('session-current', 30)
    const blank = row('session-blank', 20)
    const target = row('session-target', 10)
    store.openSessions([current, blank, target])
    store.moveSessionsDialogIndex(2)
    expect(String(store.sessionsFiltered[store.sessionsDialogIndex]?.id)).toBe('session-target')

    // The background fold learns `blank` and hides the placeholder: the target
    // now sits at index 1, but the highlight must still be on IT.
    store.refreshSessionsDialog([current, target])
    expect(store.sessionsFiltered.map((r) => String(r.id))).toEqual(['session-current', 'session-target'])
    expect(String(store.sessionsFiltered[store.sessionsDialogIndex]?.id)).toBe('session-target')
  })

  test('a pin that reorders rows keeps the highlight on the pinned session', () => {
    const store = new Store()
    const first = row('session-first', 20)
    const second = row('session-second', 10)
    store.openSessions([first, second])
    store.moveSessionsDialogIndex(1)
    expect(String(store.sessionsFiltered[store.sessionsDialogIndex]?.id)).toBe('session-second')
    // The refresh arrives with the pinned row first (what sessionsFiltered does
    // once the pin is recorded): the highlight follows the ID, not the index.
    store.refreshSessionsDialog([second, first])
    expect(String(store.sessionsFiltered[store.sessionsDialogIndex]?.id)).toBe('session-second')
  })

  test('a highlighted session that vanished leaves the index in range', () => {
    const store = new Store()
    store.openSessions([row('session-a', 20), row('session-b', 10)])
    store.moveSessionsDialogIndex(1)
    store.refreshSessionsDialog([row('session-a', 20)])
    expect(store.sessionsFiltered).toHaveLength(1)
    expect(store.sessionsDialogIndex).toBe(0)
    expect(String(store.sessionsFiltered[store.sessionsDialogIndex]?.id)).toBe('session-a')
  })

  test('opening the dialog from closed still starts at the first row', () => {
    const store = new Store()
    store.refreshSessionsDialog([row('session-a', 20), row('session-b', 10)])
    expect(store.panel).toBe('sessions')
    expect(store.sessionsDialogIndex).toBe(0)
    expect(String(store.sessionsFiltered[0]?.id)).toBe('session-a')
  })
})
