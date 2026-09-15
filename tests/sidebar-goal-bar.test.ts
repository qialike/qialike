/**
 * The sidebar's plugin SECTIONS (`tui.sidebar`) and the goal bar that uses them.
 *
 * The load-bearing invariant is unchanged: `sidebarStepPlan.rows <= capacity`,
 * now WITH contributed sections in play. A section is one more sidebar child, so
 * an accepted one costs its own rows plus one `gap 1` row — the bug this catches
 * is a contributed block pushing the sidebar's footer over the composer (Ink 4
 * has no `overflow`, so the footer would be painted INSIDE the input card).
 *
 * The goal bar itself is read-only by design: the planner decides full /
 * compact / dropped, the bar only paints what it is handed.
 *
 * Run with `bun test tests/sidebar-goal-bar.test.ts`.
 *
 * @module dsh-tui/sidebar-goal-bar-test
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sidebarStepPlan, sidebarFits, type SidebarSectionBudget } from '../packages/dsh-tui-app/src/pointer-region.ts'
import { goalBarRows, goalBarTitle } from '../packages/dsh-tui-app/src/goal-bar.tsx'
import type { GoalView } from '@deepseek-ai/dsh-goal'

const REPO = join(import.meta.dir, '..')
const APP = join(REPO, 'packages', 'dsh-tui-app')
const SRC = join(APP, 'src')
const read = (path: string): string => readFileSync(path, 'utf8')

const SESSION_ID = 'session-675efa95-12d1-4821-87bd-a680c4d1693f'
const FOOTER = ['deepseek-harness: 0.1.5-rc.2', 'dsh-tui: 0.4.16-beta']
const STEPS = ['✓ one', '✓ two', '→ three', '· four']
const SECTION: SidebarSectionBudget = { id: 'goal-bar', order: 10, full: 2, compact: 1 }

const plan = (rows: number, width: number, sections: SidebarSectionBudget[] | undefined, steps = STEPS) => sidebarStepPlan({
  rows,
  width,
  steps,
  sessionTitle: 'goal bar',
  sessionId: SESSION_ID,
  footerLines: FOOTER,
  ...(sections === undefined ? {} : { sections }),
})

const goal = (over: Partial<GoalView> = {}): GoalView => ({
  id: 'goal-1',
  revision: 1,
  objective: 'Ship the goal bar',
  phase: 'active',
  maxGoalRounds: 40,
  roundsStarted: 3,
  createdAt: 0,
  updatedAt: 0,
  activation: 'armed',
  ...over,
} as GoalView)

describe('sidebarStepPlan budgets plugin sections first', () => {
  test('omitting `sections` is byte-identical to passing none', () => {
    for (const rows of [14, 16, 20, 37]) {
      for (const width of [80, 133]) {
        expect(plan(rows, width, undefined)).toEqual(plan(rows, width, []))
      }
    }
    expect(plan(20, 80, []).shownSections).toEqual([])
  })

  test('a roomy column shows the section at full height, above the steps', () => {
    const p = plan(37, 133, [SECTION])
    expect(p.shownSections).toEqual([{ id: 'goal-bar', compact: false }])
    expect(p.visible).toBeGreaterThan(0)
    expect(p.rows).toBeLessThanOrEqual(p.capacity)
  })

  test('a tight column takes the compact fallback instead of dropping it', () => {
    // 16 rows: inner 10, gaps 5 + heading 1 + footer 3 => 1 slack row for the
    // section — full (2) cannot fit, compact (1) can, and the steps then get 0.
    const p = plan(16, 80, [SECTION])
    expect(p.shownSections).toEqual([{ id: 'goal-bar', compact: true }])
    expect(p.visible).toBe(0)
    expect(p.rows).toBeLessThanOrEqual(p.capacity)
  })

  test('when not even the compact row fits the section is dropped whole', () => {
    const p = plan(15, 80, [SECTION])
    expect(p.shownSections).toEqual([])
    expect(p.rows).toBeLessThanOrEqual(p.capacity)
    // ...and the space it would have taken goes back to the steps: one slack
    // row shows one short step (with four steps the `… +N more` marker wins
    // instead, which is the documented trade).
    const one = plan(15, 80, [SECTION], ['✓ one'])
    expect(one.shownSections).toEqual([])
    expect(one.visible).toBe(1)
  })

  test('sections come in `order`, and each accepted one costs a gap row', () => {
    const a: SidebarSectionBudget = { id: 'second', order: 20, full: 1, compact: 1 }
    const b: SidebarSectionBudget = { id: 'first', order: 5, full: 1, compact: 1 }
    const p = plan(37, 160, [a, b])
    expect(p.shownSections.map((s) => s.id)).toEqual(['first', 'second'])
    // Both accepted: 2 rows + 2 gaps entered the budget.
    expect(p.rows).toBeLessThanOrEqual(p.capacity)
  })

  test('the no-overflow invariant holds with sections across a wide sweep', () => {
    const widths = [60, 80, 100, 133, 200]
    const rowCounts = [12, 13, 14, 15, 16, 18, 20, 24, 30, 37]
    const sections: SidebarSectionBudget[][] = [
      [],
      [SECTION],
      [{ ...SECTION, full: 3, compact: 1 }],
      [SECTION, { id: 'other', order: 20, full: 2, compact: 1 }],
      [{ ...SECTION, full: 0, compact: 0 }],
      [{ ...SECTION, full: 6, compact: 3 }],
    ]
    for (const width of widths) {
      for (const rows of rowCounts) {
        for (const list of sections) {
          const p = plan(rows, width, list, [])
          const where = `${width}x${rows} sections=${list.map((s) => s.full).join(',')}`
          if (!sidebarFits(rows)) {
            // Below the floor the renderer does not draw the sidebar at all
            // (same contract as the pre-section plan), so only the section
            // drop-out matters here.
            expect(p.shownSections, where).toEqual([])
          } else {
            expect(p.rows, where).toBeLessThanOrEqual(p.capacity)
          }
        }
      }
    }
  })

  test('more terminal rows never shows fewer steps under the same sections', () => {
    for (const width of [80, 133]) {
      for (const steps of [STEPS, ['✓ ' + 'x'.repeat(90)]]) {
        let previous = -1
        for (let rows = 14; rows <= 60; rows++) {
          const p = plan(rows, width, [SECTION], steps)
          expect(p.visible, `${width}x${rows}`).toBeGreaterThanOrEqual(previous)
          previous = p.visible
        }
      }
    }
  })
})

describe('the goal bar paints the durable goal state', () => {
  test('title carries phase, disarmed activation and the round counter', () => {
    expect(goalBarTitle(goal())).toBe('Goal · active 3/40')
    expect(goalBarTitle(goal({ activation: 'disarmed' }))).toBe('Goal · active · disarmed 3/40')
    expect(goalBarTitle(goal({ phase: 'paused' }))).toBe('Goal · paused 3/40')
    expect(goalBarTitle(goal({ phase: 'complete', roundsStarted: 7 }))).toBe('Goal · complete 7/40')
  })

  test('rows: nothing without a goal, +1 for a live blocker, 1 when compact', () => {
    expect(goalBarRows(undefined)).toEqual({ full: 0, compact: 0 })
    expect(goalBarRows(goal())).toEqual({ full: 2, compact: 1 })
    expect(goalBarRows(goal({ phase: 'blocked', blockedReason: { code: 'round-limit', message: 'done' } })))
      .toEqual({ full: 3, compact: 1 })
    // `blocked` without a reason paints no blocker row.
    expect(goalBarRows(goal({ phase: 'blocked' }))).toEqual({ full: 2, compact: 1 })
  })
})

describe('the extension point is wired end to end', () => {
  test('the service exposes the sidebar registry and the section type', () => {
    const index = read(join(SRC, 'index.tsx'))
    expect(index).toContain('export interface TuiSidebarSection')
    expect(index).toMatch(/sidebar:\s*\{\s*\n\s*register\(section: TuiSidebarSection\)/)
    expect(index).toContain('tuiSidebar.set(section.id, section)')
    // Same sort the planner uses, so paint order and budget order agree.
    expect(index).toContain('a.order - b.order')
  })

  test('the conversation asks every section for rows and paints what the plan accepted', () => {
    const conversation = read(join(SRC, 'panels', 'conversation.tsx'))
    expect(conversation).toContain('props.tui.sidebar?.list()')
    expect(conversation).toContain('section.rows(store, sidebarContentWidth)')
    expect(conversation).toContain('sections: sidebarSections.map')
    expect(conversation).toContain('sidebarPlan.shownSections.map')
    expect(conversation).toContain('entry.section.render(store, sidebarContentWidth, compact)')
  })

  test('the plugin registers a section, watches the goal domain, and stays read-only', () => {
    const bar = read(join(SRC, 'goal-bar.tsx'))
    expect(bar).toContain('tui.sidebar.register(section)')
    expect(bar).toContain("ctx.on('goal/changed'")
    expect(bar).toContain('ctx.goals')
    // Read-only: no key/mouse surface, no shortcut registration (the header
    // comment mentions the mouse only to say there is none, so the guards match
    // the API names, not prose).
    expect(bar).not.toContain('handleKey')
    expect(bar).not.toContain('mousePress')
    expect(bar).not.toContain('mouseMove')
    expect(bar).not.toContain('commands.register')
  })

  test('the package exports, build entry and patch row all name the plugin', () => {
    const pkg = JSON.parse(read(join(APP, 'package.json'))) as { exports: Record<string, unknown> }
    expect(pkg.exports['./goal-bar']).toBeDefined()
    expect(read(join(REPO, 'apps', 'tui-bin', 'build.mjs'))).toContain('src/goal-bar.tsx')
    const patch = read(join(APP, 'cordis.patch.yml'))
    expect(patch).toContain('tui-goal-bar')
    expect(patch).toContain("'@yourname/dsh-tui-app/goal-bar'")
  })
})
