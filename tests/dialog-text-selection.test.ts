/**
 * A dialog's TEXT is mouse-selectable: drag to highlight, release to copy.
 *
 * The reported gap: with a question card / a picker (`/models`, `/theme`,
 * `/sessions`) / the approval dock / the command palette / the `@file` popup
 * open, a drag selected nothing at all. Every dialog consumed the press without
 * anchoring a selection, no dialog handled `mouseDrag`, and the frame
 * controller's only guard was the conversation panel's — clamped to the
 * transcript's message column, so even an anchored selection would have
 * highlighted the wrong band.
 *
 * The copy must come from the FRAME BUFFER (`__dshFrameController.copiedText`):
 * a dialog is painted OVER the transcript, so the model-side fallback
 * (`selectionText`) would copy the text BEHIND the dialog. That is the failure
 * mode this module pins down.
 *
 * Three layers: the pure clamp (band → rect/endpoints), the registration slot
 * (owner-scoped, so a parent overlay cannot wipe a child's box), and the wiring
 * (every dialog publishes a box and routes press/drag/release).
 *
 * Run with `bun test tests/dialog-text-selection.test.ts`.
 *
 * @module qialike/dialog-text-selection-test
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  clampSelectionToDialogBand,
  dialogTextBand,
  dialogTextBoxContains,
  setDialogTextBox,
} from '../packages/qialike-app/src/list-geometry.ts'
import { copySelection, isDragSelection } from '../packages/qialike-app/src/text-selection.ts'
import type { Store } from '../packages/qialike-app/src/index.tsx'

const APP = join(import.meta.dir, '..', 'packages', 'qialike-app', 'src')
const read = (file: string): string => readFileSync(join(APP, file), 'utf8')
const read2 = (rel: string): string => readFileSync(join(import.meta.dir, rel), 'utf8')

/** The grid band used throughout: 0-based rows 5..9, columns 21..70. */
const band = { left: 21, right: 70, top: 5, bottom: 9 }

// The slot is owner-scoped, so a test that leaves a box registered under one
// owner must be cleaned per owner (that is the property under test).
const OWNERS = ['test', 'question', 'palette', 'models', 'approval', 'file-reference']
afterEach(() => { for (const owner of OWNERS) setDialogTextBox(owner, null) })

describe('clampSelectionToDialogBand: the drag is pulled back to the dialog', () => {
  test('a drag fully inside keeps its endpoints and reports the band', () => {
    // Rows 7..8 (1-based) → grid 6..7; cols 30..40 → grid 29..39.
    const r = clampSelectionToDialogBand({ aRow: 7, aCol: 30, cRow: 8, cCol: 40 }, band)
    expect(r.rect).toEqual({ x1: 21, y1: 6, x2: 70, y2: 7 })
    expect(r.left).toBe(21)
    expect(r.right).toBe(70)
    expect(r.anchor).toEqual({ row: 7, col: 30 })
    expect(r.focus).toEqual({ row: 8, col: 40 })
  })

  test('a drag that leaves the box is clamped — the transcript below is never swept in', () => {
    // Started on the dialog's first line, dragged 30 rows below it.
    const r = clampSelectionToDialogBand({ aRow: 6, aCol: 25, cRow: 36, cCol: 25 }, band)
    expect(r.rect.y1).toBe(5)
    expect(r.rect.y2).toBe(9)          // the band's bottom, NOT row 35
    expect(r.focus.row).toBe(10)       // 1-based last band row
    expect(r.anchor.row).toBe(6)
  })

  test('columns clamp per endpoint, so a sideways-overflowing drag keeps direction', () => {
    const r = clampSelectionToDialogBand({ aRow: 6, aCol: 2, cRow: 8, cCol: 200 }, band)
    expect(r.anchor.col).toBe(22)      // pulled right, up to the band's first column
    expect(r.focus.col).toBe(71)       // pulled left, down to the band's last column
  })

  test('an upward drag (focus before anchor) is normalized for the rect, not for the endpoints', () => {
    const r = clampSelectionToDialogBand({ aRow: 9, aCol: 60, cRow: 6, cCol: 30 }, band)
    expect(r.rect.y1).toBe(5)
    expect(r.rect.y2).toBe(8)
    expect(r.anchor).toEqual({ row: 9, col: 60 })
    expect(r.focus).toEqual({ row: 6, col: 30 })
  })
})

describe('the dialog text box slot is owner-scoped', () => {
  const box = { top: 5, left: 21, width: 50, height: 5 }

  test('a non-owner withdraw cannot wipe a live registration', () => {
    // The palette effect runs AFTER its child overlays (React effect order), so a
    // child's question dock must survive the parent's "I am not open" pass.
    setDialogTextBox('question', box)
    setDialogTextBox('palette', null)
    expect(dialogTextBand()).toEqual({ left: 21, right: 70, top: 5, bottom: 9 })
  })

  test('the owner withdraws its own box', () => {
    setDialogTextBox('question', box)
    setDialogTextBox('question', null)
    expect(dialogTextBand()).toBeNull()
    expect(dialogTextBoxContains(6, 22)).toBe(false)
  })

  test('a degenerate measurement is not a band', () => {
    setDialogTextBox('models', { top: 5, left: 21, width: 0, height: 5 })
    expect(dialogTextBand()).toBeNull()
    setDialogTextBox('models', { top: 5, left: 21, width: 50, height: 0 })
    expect(dialogTextBand()).toBeNull()
  })

  test('containment is the box: corners in, one cell out on every side', () => {
    setDialogTextBox('models', box)
    expect(dialogTextBoxContains(6, 22)).toBe(true)    // top-left (1-based)
    expect(dialogTextBoxContains(10, 71)).toBe(true)   // bottom-right
    expect(dialogTextBoxContains(5, 22)).toBe(false)   // one row above
    expect(dialogTextBoxContains(11, 22)).toBe(false)  // one row below
    expect(dialogTextBoxContains(6, 21)).toBe(false)   // one column left
    expect(dialogTextBoxContains(6, 72)).toBe(false)   // one column right
  })
})

describe('copySelection takes the dialog text from the frame buffer', () => {
  const store = (sel: Store['selection']): { store: Store; flashes: string[] } => {
    const flashes: string[] = []
    const s = {
      selection: sel,
      flashStatus: (text: string) => { flashes.push(text) },
    }
    return { store: s as unknown as Store, flashes }
  }
  const frame = (text: string | undefined): void => {
    ;(globalThis as unknown as { __dshFrameController?: { copiedText?: string } }).__dshFrameController
      = text === undefined ? undefined : { copiedText: text }
  }

  test('the Manhattan threshold matches the frame controller (a click never copies)', () => {
    expect(isDragSelection(store({ aRow: 6, aCol: 22, cRow: 6, cCol: 24 }).store)).toBe(false)
    expect(isDragSelection(store({ aRow: 6, aCol: 22, cRow: 6, cCol: 25 }).store)).toBe(true)
    expect(isDragSelection(store(null).store)).toBe(false)
  })

  test('a dialog drag copies the frame text and flashes the usual status line', () => {
    frame('Would you like to apply this?')
    const { store: s, flashes } = store({ aRow: 6, aCol: 22, cRow: 8, cCol: 40 })
    expect(copySelection(s)).toBe('Would you like to apply this?')
    expect(flashes).toHaveLength(1)
    expect(flashes[0]).toContain('Copied: Would you like to apply this?')
  })

  test('no fallback is used for a dialog: an empty frame text copies NOTHING', () => {
    // This is the regression that matters. With a dialog up (its band
    // registered) but no frame text — e.g. the drag never covered dialog cells —
    // a fallback would write the transcript hidden BEHIND the dialog.
    setDialogTextBox('models', { top: 5, left: 21, width: 50, height: 5 })
    frame('')
    const { store: s, flashes } = store({ aRow: 6, aCol: 22, cRow: 8, cCol: 40 })
    expect(copySelection(s)).toBe('')
    expect(copySelection(s, () => 'transcript text behind the dialog')).toBe('')
    expect(flashes).toHaveLength(0)
  })

  test('the conversation surface still gets its model fallback', () => {
    frame('')
    const { store: s } = store({ aRow: 6, aCol: 22, cRow: 8, cCol: 40 })
    expect(copySelection(s, () => 'transcript text')).toBe('transcript text')
  })

  test('a click (no drag) copies nothing even with frame text present', () => {
    frame('something')
    const { store: s, flashes } = store({ aRow: 6, aCol: 22, cRow: 6, cCol: 23 })
    expect(copySelection(s)).toBe('')
    expect(flashes).toHaveLength(0)
  })
})

describe('the frame copy keeps cells that are ALREADY inverse', () => {
  // A dialog's selected row, a hovered tool row and the palette's highlighted
  // command are painted with `inverse`. The copy used to skip any cell carrying
  // that style (the anti-double-highlight guard doubled as a copy filter), so a
  // drag across one of those rows silently produced NOTHING for it — measured on
  // the palette (every command row is highlighted) and on `/models` (the
  // selected row). TEXT and HIGHLIGHT have to be decided separately.
  const patch = read2('../apps/tui-bin/build.mjs')

  test('the guard drops only empty/decoration cells — never the styles', () => {
    const m = /const __invAppend = \(cell, line\) => \{([^}]*)\}/.exec(patch)
    expect(m).not.toBeNull()
    const guard = m![1].slice(0, m![1].indexOf('return;'))
    expect(guard).not.toContain('cell.styles')
    expect(guard).toContain("cell.value === ''")
    expect(guard).toContain('__deco.test')
  })

  test('the text is appended before the highlight is considered', () => {
    const m = /const __invAppend = \(cell, line\) => \{([^}]*)\}/.exec(patch)
    const body = m![1]
    expect(body.indexOf('line.v += cell.value')).toBeGreaterThan(-1)
    expect(body.indexOf('line.v += cell.value')).toBeLessThan(body.indexOf('cell.styles.some'))
  })

  test('the rectangle fallback keeps them too', () => {
    const m = /const __rect = \(\) => \{ const inv = \(cell\) => \{([^}]*)\}/.exec(patch)
    expect(m).not.toBeNull()
    const guard = m![1].slice(0, m![1].indexOf('return;'))
    expect(guard).not.toContain('cell.styles')
  })
})

describe('every dialog publishes a text box and routes the mouse gesture', () => {
  // Only the OVERLAY surfaces. The fullscreen pickers (/models, /theme,
  // /sessions) deliberately do NOT support drag-select copy (user call,
  // 2026-09-23): they are opaque full-screen panels with no text behind them,
  // and a drag there would fight the row-selection model. Their click/hover
  // behavior is untouched.
  const dialogs = [
    ['panels/approval.tsx', 'approval'],
    ['panels/question.tsx', 'question'],
    ['file-reference.tsx', 'file-reference'],
  ] as const

  test.each(dialogs)('%s registers its own text box and wires press/drag/release', (file, owner) => {
    const src = read(file)
    expect(src).toContain(`useDialogTextBox('${owner}', `)
    expect(src).toContain('dialogTextBoxContains(')
    expect(src).toContain('store.mouseDrag(')
    expect(src).toContain('store.mouseRelease(')
    expect(src).toContain('copySelection(store)')
  })

  test('no overlay swallows the press without anchoring any more', () => {
    for (const [file] of dialogs) {
      const src = read(file)
      expect(src.includes('if (k.mousePress) return true')).toBe(false)
      expect(src.includes('if (k.mousePress) return\n')).toBe(false)
    }
  })

  test('the fullscreen pickers keep their own press handling (no selection there)', () => {
    for (const file of ['panels/models.tsx', 'theme-picker.tsx', 'sessions.tsx']) {
      const src = read(file)
      expect(src.includes('useDialogTextBox')).toBe(false)
      expect(src.includes('copySelection')).toBe(false)
      expect(src.includes('mouseDrag')).toBe(false)
    }
  })

  test('the palette is wired too, and it anchors before moving the highlight', () => {
    const src = read('panels/conversation.tsx')
    expect(src).toContain("setDialogTextBox('palette', {")
    expect(src).toContain('clampSelectionToDialogBand(sel, dialog)')
    // The press must anchor FIRST; the old code returned after moving the index.
    const press = src.slice(src.indexOf('  if (k.mousePress) {'), src.indexOf('  if (k.mouseMove) {'))
    expect(press.indexOf('store.mousePress(')).toBeLessThan(press.indexOf('store.setCommandIndex(idx)'))
    expect(press.includes('store.setCommandIndex(idx); return')).toBe(false)
  })
})
