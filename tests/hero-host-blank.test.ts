/**
 * The hero ("New Session" screen) is decided by ONE predicate —
 * `Store.hero` → `sessionBlank(id) === true` — and the blank bit has to be
 * recorded on every path that installs a session. In host mode nobody recorded
 * it (the calls all sat in the in-process paths), so the moment host mode became
 * the default (P4c M5) the hero silently stopped appearing: `sessionBlank()`
 * stayed `undefined`, `hero` was always false, and every flat launch rendered the
 * docked chrome instead. Nothing caught it: the hero unit tests cover the
 * predicate and the layout, not that a launch renders it.
 *
 * So the invariant is pinned at the source level — "the host answers blankness,
 * and every attach path records it" — the same way the prompt gate is pinned.
 *
 * Run with `bun test tests/hero-host-blank.test.ts`.
 *
 * @module dsh-tui/hero-host-blank-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (relative: string): string =>
  readFileSync(new URL(`../packages/dsh-tui-app/src/${relative}`, import.meta.url), 'utf8')

describe('the host is the authority on "blank"', () => {
  test('the host reports blank in its `attached` answer', () => {
    const host = read('host.ts')
    expect(host).toContain('const sessionBlank = (): boolean => foldSessionBlank(snapshot())')
    expect(host).toContain('blank: sessionBlank(),')
  })

  test('the protocol carries it', () => {
    expect(read('host-client.ts')).toContain('blank?: boolean')
  })
})

describe('every host attach path records it', () => {
  const source = read('index.tsx')
  const recorded = source.split('rememberBlank(SessionId(attached.sessionId), attached.blank)').length - 1

  test('the host-paged path (flat launch, /new, switch) records it', () => {
    const serve = source.slice(source.indexOf('const serveHostSession = async ('))
    const body = serve.slice(0, serve.indexOf('\n  /**'))
    expect(body).toContain('rememberBlank(SessionId(attached.sessionId), attached.blank)')
  })

  test('both file-backed warm-ups (boot and switch) record it', () => {
    // serveHostSession + the two phase-2 warm-ups.
    expect(recorded).toBeGreaterThanOrEqual(3)
  })

  test('the file-backed phase 1 guesses from the log it read, and never guesses "blank" from a window', () => {
    expect(source).toContain('rememberBlank(SessionId(sessionId_), tail.startSeq === 0 ? foldSessionBlank(events) : false)')
  })

  test('/new on an already-blank session keeps the hero', () => {
    expect(source).toContain('rememberBlank(SessionId(answer.sessionId), true)')
  })
})
