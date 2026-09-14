/**
 * Inside a dialog LIST, the mouse acts ONLY inside that list's box.
 *
 * Before this, the list geometry recorded rows but not columns, so a hover
 * anywhere on the box's row range highlighted a row, a wheel tick scrolled the
 * list from anywhere, and — worst — `store.mouseRelease(...) === 'click'` was
 * true for a click on the TRANSCRIPT BEHIND the dialog, which the dialogs read as
 * "Enter": a click on the background applied a colorscheme, and in `/sessions` it
 * resumed a session. The user asked for the mouse to be confined to the dialog.
 *
 * Two halves: the geometry helper (column-aware containment) and the wiring — one
 * central gate for hover/wheel, one containment check per dialog for the click.
 *
 * The gate must NOT cover every non-conversation panel: `approval` and `question`
 * are dialogs too, but they route the pointer themselves (hover highlight, wheel
 * → transcript) and register no list box. An unconditional gate killed exactly
 * that, so the scope lives in `outsideOpenDialogList` and is tested here.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dialogListContains,
  dialogListIndexFromRow,
  outsideOpenDialogList,
  setDialogListGeometry,
} from '../packages/dsh-tui-app/src/list-geometry.ts'

const APP = join(import.meta.dir, '..', 'packages', 'dsh-tui-app', 'src')
const read = (file: string): string => readFileSync(join(APP, file), 'utf8')

describe('a dialog owns the mouse only inside its list box', () => {
  test('① containment is a BOX: row range AND column range', () => {
    // Box: rows 6..9 (topRow 5, 4 rows of height 1), columns 21..50 (left 20, width 30).
    setDialogListGeometry({ topRow: 5, rowHeight: 1, count: 4, left: 20, width: 30 })
    // Inside, corners included.
    expect(dialogListContains(6, 21)).toBe(true)
    expect(dialogListContains(9, 50)).toBe(true)
    expect(dialogListIndexFromRow(6, 21)).toBe(0)
    expect(dialogListIndexFromRow(9, 50)).toBe(3)
    // One column to the LEFT of the box is not inside it — this is the click that
    // used to confirm the dialog.
    expect(dialogListContains(6, 20)).toBe(false)
    expect(dialogListIndexFromRow(6, 20)).toBe(-1)
    // …and one column to the right.
    expect(dialogListContains(6, 51)).toBe(false)
    // Rows outside the box (above and below) stay outside, as before.
    expect(dialogListContains(5, 30)).toBe(false)
    expect(dialogListContains(10, 30)).toBe(false)
    expect(dialogListIndexFromRow(5, 30)).toBe(-1)
  })

  test('② no registered box means no point is inside one', () => {
    // A dialog without a list (the API-key input, /help, /export) registers
    // nothing, so every point is outside — and the list geometry is cleared on
    // unmount so a stale box cannot outlive its list.
    setDialogListGeometry(null)
    expect(dialogListContains(6, 21)).toBe(false)
    expect(dialogListIndexFromRow(6, 21)).toBe(-1)
  })

  test('③ the app never maps a mouse row without its column', () => {
    for (const file of ['theme-picker.tsx', 'sessions.tsx', 'panels/models.tsx']) {
      const text = read(file)
      // A single-argument call (`dialogListIndexFromRow(row)`) is the exact bug.
      expect(text, `${file} must pass the column`).not.toMatch(/dialogListIndexFromRow\(\s*[^,()]+\s*\)/u)
      expect(text).toContain('dialogListIndexFromRow(k.mouse')
      expect(text).toContain('dialogListContains(k.mouseRelease.row, k.mouseRelease.col)')
    }
  })

  test('④ the gate is scoped to a REGISTERED list box, never to every panel', () => {
    // With no box: approval / question / plan-review / the models API-key input
    // keep their own pointer handling (this is the bug an unconditional gate
    // introduced — approval hover and wheel-over-message-column went dead).
    setDialogListGeometry(null)
    for (const panel of ['approval', 'question', 'models', 'theme', 'sessions', 'help', 'export']) {
      expect(outsideOpenDialogList(panel, { row: 6, col: 21 }), panel).toBe(false)
      expect(outsideOpenDialogList(panel, undefined), panel).toBe(false)
    }
    // With a box: outside is swallowed for every panel, inside is not.
    setDialogListGeometry({ topRow: 5, rowHeight: 1, count: 4, left: 20, width: 30 })
    expect(outsideOpenDialogList('theme', { row: 6, col: 2 })).toBe(true)
    expect(outsideOpenDialogList('sessions', { row: 6, col: 2 })).toBe(true)
    expect(outsideOpenDialogList('models', { row: 6, col: 21 })).toBe(false)
    expect(outsideOpenDialogList('theme', { row: 5, col: 30 })).toBe(true)
    // The conversation surface is never gated: its right-click/compaction escape
    // hatch and transcript wheel must keep working.
    expect(outsideOpenDialogList('conversation', { row: 6, col: 2 })).toBe(false)
  })

  test('⑤ the panels without a list box still handle hover and wheel', () => {
    // Behavioural half of ④: the handlers themselves were never touched.
    const approval = read('panels/approval.tsx')
    expect(approval).toContain('dialogRowIndexFromCol(k.mouseMove.row, k.mouseMove.col)')
    expect(approval).toContain('store.scrollLines(-WHEEL_STEP)')
    const question = read('panels/question.tsx')
    expect(question).toContain('store.scrollLines(-WHEEL_STEP)')
    expect(question).toContain('const owner = optionFromRow(k.mouseMove.row)')
  })

  test('⑥ handleKey calls the gate once, before the panel dispatch', () => {
    const index = read('index.tsx')
    const gate = index.indexOf('outsideOpenDialogList(store.panel, k.mouseMove ?? k.wheelUp ?? k.wheelDown)')
    expect(gate).toBeGreaterThan(0)
    // …before the panel dispatch, and after the right-click gate.
    expect(index.indexOf('def?.handleKey?.(k, store)')).toBeGreaterThan(gate)
    expect(index.indexOf("if (store.panel !== 'conversation' && k.mouseRightPress !== undefined) return")).toBeLessThan(gate)
    // The click half must call store.mouseRelease FIRST (it finalizes the
    // transcript selection) and only then decide.
    for (const file of ['theme-picker.tsx', 'sessions.tsx', 'panels/models.tsx']) {
      const text = read(file)
      const release = text.indexOf('store.mouseRelease(')
      const contains = text.indexOf('dialogListContains(k.mouseRelease.row, k.mouseRelease.col)')
      expect(release, `${file} calls store.mouseRelease`).toBeGreaterThan(0)
      expect(contains, `${file} gates the click`).toBeGreaterThan(release)
    }
  })

  test('⑦ the registration is dropped when the list unmounts', () => {
    expect(read('list-geometry.ts')).toContain('return () => setDialogListGeometry(null)')
  })
})
