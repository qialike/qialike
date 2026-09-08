/** Shared geometry of the open list dialog, so mouse HOVER can highlight the row
 *  under the cursor. The dialog render registers `{topRow,rowHeight,count}` on a
 *  ref'd list Box; panels map a mouse row to an index via `dialogListIndexFromRow`. */
import type { RefObject } from 'react'
import { useEffect } from 'react'
import type { DOMElement } from 'ink'

export interface DialogListGeometry { readonly topRow: number; readonly rowHeight: number; readonly count: number }
type GeoHost = { __dshDialogGeometry?: DialogListGeometry | null }

export function setDialogListGeometry(g: DialogListGeometry | null): void {
  ;(globalThis as unknown as GeoHost).__dshDialogGeometry = g
}
export function dialogListIndexFromRow(row: number): number {
  const g = (globalThis as unknown as GeoHost).__dshDialogGeometry
  if (!g || g.count === 0 || g.rowHeight <= 0) return -1
  // row is a 1-based SGR mouse row; topRow is the 0-based Yoga grid row.
  const idx = Math.floor((row - 1 - g.topRow) / g.rowHeight)
  return idx >= 0 && idx < g.count ? idx : -1
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
    setDialogListGeometry({ topRow: Math.round(measureDomTop(ref.current)), rowHeight, count })
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
