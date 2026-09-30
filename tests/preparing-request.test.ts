/**
 * Unit tests for the "preparing the request" status line, which carries TWO
 * phases with a clock each: the synchronous assembly (`preparing the request…
 * 4.4s`, gated on the ticker having fired, because the frame that carries the
 * label is flushed right before the harness may take the thread — a clock printed
 * there would freeze at `0.0s` and read as a hang) and the provider wait
 * (`waiting for the model… 12.3s`, counting from the moment the payload left).
 * Each phase shows only its OWN information and clock. The same ticker also owns the window's safety deadline
 * (assembly budget → re-armed provider budget), so the tests below pin all three.
 *
 * Run with `bun test tests/preparing-request.test.ts`.
 *
 * @module qialike/preparing-request-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PREPARING_REQUEST_LABEL,
  Store,
  waitingForModelStatusText,
  preparingRequestStatusText,
} from '../packages/qialike-app/src/index.tsx'

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

  test('phase two shows the WAIT, its own clock, and no assembly number', () => {
    // The two phases are two parts, each showing its own information and time
    // (user request). Phase one's cost is measured and logged (`[assembly] …
    // assemblyMs=`) and shown live while assembling; phase two must not repeat it.
    expect(waitingForModelStatusText(0)).toBe('waiting for the model… 0.0s')
    expect(waitingForModelStatusText(12_340)).toBe('waiting for the model… 12.3s')
    expect(preparingRequestStatusText(1_000, 90_000, true, 21, 77_660))
      .toBe('waiting for the model… 12.3s')
    // No ticker gate any more: the assembly that could block the loop is over.
    expect(preparingRequestStatusText(1_000, 1_000, false, 124, 1_000))
      .toBe('waiting for the model… 0.0s')
    // Fractional and negative waits clamp to a non-negative count.
    expect(waitingForModelStatusText(12_340.6)).toBe('waiting for the model… 12.3s')
    expect(waitingForModelStatusText(-900)).toBe('waiting for the model… 0.0s')
    // An unknown origin cannot invent a wait.
    expect(preparingRequestStatusText(1_000, 90_000, true, 21)).toBe('waiting for the model… 0.0s')
    // The assembly measurement never leaks into phase two's text.
    expect(preparingRequestStatusText(1_000, 90_000, true, 124, 77_660)).not.toContain('assembled')
    // Idle still wins over a stale measurement.
    expect(preparingRequestStatusText(null, 1000, true, 21, 1_000)).toBe(PREPARING_REQUEST_LABEL)
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
    // starts: the wait clock begins from THIS moment (not from the assembly
    // start), and the status bar switches to phase two.
    store.noteAssemblyElapsed(21)
    expect(store.assemblyMs).toBe(21)
    expect(store.assemblyDoneAt).not.toBeNull()
    const doneAt = store.assemblyDoneAt!
    expect(preparingRequestStatusText(store.preparingRequestStartedAt, doneAt + 12_340,
      store.preparingRequestTicked, store.assemblyMs, store.assemblyDoneAt))
      .toBe('waiting for the model… 12.3s')
    // …and it keeps counting while the provider thinks.
    expect(preparingRequestStatusText(store.preparingRequestStartedAt, doneAt + 60_000,
      store.preparingRequestTicked, store.assemblyMs, store.assemblyDoneAt))
      .toBe('waiting for the model… 60.0s')

    store.endPreparingRequest()
    expect(store.preparingRequest).toBe(false)
    expect(store.preparingRequestStartedAt).toBeNull()
    expect(store.preparingRequestTicked).toBe(false)
    expect(store.assemblyMs).toBeNull()
    expect(store.assemblyDoneAt).toBeNull()
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
    // …not even phase two's clock origin: a new window may not inherit the
    // previous step's wait.
    expect(store.assemblyDoneAt).toBeNull()
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

describe('preparing-request wiring (source level)', () => {
  // The text functions can be perfect while nothing passes them the new input —
  // exactly the drift these guards exist for (see the same pattern in
  // `tests/sidebar-goal-bar.test.ts` / `tests/paint-wide-glyphs.test.ts`).
  const read = (path: string): string => readFileSync(join(import.meta.dir, '..', path), 'utf8')

  test('the status bar hands BOTH clocks to the label', () => {
    expect(read('packages/qialike-app/src/panels/conversation.tsx')).toContain(
      'preparingRequestStatusText(store.preparingRequestStartedAt, Date.now(), '
      + 'store.preparingRequestTicked, store.assemblyMs, store.assemblyDoneAt)')
  })

  test('the store takes phase two\'s origin when the assembly ends, and clears it', () => {
    const source = read('packages/qialike-app/src/index.tsx')
    const note = source.slice(source.indexOf('noteAssemblyElapsed(ms: number)'),
                              source.indexOf('tickPreparingRequest(now'))
    expect(note, 'the payload moment is recorded').toContain('this._assemblyDoneAt = Date.now()')
    // …and the adapter reports that moment (the payload string exists).
    expect(source).toContain('store.noteAssemblyElapsed(cur.streamAt - cur.startedAt)')
    // Both ends of a window drop it, so no step inherits the previous wait.
    const begin = source.slice(source.indexOf('beginPreparingRequest(startedAt'),
                               source.indexOf('noteAssemblyElapsed(ms: number)'))
    const end = source.slice(source.indexOf('endPreparingRequest(): void'),
                             source.indexOf('endPreparingRequest(): void') + 500)
    expect(begin).toContain('this._assemblyDoneAt = null')
    expect(end).toContain('this._assemblyDoneAt = null')
  })
})
