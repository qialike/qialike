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
function measureDomTop(el: DOMElement | null): number {
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
