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
 * @module qialike/sidebar-goal-bar-test
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import wrapAnsi from 'wrap-ansi'
import { sidebarStepPlan, sidebarFits, SIDEBAR_STATUS_BAR_ROWS, type SidebarSectionBudget } from '../packages/qialike-app/src/pointer-region.ts'
import { goalBarRows, goalBarTitle } from '../packages/qialike-app/src/goal-bar.tsx'
import type { GoalView } from '@deepseek-ai/dsh-goal'

const REPO = join(import.meta.dir, '..')
const APP = join(REPO, 'packages', 'qialike-app')
const SRC = join(APP, 'src')
const read = (path: string): string => readFileSync(path, 'utf8')

const SESSION_ID = 'session-675efa95-12d1-4821-87bd-a680c4d1693f'
const FOOTER = ['deepseek-harness: 0.1.5-rc.2', 'qialike: 0.4.16-beta']
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

describe('sidebarStepPlan budgets plugin sections AFTER the steps', () => {
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

  test('a tight column keeps the STEPS and yields the section', () => {
    // 16 rows with a four-step plan: the compact section would fit, but only by
    // taking the row the first step needs. Steps are the primary content, so the
    // section is dropped and the step survives (this is the finding's fix: the
    // old "sections first" rule showed the bar and evicted the step).
    const p = plan(16, 80, [SECTION])
    expect(p.shownSections).toEqual([])
    expect(p.visible).toBe(1)
    expect(p.rows).toBeLessThanOrEqual(p.capacity)
  })

  test('with nothing to show in the steps the section still folds to compact', () => {
    // No steps: the planner has no visible step to protect, so the section takes
    // its compact row (and the full form at two rows less still needs 17 rows).
    const compact = plan(16, 80, [SECTION], [])
    expect(compact.shownSections).toEqual([{ id: 'goal-bar', compact: true }])
    expect(compact.rows).toBeLessThanOrEqual(compact.capacity)
    const full = plan(17, 80, [SECTION], [])
    expect(full.shownSections).toEqual([{ id: 'goal-bar', compact: false }])
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
          expect(p.visible + p.hidden, where).toBe(0) // conservation (no steps here)
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

  test('more terminal rows never shows fewer steps — for EVERY plugin budget', () => {
    // The finding this pins: budgeting sections first made the step count
    // non-monotone for 40 of 44 (full, compact) pairs — one extra row let a
    // dropped section back in (or upgraded it to full) and pushed steps out.
    // The old single-fixture test missed it because goal-bar's own pair happened
    // to be safe on those widths/step sets. Sweep the whole grid.
    const widths = [60, 80, 100, 133, 160, 200]
    const stepSets = [[], ['✓ one'], STEPS, Array.from({ length: 20 }, (_, i) => `✓ step ${i + 1}`),
      ['✓ a', '✓ ' + 'x'.repeat(60), '→ three', '· four']]
    let checked = 0
    for (const width of widths) {
      for (const steps of stepSets) {
        for (let full = 1; full <= 6; full++) {
          for (let compact = 0; compact <= full; compact++) {
            checked += 1
            let previous = -1
            for (let rows = 14; rows <= 60; rows++) {
              const p = plan(rows, width, [{ id: 'goal-bar', order: 10, full, compact }], steps)
              const where = `${width}x${rows} ${full}/${compact} steps=${steps.length}`
              expect(p.visible, where).toBeGreaterThanOrEqual(previous)
              expect(p.visible + p.hidden, where).toBe(steps.length)
              previous = p.visible
            }
          }
        }
      }
    }
    expect(checked).toBe(widths.length * stepSets.length * 27)
  })


  test('parity: the polynomial selection matches the exhaustive reference everywhere', () => {
    // The rewrite must not change WHAT is painted — only how it is found.
    const widths = [60, 80, 133, 200]
    const stepSets = [[], ['✓ one'], STEPS, Array.from({ length: 9 }, (_, i) => `✓ step ${i + 1}`)]
    const sectionSets: SidebarSectionBudget[][] = []
    for (let full = 1; full <= 4; full++) {
      for (let compact = 0; compact <= full; compact++) sectionSets.push([{ id: 'g', order: 10, full, compact }])
    }
    sectionSets.push([{ id: 'a', order: 5, full: 1, compact: 1 }, { id: 'b', order: 9, full: 3, compact: 1 }])
    sectionSets.push([{ id: 'a', order: 5, full: 2, compact: 0 }, { id: 'b', order: 9, full: 2, compact: 1 }])
    sectionSets.push([
      { id: 'a', order: 1, full: 1, compact: 1 }, { id: 'b', order: 2, full: 3, compact: 2 },
      { id: 'c', order: 3, full: 2, compact: 1 },
    ])
    let checked = 0
    for (const width of widths) {
      for (const steps of stepSets) {
        for (const sections of sectionSets) {
          for (let rows = 12; rows <= 40; rows += 2) {
            const input = { rows, width, steps, sessionTitle: 'goal bar', sessionId: SESSION_ID, footerLines: FOOTER, sections }
            const want = referencePlan(input)
            const got = sidebarStepPlan(input)
            const where = `${width}x${rows} steps=${steps.length} sections=${sections.length} ${sections.map((s) => `${s.full}/${s.compact}`).join(',')}`
            expect({ ...got }, where).toEqual(want)
            checked += 1
          }
        }
      }
    }
    expect(checked).toBe(4 * 4 * (14 + 3) * 15)
  })

  test('the goal-bar pair that broke before now keeps the step', () => {
    // Measured pre-fix at width 80 with one short step and goal-bar's own 2/1:
    // rows 15 -> visible 1 (no bar), rows 16 -> visible 0 + compact bar. The step
    // must survive the extra row.
    const one = ['✓ one']
    expect(plan(15, 80, [SECTION], one).visible).toBe(1)
    const at16 = plan(16, 80, [SECTION], one)
    expect(at16.visible).toBe(1)
    expect(at16.shownSections).toEqual([])
    const at17 = plan(17, 80, [SECTION], one)
    expect(at17.visible).toBe(1)
    expect(at17.shownSections).toEqual([{ id: 'goal-bar', compact: true }])
  })
})

/**
 * The PRE-polynomial selection, kept as an independent reference: enumerate
 * every (dropped | compact | full) configuration, keep max `visible` then max
 * section rows, first in the DFS order (dropped, then compact, then full per
 * section). `sidebarStepPlan` must agree with it field for field — that is the
 * parity the polynomial rewrite (cost threshold + knapsack) has to preserve.
 */
function referencePlan(input: {
  rows: number; width: number; steps: readonly string[]; sessionTitle?: string; sessionId?: string
  footerLines: readonly string[]; sections?: readonly SidebarSectionBudget[]
}) {
  const contentWidth = Math.max(1, Math.max(20, Math.round(input.width * 0.3)) - 4)
  const inner = Math.max(0, input.rows - SIDEBAR_STATUS_BAR_ROWS - 2 - 1)
  const heading = 1
  const footer = 3
  const stepRows = input.steps.map((step) => step === ''
    ? 1
    : wrapAnsi(step, Math.max(1, contentWidth), { trim: false, hard: true }).split('\n').length)
  const budget = (shownCount: number, sectionRows: number) => {
    const gaps = 4 + shownCount
    const slack = inner - gaps - heading - footer - sectionRows
    if (slack < 0) return undefined
    let used = 0
    let visible = 0
    while (visible < stepRows.length && used + stepRows[visible]! <= slack) { used += stepRows[visible]!; visible += 1 }
    let hidden = input.steps.length - visible
    let showMore = false
    if (hidden > 0) {
      while (visible > 0 && used + 1 > slack) { visible -= 1; hidden += 1; used -= stepRows[visible]! }
      showMore = used + 1 <= slack
    }
    const sessionNeeds = 1 + (input.sessionTitle === undefined ? 0 : 1)
      + (input.sessionId === undefined ? 0 : (input.sessionId === '' ? 1
        : wrapAnsi(input.sessionId, Math.max(1, contentWidth), { trim: false, hard: true }).split('\n').length))
    const afterSteps = slack - used - (showMore ? 1 : 0)
    const showSession = input.sessionId !== undefined && afterSteps >= sessionNeeds
    const sessionRows = showSession ? sessionNeeds : 0
    const showEmpty = input.steps.length === 0 && afterSteps - sessionRows >= 1
    const emptyRows = showEmpty ? 1 : 0
    return { gaps, sectionRows, visible, hidden, showMore, showSession, showEmpty, used, sessionRows, emptyRows, slack }
  }
  const wanted = [...(input.sections ?? [])].filter((section) => section.full > 0)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let best: ReturnType<typeof budget>
  let bestShown: Array<{ id: string; compact: boolean }> = []
  let bestRows = -1
  const walk = (i: number, shown: Array<{ id: string; compact: boolean }>, sectionRows: number): void => {
    if (i === wanted.length) {
      const plan = budget(shown.length, sectionRows)
      if (plan === undefined) return
      if (best === undefined || plan.visible > best.visible
        || (plan.visible === best.visible && sectionRows > bestRows)) {
        best = plan
        bestShown = [...shown]
        bestRows = sectionRows
      }
      return
    }
    const section = wanted[i]!
    const compact = Math.max(0, Math.min(section.compact, section.full))
    walk(i + 1, shown, sectionRows)
    if (compact > 0 && compact < section.full) {
      shown.push({ id: section.id, compact: true })
      walk(i + 1, shown, sectionRows + compact)
      shown.pop()
    }
    shown.push({ id: section.id, compact: false })
    walk(i + 1, shown, sectionRows + section.full)
    shown.pop()
  }
  walk(0, [], 0)
  const plan = best ?? {
    gaps: 4, sectionRows: 0, visible: 0, hidden: input.steps.length, showMore: false,
    showSession: false, showEmpty: false, used: 0, sessionRows: 0, emptyRows: 0, slack: -1,
  }
  return {
    visible: plan.visible,
    hidden: plan.hidden,
    showMore: plan.showMore,
    showSession: plan.showSession,
    showEmpty: plan.showEmpty,
    shownSections: bestShown,
    rows: plan.gaps + heading + plan.sectionRows + plan.sessionRows + plan.used
      + (plan.showMore ? 1 : 0) + plan.emptyRows + footer,
    capacity: inner,
  }
}

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

  test('the package exports, build entry and patch row all name the plugin', async () => {
    const pkg = JSON.parse(read(join(APP, 'package.json'))) as { exports: Record<string, unknown> }
    expect(pkg.exports['./goal-bar']).toBeDefined()
    // The lib entry points are DERIVED from this manifest (`bundleLibEntryPoints`)
    // rather than hand-listed, so the invariant to pin is the derivation itself:
    // every `./lib/*.js` subpath the exports map exposes must be compiled, because
    // the SEA bundle resolves `@qialike/qialike-app/<subpath>` through that map.
    // The old hand-written list had gone stale (it omitted `./file-reference`,
    // which the patch names, and the compile then failed on the unbuilt import).
    const { bundleLibEntryPoints } = await import('../apps/tui-bin/build.mjs')
    const entries: string[] = bundleLibEntryPoints(APP)
    const libExports = Object.values(pkg.exports)
      .map((target) => (typeof target === 'string' ? target : (target as { default?: string } | null)?.default))
      .filter((out): out is string => typeof out === 'string' && out.startsWith('./lib/') && out.endsWith('.js'))
    expect(libExports).toContain('./lib/goal-bar.js')
    for (const subpath of ['goal-bar.tsx', 'file-reference.tsx']) {
      expect(entries.some((file) => file.endsWith(join('src', subpath)))).toBe(true)
    }
    // One entry per exported `./lib/*.js` — no more (an extra source would not be
    // reachable) and no fewer (a missing one is the unresolvable-import bug).
    expect(entries).toHaveLength(libExports.length)
    const patch = read(join(APP, 'cordis.patch.yml'))
    expect(patch).toContain('tui-goal-bar')
    expect(patch).toContain("'@qialike/qialike-app/goal-bar'")
  })
})
