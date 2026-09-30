/**
 * Unit tests for the plan-review dock scroll mapping (`reviewScrollCommand` in
 * panels/question.tsx): while the plan confirm/decline dock is up, PgUp/PgDn
 * must roll the MESSAGE LIST behind the dock (the plan block lives in the
 * transcript; the dock's 2-option body never scrolls). The wheel is NOT part
 * of this mapping anymore — a wheel tick is routed by the pointer's screen
 * region in `questionKey` (inert over the dock, transcript scroll only when
 * the pointer is on the message column outside it). Every other key — incl.
 * ↑/↓, which keep moving the choice — maps to null.
 *
 * Run with `bun test tests/review-scroll.test.ts`.
 *
 * @module qialike/review-scroll-test
 */

import { describe, expect, test } from 'bun:test'
import { reviewScrollCommand } from '../packages/qialike-app/src/panels/question.tsx'
import type { RawKey } from '../packages/qialike-app/src/stdin.ts'

/** A RawKey carrying exactly one flag (like the stdin decoder emits). */
function key(flag: keyof RawKey): RawKey {
  return { [flag]: true } as RawKey
}

describe('reviewScrollCommand (plan-review dock → transcript scroll)', () => {
  test('PgUp/PgDn page the transcript by a full screen', () => {
    expect(reviewScrollCommand(key('pageUp'))).toEqual({ type: 'page', dir: -1 })
    expect(reviewScrollCommand(key('pageDown'))).toEqual({ type: 'page', dir: 1 })
  })

  test('the wheel is NOT captured (pointer-region routing owns it)', () => {
    expect(reviewScrollCommand(key('wheelUp'))).toBeNull()
    expect(reviewScrollCommand(key('wheelDown'))).toBeNull()
  })

  test('option navigation and answering keys are NOT captured', () => {
    for (const flag of ['upArrow', 'downArrow', 'return', 'escape', 'tab'] as const) {
      expect(reviewScrollCommand(key(flag))).toBeNull()
    }
    expect(reviewScrollCommand({} as RawKey)).toBeNull()
  })
})
