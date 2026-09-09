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
import { Store } from '../packages/dsh-tui-app/src/index.tsx'

const item = (kind: TranscriptItem['kind'], text: string): TranscriptItem => ({ key: 0, kind, text })
const texts = (store: Store): string[] => store.getItems().map((it) => it.text)

describe('Store older-history window primitives', () => {
  test('beginHistory paints the marker and resets the loaded-older count', () => {
    const store = new Store()
    store.beginHistory([item('user', 'tail')], [], 900)
    expect(store.olderLoading).toBe(true)
    expect(store.loadedOlder).toBe(0)
    expect(texts(store)).toEqual(['⋯ 更早历史载入中：0/900 事件', 'tail'])
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
    expect(texts(store)).toEqual(['⋯ 更早历史载入中：0/900 事件', 'c', 'b', 'a', 'tail'])
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
    expect(texts(store)).toEqual(['⋯ 更早历史载入中：0/900 事件', 'a', 'tail'])
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
    expect(texts(store)).toEqual(['⋯ 更早历史载入中：0/10 事件', 'a', 'tail'])
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
