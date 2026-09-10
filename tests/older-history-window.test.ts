/**
 * Tests for the windowed older-history store primitives (优化4): the resume
 * driver keeps at most a bounded number of older-history items loaded behind
 * the marker row while the user reads the live tail, and may drop the OLDEST
 * loaded slices (trimOlderFront) for re-folding on demand near the top.
 *
 * Run with `bun test tests/older-history-window.test.ts`.
 *
 * @module dsh-tui/older-history-window-test
 */

import { describe, expect, test } from 'bun:test'
import type { TranscriptItem } from '../packages/dsh-tui-app/src/index.tsx'
import { Store, olderItemCap, RESUME_OLDER_ITEM_CAP } from '../packages/dsh-tui-app/src/index.tsx'

const item = (kind: TranscriptItem['kind'], text: string): TranscriptItem => ({ key: 0, kind, text })
const texts = (store: Store): string[] => store.getItems().map((it) => it.text)

describe('Store older-history window primitives', () => {
  test('beginHistory paints the marker and resets the loaded-older count', () => {
    const store = new Store()
    store.beginHistory([item('user', 'tail')], [], 900)
    expect(store.olderLoading).toBe(true)
    expect(store.loadedOlder).toBe(0)
    expect(texts(store)).toEqual(['Load session:  ················   0%  0/900 events', 'tail'])
  })

  test('prependHistory counts every prepended older slice', () => {
    const store = new Store()
    store.beginHistory([item('user', 'tail')], [], 900)
    store.prependHistory([item('user', 'a')])
    store.prependHistory([item('user', 'b')])
    store.prependHistory([item('user', 'c')])
    expect(store.loadedOlder).toBe(3)
    // Prepend order = chronological oldest first under the marker (c, b, a),
    // then the tail.
    expect(texts(store)).toEqual(['Load session:  ················   0%  0/900 events', 'c', 'b', 'a', 'tail'])
  })

  test('trimOlderFront drops the OLDEST loaded slices and keeps the marker', () => {
    const store = new Store()
    store.beginHistory([item('user', 'tail')], [], 900)
    store.prependHistory([item('user', 'a')])
    store.prependHistory([item('user', 'b')])
    store.prependHistory([item('user', 'c')])
    const dropped = store.trimOlderFront(1)
    expect(dropped).toBe(2)
    expect(store.loadedOlder).toBe(1)
    expect(store.olderLoading).toBe(true) // more history still available
    expect(texts(store)).toEqual(['Load session:  ················   0%  0/900 events', 'a', 'tail'])
  })

  test('trimOlderFront is a no-op without a marker or below the keep count', () => {
    const store = new Store()
    store.loadHistory([item('user', 'hello')], [])
    expect(store.olderLoading).toBe(false)
    expect(store.trimOlderFront(0)).toBe(0)
    expect(texts(store)).toEqual(['hello'])

    store.beginHistory([item('user', 'tail')], [], 10)
    store.prependHistory([item('user', 'a')])
    expect(store.trimOlderFront(5)).toBe(0) // loadedOlder(1) ≤ keep
    expect(texts(store)).toEqual(['Load session:  ················   0%  0/10 events', 'a', 'tail'])
  })

  test('finishHistory removes the marker; olderLoading flips false', () => {
    const store = new Store()
    store.beginHistory([item('user', 'tail')], [], 900)
    store.prependHistory([item('user', 'a')])
    store.finishHistory()
    expect(store.olderLoading).toBe(false)
    expect(texts(store)).toEqual(['a', 'tail'])
  })
})

describe('P2③ viewport-bounded retention', () => {
  test('the older-history item cap scales with the terminal height', () => {
    expect(olderItemCap(30)).toBe(400)    // floor: 30 × 12 = 360 → 400
    expect(olderItemCap(60)).toBe(720)
    expect(olderItemCap(100)).toBe(1200)
    expect(olderItemCap(1000)).toBe(RESUME_OLDER_ITEM_CAP) // capped at the historical max
    expect(olderItemCap(0)).toBe(RESUME_OLDER_ITEM_CAP)    // unknown height → old behavior
  })
})
