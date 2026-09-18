/**
 * Tests for the Steps sidebar's row budget (`sidebarStepPlan` / `sidebarFits`).
 *
 * The bug these pin: Ink 4 has NO `overflow`, so a sidebar whose content needs
 * more rows than its box has does not clip — Yoga lays the extra rows out BELOW
 * the box and Ink paints them there. On a short terminal (or a narrow one, which
 * wraps the footer) the sidebar's footer landed on the composer card's
 * bottom-border row and its version lines looked like part of the input box.
 * Measured on a real pty: 80×20 and 60×24 overflow with an EMPTY draft, so the
 * draft's line count is NOT the trigger.
 *
 * The load-bearing invariant is `rows <= capacity`: whatever the terminal size,
 * the step list, the session block and the footer together must fit the box.
 *
 * Run with `bun test tests/sidebar-overflow.test.ts`.
 *
 * @module qialike/sidebar-overflow-test
 */

import { describe, expect, test } from 'bun:test'
import { sidebarFits, sidebarStepPlan, SIDEBAR_STATUS_BAR_ROWS } from '../packages/qialike-app/src/pointer-region.ts'

const SESSION_ID = 'session-675efa95-12d1-4821-87bd-a680c4d1693f'
const TITLE = 'qialike修复Bug'
const FOOTER = ['deepseek-harness: 0.1.5-rc.2', 'qialike: 0.4.9-beta']
const STEPS = [
  '✓ Fix README.md launch semantics',
  '✓ Fix README.zh.md launch semantics',
  '✓ Fix stale comment at index.tsx:3184-3188',
  '✓ Verify: typecheck, unit tests, grep for stale phrasing',
]

const plan = (rows: number, width: number, steps = STEPS) => sidebarStepPlan({
  rows,
  width,
  steps,
  sessionTitle: TITLE,
  sessionId: SESSION_ID,
  footerLines: FOOTER,
})

describe('sidebarFits', () => {
  test('needs room for the status bar, borders, padding, gaps, heading and footer', () => {
    // 3 status + 2 border + 1 paddingTop + 4 gaps + 1 heading + 3 footer = 14
    expect(sidebarFits(13)).toBe(false)
    expect(sidebarFits(14)).toBe(true)
    expect(sidebarFits(37)).toBe(true)
  })
})

describe('sidebarStepPlan', () => {
  test('a roomy terminal shows every step and the whole session block', () => {
    const p = plan(37, 133)
    expect(p.showSession).toBe(true)
    expect(p.visible).toBe(STEPS.length)
    expect(p.hidden).toBe(0)
    expect(p.showMore).toBe(false)
    expect(p.rows).toBeLessThanOrEqual(p.capacity)
  })

  test('a short terminal trims the step list and says so', () => {
    const p = plan(20, 80)
    // Steps are the primary content: they keep the slack, the session block is
    // what yields (it needs 1 heading + 1 title + 3 wrapped id rows here).
    expect(p.visible).toBeGreaterThan(0)
    expect(p.visible).toBeLessThan(STEPS.length)
    expect(p.hidden).toBe(STEPS.length - p.visible)
    expect(p.showSession).toBe(false)
    expect(p.rows).toBeLessThanOrEqual(p.capacity)
  })

  test('the marker is drawn only when it fits, and it tells the truth', () => {
    const huge = ['✓ ' + 'x'.repeat(200)]
    // 80×20: the step needs far more than the six-row slack, but the one-row
    // marker does fit — so the user is told a step exists instead of seeing an
    // empty list.
    const roomy = plan(20, 80, huge)
    expect(roomy.visible).toBe(0)
    expect(roomy.hidden).toBe(1)
    expect(roomy.showMore).toBe(true)
    // 80×14 is the floor: the slack is zero, so even the marker is dropped
    // (and at 13 rows the renderer does not draw the sidebar at all).
    const tight = plan(14, 80, huge)
    expect(tight.visible).toBe(0)
    expect(tight.showMore).toBe(false)
    expect(tight.rows).toBeLessThanOrEqual(tight.capacity)
    expect(sidebarFits(14)).toBe(true)
    expect(sidebarFits(13)).toBe(false)
  })

  test('a session with NO steps still budgets its `no plan yet` row', () => {
    // The case the first version of this fix missed: with `steps: []` the sidebar
    // renders `no plan yet` — a real child with one row. Leaving it out put the
    // plan one row over capacity, so Yoga compressed the sidebar's own children:
    // the two footer lines landed on ONE row and the `Session` heading vanished
    // (measured on the user's step-less session at 100x18).
    for (const cols of [80, 100, 120, 133, 160]) {
      for (let rows = 14; rows <= 30; rows++) {
        const p = plan(rows, cols, [])
        expect(p.rows, `${cols}x${rows}`).toBeLessThanOrEqual(p.capacity)
      }
    }
    // Roomy: the placeholder is shown. Cramped: a real session id outranks the
    // filler row, so the placeholder is the first thing to go.
    expect(plan(37, 133, []).showEmpty).toBe(true)
    expect(plan(18, 100, []).showEmpty).toBe(false)
    expect(plan(18, 100, []).showSession).toBe(true)
  })

  test('the session block yields before the steps do', () => {
    // Same rows, same width: more steps ⇒ less leftover ⇒ the block goes first.
    const few = plan(24, 80, STEPS.slice(0, 1))
    const many = plan(24, 80, STEPS)
    expect(few.visible).toBe(1)
    expect(many.visible).toBeGreaterThanOrEqual(few.visible)
    if (many.showSession) expect(few.showSession).toBe(true)
  })

  test('the no-overflow invariant holds across a wide sweep of sizes', () => {
    const widths = [40, 50, 60, 70, 80, 100, 120, 133, 160, 200, 240]
    const rowCounts = [12, 13, 14, 15, 16, 17, 18, 20, 24, 28, 30, 37, 50, 80]
    const stepSets = [[], STEPS, ['✓ short'], ['✓ ' + '长'.repeat(120)], STEPS.slice(0, 1)]
    for (const width of widths) {
      for (const rows of rowCounts) {
        for (const steps of stepSets) {
          const p = plan(rows, width, steps)
          const where = `${width}x${rows} steps=${steps.length}`
          expect(p.visible + p.hidden, where).toBe(steps.length)
          expect(p.visible, where).toBeGreaterThanOrEqual(0)
          // The status bar / border / padding / gap / heading / footer floor.
          expect(p.capacity, where).toBe(rows - SIDEBAR_STATUS_BAR_ROWS - 3)
          if (!sidebarFits(rows)) {
            // Contract: below the floor the renderer does NOT draw the sidebar
            // (`sidebarShown` = width rule AND sidebarFits), so the planner's
            // step budget is 0 and no overflow can reach the composer.
            expect(p.visible, where).toBe(0)
            expect(p.showMore, where).toBe(false)
          } else {
            // The whole point: whatever the plan decides to draw FITS.
            expect(p.rows, where).toBeLessThanOrEqual(p.capacity)
          }
        }
      }
    }
  })

  test('more room never shows fewer steps (monotone in the terminal height)', () => {
    for (const width of [60, 80, 133, 200]) {
      for (const steps of [STEPS, ['✓ ' + 'x'.repeat(90)]]) {
        let previous = -1
        for (let rows = 14; rows <= 60; rows++) {
          const p = plan(rows, width, steps)
          expect(p.visible, `${width}x${rows}`).toBeGreaterThanOrEqual(previous)
          previous = p.visible
        }
      }
    }
  })

  test('the session block is dropped whole when it cannot fit', () => {
    const p = plan(16, 160)
    expect(p.showSession).toBe(false)
    expect(p.rows).toBeLessThanOrEqual(p.capacity)
    // ...and the steps get the space it freed.
    expect(p.visible).toBeGreaterThan(0)
  })
})
