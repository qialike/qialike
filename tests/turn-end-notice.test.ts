/**
 * Every `turn/end` reason is either explained or deliberately quiet.
 *
 * The regression this pins: only `max-tokens` was rendered, so a turn that died
 * before its first model call — a runtime fault, a pre-step refusal, a waking
 * message a plugin consumed — ended with NOTHING on screen. That is
 * indistinguishable from a submission that never ran, and it is exactly how a
 * broken cross-built Windows binary was reported ("submitted a task, no
 * response"). A quiet ending is now a decision, not an omission.
 *
 * Run with `bun test tests/turn-end-notice.test.ts`.
 *
 * @module qialike/turn-end-notice-test
 */

import { describe, expect, test } from 'bun:test'
import { turnEndNotice } from '../packages/qialike-app/src/turn-end-notice.ts'

const STEPPED = { textProduced: true, stepped: true }
const EMPTY = { textProduced: false, stepped: false }

describe('the status line a finished turn owes the user', () => {
  test('a failure names the failure, including its code when the harness reported one', () => {
    const notice = turnEndNotice({ kind: 'error', error: { message: 'fetch failed', code: 'LLM_NETWORK' } }, STEPPED)
    expect(notice).toContain('This turn failed')
    expect(notice).toContain('fetch failed')
    expect(notice).toContain('LLM_NETWORK')
  })

  test('a failure with no detail still says so rather than rendering an empty message', () => {
    for (const reason of [{ kind: 'error' }, { kind: 'error', error: {} }, { kind: 'error', error: { message: '  ' } }]) {
      const notice = turnEndNotice(reason, STEPPED)
      expect(notice).toContain('This turn failed')
      expect(notice).toContain('no detail reported')
    }
  })

  test('a blocked turn explains that nothing was sent', () => {
    expect(turnEndNotice({ kind: 'blocked' }, EMPTY)).toContain('blocked before any model call')
  })

  test('a completed turn that never reached a model call is called out', () => {
    // The silent case: no step, no text, reason "completed".
    expect(turnEndNotice({ kind: 'completed' }, EMPTY)).toContain('produced no output')
  })

  test('the ordinary endings stay quiet', () => {
    // Work happened (the transcript shows it), or the user cancelled knowingly.
    expect(turnEndNotice({ kind: 'completed' }, STEPPED)).toBeUndefined()
    expect(turnEndNotice({ kind: 'completed' }, { textProduced: true, stepped: false })).toBeUndefined()
    expect(turnEndNotice({ kind: 'completed' }, { textProduced: false, stepped: true })).toBeUndefined()
    expect(turnEndNotice({ kind: 'aborted', reason: { kind: 'user' } }, EMPTY)).toBeUndefined()
    expect(turnEndNotice({ kind: 'interrupted' }, EMPTY)).toBeUndefined()
  })

  test('an absent or unrecognized reason is quiet, never a crash', () => {
    expect(turnEndNotice(undefined, EMPTY)).toBeUndefined()
    expect(turnEndNotice({}, EMPTY)).toBeUndefined()
    expect(turnEndNotice({ kind: 'some-plugin-reason' }, EMPTY)).toBeUndefined()
  })

  test('max-tokens keeps both of its notices, chosen by whether text was produced', () => {
    expect(turnEndNotice({ kind: 'max-tokens' }, { textProduced: false, stepped: true })).toContain('output length cap')
    expect(turnEndNotice({ kind: 'max-tokens' }, STEPPED)).toContain('Response truncated')
  })
})
