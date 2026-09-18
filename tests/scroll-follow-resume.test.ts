/**
 * Tail-following must RESUME when the reader scrolls back to the bottom.
 *
 * Reported on the real UI: mid-turn, PgUp to read older output, then PgDn back
 * down to the bottom — the new rows streamed in below the window and the view
 * looked frozen. Root cause: `scrollPage`/`scrollLines` cleared `_followTail` on
 * every scroll input, including the one that landed exactly at `maxScroll`, so
 * the bottom stopped being an anchor.
 *
 * These drive the real `Store` scroll API with a fixed layout (content 100 rows
 * in a 10-row viewport ⇒ maxScroll 90), so the state machine — not a
 * re-implementation — is what gets pinned.
 *
 * Run with `bun test tests/scroll-follow-resume.test.ts`.
 *
 * @module qialike/scroll-follow-resume-test
 */
import { describe, expect, test } from 'bun:test'
import { Store } from '../packages/qialike-app/src/index.tsx'
import { WHEEL_STEP } from '../packages/qialike-app/src/config.ts'

const CONTENT = 100
const VIEWPORT = 10
const MAX = CONTENT - VIEWPORT // 90

/** A store whose rendered transcript is 100 rows tall in a 10-row viewport. */
function scrolled(): Store {
  const store = new Store()
  store.setLayout(CONTENT, VIEWPORT, MAX, 60)
  return store
}

describe('reaching the bottom re-arms tail-following', () => {
  test('PgUp disarms, PgDn back to the bottom re-arms (the reported bug)', () => {
    const store = scrolled()
    expect(store.followTail).toBe(true)
    store.scrollPage(-1)
    expect(store.followTail).toBe(false)
    expect(store.scroll).toBe(MAX - VIEWPORT)
    store.scrollPage(1)
    expect(store.scroll).toBe(MAX)
    expect(store.followTail).toBe(true)
  })

  test('two pages up need two pages down, and only the second re-arms', () => {
    const store = scrolled()
    store.scrollPage(-1)
    store.scrollPage(-1)
    expect(store.scroll).toBe(MAX - 2 * VIEWPORT)
    store.scrollPage(1)
    expect(store.followTail).toBe(false)
    expect(store.scroll).toBe(MAX - VIEWPORT)
    store.scrollPage(1)
    expect(store.followTail).toBe(true)
  })

  test('a page down that does NOT reach the bottom stays disarmed', () => {
    const store = scrolled()
    store.scrollPage(-1)
    store.scrollPage(-1)
    store.scrollPage(-1)
    store.scrollPage(1)
    expect(store.followTail).toBe(false)
    expect(store.scroll).toBeLessThan(MAX)
  })

  test('PgUp at the very top stays disarmed (no accidental re-arm)', () => {
    const store = scrolled()
    store.scrollTop()
    expect(store.followTail).toBe(false)
    store.scrollPage(-1)
    expect(store.followTail).toBe(false)
    expect(store.scroll).toBe(0)
  })

  test('the mouse wheel obeys the same rule at the bottom', () => {
    const store = scrolled()
    store.scrollTop()
    expect(store.followTail).toBe(false)
    // One step short of the bottom: still disarmed.
    store.scrollLines(MAX - WHEEL_STEP)
    expect(store.followTail).toBe(false)
    // The step that lands on the bottom re-arms.
    store.scrollLines(WHEEL_STEP)
    expect(store.scroll).toBe(MAX)
    expect(store.followTail).toBe(true)
  })

  test('wheel up from following disarms; wheel down while following stays armed', () => {
    const store = scrolled()
    store.scrollLines(-WHEEL_STEP)
    expect(store.followTail).toBe(false)
    expect(store.scroll).toBe(MAX - WHEEL_STEP)
    store.scrollLines(WHEEL_STEP * 100) // overshoot clamps to the bottom
    expect(store.scroll).toBe(MAX)
    expect(store.followTail).toBe(true)
    store.scrollLines(WHEEL_STEP) // already at the bottom
    expect(store.followTail).toBe(true)
  })

  test('content that fits keeps following on any scroll input', () => {
    const store = new Store()
    store.setLayout(VIEWPORT, VIEWPORT, 0, 0)
    store.scrollPage(-1)
    expect(store.followTail).toBe(true)
    store.scrollPage(1)
    expect(store.followTail).toBe(true)
    store.scrollLines(WHEEL_STEP)
    expect(store.followTail).toBe(true)
  })

  test('explicit top/bottom remain authoritative', () => {
    const store = scrolled()
    store.scrollTop()
    expect(store.followTail).toBe(false)
    expect(store.scroll).toBe(0)
    store.scrollBottom()
    expect(store.followTail).toBe(true)
    expect(store.scroll).toBe(MAX)
    // A page up after an explicit bottom follows the same rules.
    store.scrollPage(-1)
    expect(store.followTail).toBe(false)
  })
})
