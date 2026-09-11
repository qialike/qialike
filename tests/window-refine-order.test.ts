/**
 * S1b — windowed height measurement (`session/optimization-plan.md` §3).
 *
 * The first frame after a `--resume` of the giant session laid out 5103 rows and
 * ran a mdast parse for every one of its 1240 markdown rows: measured 683 of the
 * 752 ms cold layout, i.e. the last big fixed cost before the transcript shows.
 * Only the rows the viewport can show need a precise height; the rest are a
 * cheap wrapped-line placeholder that painting replaces with measured truth.
 *
 * `windowRefineOrder` is the part with a correctness edge: the VISIBLE rows must
 * come first so the `MD_PARSE_BUDGET_MS` budget can only starve overscan rows,
 * never the frame the user is looking at (the tail-clipping failure mode of
 * §2.5.51 is exactly a visible row left with a too-small placeholder).
 */
import { describe, expect, test } from 'bun:test'
import { windowRefineOrder } from '../packages/dsh-tui-app/src/panels/conversation.tsx'

describe('windowRefineOrder (S1b parse order)', () => {
  test('visible rows come first, in top-to-bottom order', () => {
    const order = windowRefineOrder(100, 104, 1000)
    expect(order.slice(0, 5)).toEqual([100, 101, 102, 103, 104])
  })

  test('the tail below the window is refined before the history above it', () => {
    // Follow-tail: rows below the window are the newer ones, so at equal
    // distance below wins — the next screenful the user is about to see gets a
    // precise height before the rows scrolled off above it.
    const order = windowRefineOrder(500, 502, 1000)
    expect(order.slice(3, 9)).toEqual([503, 499, 504, 498, 505, 497])
    expect(order.indexOf(503)).toBeLessThan(order.indexOf(499))
  })

  test('every index appears exactly once (no parse paid twice per pass)', () => {
    const order = windowRefineOrder(40, 60, 200)
    expect(new Set(order).size).toBe(order.length)
  })

  test('stays inside the row range at both ends', () => {
    for (const [first, last, count] of [[0, 4, 10], [995, 999, 1000], [0, 0, 1]] as const) {
      const order = windowRefineOrder(first, last, count)
      expect(order.length).toBeGreaterThan(0)
      expect(Math.min(...order)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...order)).toBeLessThan(count)
    }
  })

  test('an empty transcript yields no work', () => {
    expect(windowRefineOrder(0, 0, 0)).toEqual([])
  })

  test('overscan reaches OVERSCAN_ROWS (48) beyond the window on both sides', () => {
    const order = windowRefineOrder(500, 510, 1000)
    expect(order).toContain(510 + 48)
    expect(order).toContain(500 - 48)
    expect(order).not.toContain(510 + 49)
    expect(order).not.toContain(500 - 49)
  })

  test('a starved budget is a prefix: the first N entries are the visible rows', () => {
    // With the first frame's real numbers (27-row viewport, tail of 5103 rows)
    // the budget stops the loop early — the entries it keeps must be visible.
    const order = windowRefineOrder(5080, 5102, 5103)
    expect(order.slice(0, 23)).toEqual(Array.from({ length: 23 }, (_, i) => 5080 + i))
  })
})
