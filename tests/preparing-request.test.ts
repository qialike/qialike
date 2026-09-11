/**
 * Unit tests for the "preparing the request" status line: the elapsed-seconds
 * suffix is gated on the ticker having fired, because the frame that carries
 * the label is flushed right before the harness may take the thread — a clock
 * printed there would freeze at `0.0s` and read as a hang.
 *
 * Run with `bun test tests/preparing-request.test.ts`.
 *
 * @module dsh-tui/preparing-request-test
 */

import { describe, expect, test } from 'bun:test'
import { PREPARING_REQUEST_LABEL, Store, preparingRequestStatusText } from '../packages/dsh-tui-app/src/index.tsx'

describe('preparing-request status text', () => {
  test('no clock before the ticker fired (the label frame must not freeze at 0.0s)', () => {
    expect(preparingRequestStatusText(1000, 5000, false)).toBe(PREPARING_REQUEST_LABEL)
    expect(preparingRequestStatusText(1000, 5000, false)).not.toMatch(/[0-9]/)
  })

  test('no clock while idle, even if a tick was recorded', () => {
    expect(preparingRequestStatusText(null, 5000, true)).toBe(PREPARING_REQUEST_LABEL)
  })

  test('the elapsed seconds appear once the ticker fired', () => {
    expect(preparingRequestStatusText(1000, 4200, true)).toBe('preparing the request… 3.2s')
    expect(preparingRequestStatusText(1000, 17_400, true)).toBe('preparing the request… 16.4s')
  })

  test('the clock never runs backwards', () => {
    expect(preparingRequestStatusText(5000, 1000, true)).toBe('preparing the request… 0.0s')
  })
})

describe('preparing-request store window', () => {
  test('begin → tick → end tracks the clock and the gate', () => {
    const store = new Store()
    expect(store.preparingRequest).toBe(false)
    expect(store.preparingRequestStartedAt).toBeNull()
    expect(store.preparingRequestTicked).toBe(false)

    store.beginPreparingRequest(1_234)
    expect(store.preparingRequest).toBe(true)
    expect(store.preparingRequestStartedAt).toBe(1_234)
    expect(store.preparingRequestTicked).toBe(false)
    // Before the first tick the status bar shows the bare label.
    expect(preparingRequestStatusText(store.preparingRequestStartedAt, 5_634, store.preparingRequestTicked))
      .toBe(PREPARING_REQUEST_LABEL)

    store.tickPreparingRequest()
    expect(store.preparingRequestTicked).toBe(true)
    expect(preparingRequestStatusText(store.preparingRequestStartedAt, 5_634, store.preparingRequestTicked))
      .toBe('preparing the request… 4.4s')

    store.endPreparingRequest()
    expect(store.preparingRequest).toBe(false)
    expect(store.preparingRequestStartedAt).toBeNull()
    expect(store.preparingRequestTicked).toBe(false)
  })

  test('a second begin inside the same window (submit → step/start) keeps the original clock', () => {
    const store = new Store()
    store.beginPreparingRequest(1_000)
    store.tickPreparingRequest()
    store.beginPreparingRequest(2_000)
    expect(store.preparingRequestStartedAt).toBe(1_000)
    expect(store.preparingRequestTicked).toBe(true)
  })

  test('ticking while idle is a no-op', () => {
    const store = new Store()
    store.tickPreparingRequest()
    expect(store.preparingRequest).toBe(false)
    expect(store.preparingRequestTicked).toBe(false)
  })
})
