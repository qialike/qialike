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
import { useEffect, useRef } from 'react'
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

/**
 * Geometry of the open dialog's TEXT AREA — the Box that directly wraps the
 * dialog's text rows, i.e. already INSIDE the dialog's border and padding.
 *
 * Registered by every dialog so a mouse drag inside it can highlight and copy
 * the dialog's own text (`text-selection.ts`). The conversation panel's frame
 * guard turns this into the content column band the frame controller walks:
 * measuring the inner Box (instead of the bordered outer one) is what keeps
 * `contentLeft`/`contentRight` free of border/padding constants that could
 * drift away from the JSX.
 */
export interface DialogTextBox {
  /** 0-based Yoga grid row of the first text row. */
  readonly top: number
  /** 0-based grid column of the text area's left edge. */
  readonly left: number
  readonly width: number
  readonly height: number
}
type RegisteredTextBox = DialogTextBox & { readonly owner: string }
type TextBoxHost = { __dshDialogTextBox?: RegisteredTextBox | null }

/**
 * Publish (`b`) or withdraw (`null`) one surface's text area.
 *
 * The slot is global because the conversation panel's frame guard is the single
 * reader, but several surfaces can be mounted at once — the palette and the
 * `@file` popup live INSIDE the conversation surface, and React runs a child's
 * effects before its parent's. Without the `owner` check the parent's
 * "I am not open" cleanup would wipe a child's live registration (and vice
 * versa). An owner may only ever clear its own box.
 *
 * @param owner - stable id of the publishing surface (`'palette'`, `'models'`, …).
 * @param b - the measured text area, or null to withdraw this owner's box.
 */
export function setDialogTextBox(owner: string, b: DialogTextBox | null): void {
  const host = globalThis as unknown as TextBoxHost
  if (b === null) {
    if (host.__dshDialogTextBox?.owner === owner) host.__dshDialogTextBox = null
    return
  }
  host.__dshDialogTextBox = { ...b, owner }
}

/** The registered text area, or null when no dialog publishes one (or the box
 *  is degenerate — a zero-width/height measurement must not become a band). */
export function dialogTextBox(): DialogTextBox | null {
  const b = (globalThis as unknown as TextBoxHost).__dshDialogTextBox
  if (!b || b.width <= 0 || b.height <= 0) return null
  return b
}

/** The dialog text area as an INCLUSIVE grid band (0-based rows/cols), or null
 *  when no dialog publishes one. This is what the frame guard clamps a dialog
 *  selection to. */
export function dialogTextBand(): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } | null {
  const b = dialogTextBox()
  if (b === null) return null
  return { left: b.left, right: b.left + b.width - 1, top: b.top, bottom: b.top + b.height - 1 }
}

/** Whether a 1-based SGR mouse point is inside the open dialog's text area —
 *  the ONLY place a press may ANCHOR a dialog selection. A press outside keeps
 *  the old consume-without-anchor behavior (the click half of a dialog gesture
 *  is gated per dialog, see `dialogListContains`). */
export function dialogTextBoxContains(row: number, col: number): boolean {
  const band = dialogTextBand()
  if (band === null) return false
  const y = row - 1
  const x = col - 1
  return y >= band.top && y <= band.bottom && x >= band.left && x <= band.right
}

/** Attach the returned ref to the Box that wraps a dialog's text rows; it
 *  registers the measured text area while mounted and clears it on unmount
 *  (and on every dep change — the deps must cover anything that moves/resizes
 *  the dialog, typically `store.rows` / `store.width` plus the dialog's mode). */
export function useDialogTextBox(owner: string, deps: readonly unknown[]): RefObject<DOMElement> {
  const ref = useRef<DOMElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !el.yogaNode) { setDialogTextBox(owner, null); return }
    setDialogTextBox(owner, {
      top: Math.round(measureDomTop(el)),
      left: Math.round(measureDomLeft(el)),
      width: Math.round(el.yogaNode.getComputedWidth() ?? 0),
      height: Math.round(el.yogaNode.getComputedHeight() ?? 0),
    })
    return () => setDialogTextBox(owner, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measured per dialog state change
  }, deps)
  return ref
}

/** A raw mouse selection, in 1-based SGR cells. */
export interface SelectionEndpoints {
  readonly aRow: number
  readonly aCol: number
  readonly cRow: number
  readonly cCol: number
}
/** What the frame controller needs to highlight and walk a dialog selection:
 *  the grid rect, the content column band, and the CLAMPED 1-based endpoints. */
export interface DialogSelection {
  readonly rect: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
  readonly left: number
  readonly right: number
  readonly anchor: { readonly row: number; readonly col: number }
  readonly focus: { readonly row: number; readonly col: number }
}

/**
 * Clamp a mouse selection onto a dialog's text band.
 *
 * The frame controller walks from `anchor` to `focus` over the composited cell
 * grid, so an unclamped gesture would sweep in whatever is painted beside and
 * below the dialog — the transcript behind it. Both the row range AND each
 * endpoint are pulled back to the band; endpoints are clamped INDIVIDUALLY so a
 * drag that leaves the box keeps its direction instead of collapsing.
 *
 * Pure (the band is passed in) so the mapping is unit-testable without a
 * terminal or a React tree.
 */
export function clampSelectionToDialogBand(
  sel: SelectionEndpoints,
  band: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number },
): DialogSelection {
  const row0 = (v: number): number => Math.max(band.top, Math.min(v - 1, band.bottom))
  const col0 = (v: number): number => Math.max(band.left, Math.min(v - 1, band.right))
  const ar = row0(sel.aRow)
  const cr = row0(sel.cRow)
  return {
    rect: { x1: band.left, y1: Math.min(ar, cr), x2: band.right, y2: Math.max(ar, cr) },
    left: band.left,
    right: band.right,
    anchor: { row: ar + 1, col: col0(sel.aCol) + 1 },
    focus: { row: cr + 1, col: col0(sel.cCol) + 1 },
  }
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
