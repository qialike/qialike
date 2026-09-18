/** Shared geometry of the open list dialog, so mouse HOVER can highlight the row
 *  under the cursor — and so a mouse event OUTSIDE the dialog can be ignored.
 *
 *  The dialog render registers the list Box's box (`topRow`, `rowHeight`,
 *  `count`, and now `left`/`width`) on a ref; panels map a mouse point to an
 *  index via `dialogListIndexFromRow(row, col)` and gate click / wheel on
 *  `dialogListContains(row, col)`. Columns matter: without them a hover or a
 *  click anywhere on the screen's row range acted on the dialog (a left-click on
 *  the transcript background used to "confirm" the highlighted row). */
import type { RefObject } from 'react'
import { useEffect } from 'react'
import type { DOMElement } from 'ink'

export interface DialogListGeometry {
  readonly topRow: number
  readonly rowHeight: number
  readonly count: number
  /** 0-based Yoga column of the list box's left edge. */
  readonly left: number
  /** The list box's width in columns. */
  readonly width: number
}
type GeoHost = { __dshDialogGeometry?: DialogListGeometry | null }

export function setDialogListGeometry(g: DialogListGeometry | null): void {
  ;(globalThis as unknown as GeoHost).__dshDialogGeometry = g
}
export function dialogListIndexFromRow(row: number, col: number): number {
  if (!dialogListContains(row, col)) return -1
  const g = dialogGeometry()
  if (g === null) return -1
  // row is a 1-based SGR mouse row; topRow is the 0-based Yoga grid row.
  const idx = Math.floor((row - 1 - g.topRow) / g.rowHeight)
  return idx >= 0 && idx < g.count ? idx : -1
}

/** The registered list box, or null when no dialog list is rendered. */
function dialogGeometry(): DialogListGeometry | null {
  const g = (globalThis as unknown as GeoHost).__dshDialogGeometry
  if (!g || g.count === 0 || g.rowHeight <= 0 || g.width <= 0) return null
  return g
}

/**
 * Whether a 1-based SGR mouse point is inside the open dialog's list box —
 * the ONLY place a mouse event may act while a dialog is up.
 * @param row - 1-based SGR row.
 * @param col - 1-based SGR column.
 * @returns true when the point is inside the list box.
 */
export function dialogListContains(row: number, col: number): boolean {
  const g = dialogGeometry()
  if (g === null) return false
  const y = row - 1 - g.topRow
  if (y < 0 || y >= g.count * g.rowHeight) return false
  const x = col - 1 - g.left
  return x >= 0 && x < g.width
}
/** Whether a dialog LIST box is registered right now. */
export function dialogListGeometryRegistered(): boolean {
  return dialogGeometry() !== null
}

/**
 * Whether `handleKey` must swallow a pointer event because a dialog list is open
 * and the point is outside it.
 *
 * Only the LIST dialogs (`/theme`, `/sessions`, `/models`) register a box. The
 * other panels are dialogs too, but they route the pointer themselves and must
 * keep doing so: `approval` highlights the option under the cursor
 * (`approval.tsx` `mouseMove` → `dialogRowIndexFromCol`) and forwards a wheel
 * over the message column to the transcript (`store.scrollLines`); `question`
 * does the same for its option rows and the plan-review box. Gating them on a
 * list box that does not exist would silently kill all of that — which is what
 * an unconditional gate did (caught by re-reading those panels, 2026-09-14).
 * @param panel - `store.panel`.
 * @param at - the event's point, or undefined when it carries none.
 * @returns true when the event must be consumed without reaching the panel.
 */
export function outsideOpenDialogList(
  panel: string,
  at: { readonly row: number; readonly col: number } | undefined,
): boolean {
  if (panel === 'conversation' || at === undefined) return false
  if (!dialogListGeometryRegistered()) return false
  return !dialogListContains(at.row, at.col)
}

export function measureDomTop(el: DOMElement | null): number {
  let top = 0
  let cur: DOMElement | null | undefined = el
  while (cur) {
    if (cur.yogaNode) top += cur.yogaNode.getComputedTop() ?? 0
    cur = cur.parentNode as DOMElement | null | undefined
  }
  return top
}
export function useListGeometry(ref: RefObject<DOMElement>, count: number, rowHeight = 1, deps: readonly unknown[] = []): void {
  useEffect(() => {
    if (!ref.current) return
    setDialogListGeometry({
      topRow: Math.round(measureDomTop(ref.current)),
      rowHeight,
      count,
      left: Math.round(measureDomLeft(ref.current)),
      width: Math.round(ref.current.yogaNode?.getComputedWidth() ?? 0),
    })
    // …and forget it on unmount: a sub-dialog (the models API-key dialog) renders
    // NO list, and stale geometry would let a mouse point pass the containment
    // gate for a box that is not on screen any more.
    return () => setDialogListGeometry(null)
  }, [count, rowHeight, ...deps])
}

/** Geometry of one horizontal options row (the approval dock's Deny / Allow
 *  always / Allow once). Records the row's absolute top row + left edge and
 *  each option's rendered width so mouse HOVER can map a (row, col) to an
 *  option index — the row must be the options row itself, never a title /
 *  reason / hint row that happens to share a column. */
export interface DialogRowGeometry {
  readonly topRow: number
  readonly left: number
  readonly widths: readonly number[]
}
type RowHost = { __dshDialogRowGeometry?: DialogRowGeometry | null }

export function setDialogRowGeometry(g: DialogRowGeometry | null): void {
  ;(globalThis as unknown as RowHost).__dshDialogRowGeometry = g
}
export function dialogRowIndexFromCol(row: number, col: number): number {
  const g = (globalThis as unknown as RowHost).__dshDialogRowGeometry
  if (!g || g.widths.length === 0) return -1
  // topRow is the 0-based Yoga grid row of the options row; a 1-based SGR row
  // is on that row only when row − 1 === topRow (mirrors dialogListIndexFromRow).
  if (row - 1 !== g.topRow) return -1
  // col is a 1-based SGR mouse column; the row's left is a 0-based Yoga x.
  const x = col - 1 - g.left
  if (x < 0) return -1
  let acc = 0
  for (let i = 0; i < g.widths.length; i++) {
    const w = g.widths[i] ?? 0
    if (x >= acc && x < acc + w) return i
    acc += w + 2 // gap between options
  }
  return -1
}
export function measureDomLeft(el: DOMElement | null): number {
  let left = 0
  let cur: DOMElement | null | undefined = el
  while (cur) {
    if (cur.yogaNode) left += cur.yogaNode.getComputedLeft() ?? 0
    cur = cur.parentNode as DOMElement | null | undefined
  }
  return left
}
export function useRowGeometry(ref: RefObject<DOMElement>, widths: readonly number[], deps: readonly unknown[] = []): void {
  useEffect(() => {
    if (!ref.current) return
    setDialogRowGeometry({
      topRow: Math.round(measureDomTop(ref.current)),
      left: Math.round(measureDomLeft(ref.current)),
      widths,
    })
  }, [widths, ...deps])
}
