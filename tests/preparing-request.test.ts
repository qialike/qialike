/**
 * Unit tests for the "preparing the request" status line: the elapsed-seconds
 * suffix is gated on the ticker having fired, because the frame that carries
 * the label is flushed right before the harness may take the thread — a clock
 * printed there would freeze at `0.0s` and read as a hang. The same ticker also
 * owns the window's safety deadline (assembly budget → re-armed provider
 * budget), so the tests below pin both.
 *
 * Run with `bun test tests/preparing-request.test.ts`.
 *
 * @module dsh-tui/preparing-request-test
 */

import { describe, expect, test } from 'bun:test'
import {
  PREPARING_REQUEST_LABEL,
  Store,
  assembledRequestStatusText,
  preparingRequestStatusText,
} from '../packages/dsh-tui-app/src/index.tsx'

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

  test('once the assembly time is known the label names BOTH phases', () => {
    // The whole point of the split: `assemblyMs` is the app's own synchronous
    // assembly (this workstation's log: median 9 ms, max 84 ms), while the wait
    // the user feels is the provider's time-to-first-token (`streamToChunk`
    // median 1.4 s here, 100 s+ on the machine that filed the report) — one
    // label for both made the model wait read as request preparation.
    expect(assembledRequestStatusText(21)).toBe('assembled in 21ms · waiting for the model…')
    expect(preparingRequestStatusText(1000, 90_000, true, 21))
      .toBe('assembled in 21ms · waiting for the model…')
    // No ticker gate any more: the assembly that could block the loop is over.
    expect(preparingRequestStatusText(1000, 1000, false, 124))
      .toBe('assembled in 124ms · waiting for the model…')
    // Fractional and negative values clamp to a whole non-negative count.
    expect(assembledRequestStatusText(20.6)).toBe('assembled in 21ms · waiting for the model…')
    expect(assembledRequestStatusText(-5)).toBe('assembled in 0ms · waiting for the model…')
    // Idle still wins over a stale measurement.
    expect(preparingRequestStatusText(null, 1000, true, 21)).toBe(PREPARING_REQUEST_LABEL)
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
    // The payload exists (the LLM adapter's `noteRequest`): the second phase
    // starts and the measured assembly time is published — the status line no
    // longer counts UP, it reports what the assembly cost.
    store.noteAssemblyElapsed(21)
    expect(store.assemblyMs).toBe(21)
    expect(preparingRequestStatusText(store.preparingRequestStartedAt, 90_000, store.preparingRequestTicked, store.assemblyMs))
      .toBe('assembled in 21ms · waiting for the model…')

    store.endPreparingRequest()
    expect(store.preparingRequest).toBe(false)
    expect(store.preparingRequestStartedAt).toBeNull()
    expect(store.preparingRequestTicked).toBe(false)
    expect(store.assemblyMs).toBeNull()
  })

  test('the assembly measurement is ignored unless a request is in flight', () => {
    const store = new Store()
    store.noteAssemblyElapsed(21)
    expect(store.assemblyMs).toBeNull()
  })

  test('a fresh window starts with no measurement from the previous step', () => {
    const store = new Store()
    store.beginPreparingRequest(1_000)
    store.noteAssemblyElapsed(21)
    store.endPreparingRequest()
    expect(store.preparingDeadlineAt).toBeNull()
    store.beginPreparingRequest(2_000)
    expect(store.assemblyMs).toBeNull()
    // …and a FRESH deadline: the old submit-scoped timer could fire inside a
    // later window and cut it short; a window-owned deadline cannot.
    expect(store.preparingDeadlineAt).toBeGreaterThan(Date.now())
  })

  test('the assembly deadline ends a window nothing ever answers', () => {
    const store = new Store()
    store.beginPreparingRequest()
    const deadline = store.preparingDeadlineAt
    expect(deadline).not.toBeNull()
    // One tick before the deadline only advances the clock.
    store.tickPreparingRequest(deadline! - 1)
    expect(store.preparingRequest).toBe(true)
    expect(store.preparingRequestTicked).toBe(true)
    // At the deadline the window ends (and the deadline is cleared with it).
    store.tickPreparingRequest(deadline!)
    expect(store.preparingRequest).toBe(false)
    expect(store.preparingDeadlineAt).toBeNull()
  })

  test('the provider phase re-arms the deadline, so the model wait is not an assembly hang', () => {
    const store = new Store()
    store.beginPreparingRequest()
    const assemblyDeadline = store.preparingDeadlineAt!
    store.noteAssemblyElapsed(9)
    const providerDeadline = store.preparingDeadlineAt!
    expect(providerDeadline).toBeGreaterThan(assemblyDeadline)
    // Past the ASSEMBLY deadline the window survives: the payload is out and
    // what remains is the provider's time-to-first-token, which the assembly
    // budget must not misreport as still-assembling.
    store.tickPreparingRequest(assemblyDeadline + 1)
    expect(store.preparingRequest).toBe(true)
    expect(store.assemblyMs).toBe(9)
    // Past the PROVIDER deadline it still ends, so a hung provider cannot pin
    // the label forever.
    store.tickPreparingRequest(providerDeadline)
    expect(store.preparingRequest).toBe(false)
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
