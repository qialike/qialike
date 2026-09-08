/**
 * Shared pointer-region routing for the IN-FLOW docks (approval / question).
 *
 * While either dock is open, its panel's `handleKey` owns every key (the
 * surface dispatches to `store.panel`), so the FIRST thing a mouse/wheel event
 * must do is decide where the pointer sits — on the dock, on the composer
 * strip below it, on the message column around both, or outside the message
 * column (Steps sidebar) — and route accordingly. Both docks live IN-FLOW in
 * the message column (right under the transcript, above the composer), so they
 * share one router:
 *
 *   - `dock` rows      → wheel inert; mouse drives the dock only (buttons /
 *                        options). Before the dock's DOM measurement lands,
 *                        every non-composer cell is conservatively `dock`.
 *   - `composer` rows  → the composer box at the very bottom of the message
 *                        column. Never overlaps the dock (in-flow siblings)
 *                        and its geometry is deterministic, so it is
 *                        classified even before the dock measurement lands —
 *                        the strip keeps its normal surface behaviour (wheel
 *                        scrolls the transcript, clicks edit the draft).
 *   - `message` rows   → the message column outside dock & composer: wheel
 *                        scrolls the transcript, press/drag/release select &
 *                        copy, exactly as on the normal surface.
 *   - `none`           → outside the message column (Steps sidebar…): ignore.
 *
 * The message/composer rows are forwarded to the conversation panel's own
 * key handler (single source of truth — no duplicated selection/copy logic in
 * either dock panel). Pure module: no store, no mutable state, so importing it
 * from several panel bundles can never create a second module copy hazard.
 *
 * @module @yourname/dsh-tui-app/pointer-region
 */

import wrapAnsi from 'wrap-ansi'
import { SIDEBAR_MIN_WIDTH } from './config.ts'

/** One pointer cell's region while an in-flow dock is open. */
export type PointerRegion = 'dock' | 'composer' | 'message' | 'none'

/** Where a pointer cell (1-based SGR row/col) sits relative to an IN-FLOW dock
 *  whose measured row span is `dockSpan` (see {@link PointerRegion} for the
 *  semantics of each region). `composerSpan` is the composer box's row span at
 *  the bottom of the message column (composerStripRows), `messageRight` its
 *  rightmost column. Pure; unit-tested. */
export function pointerRegion(
  ptrRow: number,
  ptrCol: number,
  dockSpan: { top: number; height: number } | null,
  messageRight: number,
  composerSpan: { top: number; height: number } | null,
): PointerRegion {
  if (ptrCol > messageRight) return 'none'
  // A MEASURED dock always wins over the composer strip: both are in-flow
  // siblings (dock above, composer below), so they never overlap in normal
  // layout — but if the dock ever painted over the strip (overflow), its
  // buttons must stay authoritative.
  if (dockSpan !== null && ptrRow >= dockSpan.top && ptrRow < dockSpan.top + dockSpan.height) return 'dock'
  // The composer strip is at the bottom of the message column and can never be
  // a dock row (in-flow siblings), so classify it BEFORE the dock's
  // measurement rule: even on the very first frame the strip keeps its normal
  // surface behaviour (wheel scrolls the transcript, clicks edit the draft).
  if (composerSpan !== null && ptrRow >= composerSpan.top && ptrRow < composerSpan.top + composerSpan.height) return 'composer'
  // Before the dock's measurement lands (very first frame) treat every other
  // cell as dock territory: the wheel stays inert and buttons only drive the
  // dock — never risk selecting/acting on the message behind an unmeasured
  // dock.
  if (dockSpan === null) return 'dock'
  return 'message'
}

/** 1-based SCREEN-ROW span of the composer's whole bordered box (rows
 *  [composerTopBorder .. composerBottomBorder]), as conversation.tsx lays it
 *  out at the bottom of the message column while a dock is open. Mirrors the
 *  conversation panel's composer math (composerHeight/composerUsable +
 *  STATUS_BAR_HEIGHT + the image chip's extra row) so pointer routing can never
 *  disagree with what is actually rendered below the dock. Deterministic —
 *  needs no DOM measurement. Pure; unit-tested.
 * @param width - terminal columns (store.width).
 * @param rows - terminal rows (store.rows).
 * @param input - the composer draft (store.input).
 * @param hasImage - a composer image chip is attached (adds one box row).
 * @param messageRight - the message column's rightmost column (1-based,
 *  inclusive), which the composer spans. */
export function composerStripRows(
  width: number,
  rows: number,
  input: string,
  hasImage: boolean,
  messageRight: number,
): { top: number; height: number } | null {
  if (rows <= 0 || width <= 0 || messageRight <= 0) return null
  // Mirrors conversation.tsx composerUsable/composerOuterWidth (the composer
  // spans the whole message column).
  const usable = Math.max(10, messageRight - 4)
  const min = 5 // COMPOSER_MIN_HEIGHT
  const statusH = 3 // STATUS_BAR_HEIGHT (composer bottom sits above the status bar)
  // Mirrors conversation.tsx composerHeight: rows of the wrapped draft at the
  // usable width, then min(min + wrapped − 1, cap). The height cap is tied to
  // the TERMINAL HEIGHT — cap = max(min, rows − 8); the box's text window is
  // composerH − 4, so the max VISIBLE text rows scale with the screen
  // (rows − 12 on normal terminals). Beyond it the draft scrolls inside a
  // caret-following window — exactly the formula the conversation render uses.
  const wrapped = input.split('\n').reduce(
    (sum, seg) => sum + (seg === '' ? 1 : wrapAnsi(seg, usable, { trim: false, hard: true }).split('\n').length),
    0,
  )
  const cap = Math.max(min, rows - 8)
  const composerH = Math.min(min + wrapped - 1, cap)
  // The image chip adds one rendered row to the composer box (conversation
  // renders height = composerHeight + (image ? 1 : 0)).
  const height = composerH + (hasImage ? 1 : 0)
  const top = rows - statusH - height + 1
  if (top < 1) return null
  return { top, height }
}

/** The sidebar mode of the message column (mirrors conversation.tsx
 *  sidebarVisibleFor: 'on' = always, 'auto' = width ≥ SIDEBAR_MIN_WIDTH,
 *  'off' = never). */
export type SidebarModeForPointer = 'auto' | 'on' | 'off'

/** Rightmost column (1-based, inclusive) of the MESSAGE column at `width` for
 *  the given `mode` — the whole terminal width minus the Steps sidebar when it
 *  is drawn. Mirrors the conversation's sidebarVisibleFor/sidebarWidthFor so
 *  pointer routing never disagrees with what is actually rendered. */
export function messageRightFor(width: number, mode: SidebarModeForPointer): number {
  const visible = mode === 'on' || (mode === 'auto' && width >= SIDEBAR_MIN_WIDTH)
  return visible ? width - Math.max(20, Math.round(width * 0.3)) : width
}

/** One pointer cell's region on the MAIN conversation surface (no dock open):
 *   - `message` — the message column above the composer (transcript rows): the
 *     wheel scrolls the transcript, clicks/drag select & copy / toggle rows;
 *   - `composer` — the composer box at the bottom of the message column: the
 *     wheel scrolls the draft itself only when it overflows, clicks edit it;
 *   - `sidebar` — the Steps column (when visible): the wheel scrolls its own
 *     list, clicks toggle the title band only — never the transcript behind;
 *   - `status` — the full-width status bar at the very bottom: inert.
 *  Pure; unit-tested. Geometry is passed in (mirrors the conversation render):
 *  `messageRight` = messageRightFor(width, mode), `composerTop/`composerBottom`
 *  = the 1-based first/last row of the composer box, `statusTop` = the 1-based
 *  first row of the status bar (rows − STATUS_BAR_HEIGHT + 1). */
export type SurfaceRegion = 'message' | 'composer' | 'sidebar' | 'status'
export interface SurfaceGeometry {
  readonly messageRight: number
  readonly composerTop: number
  readonly composerBottom: number
  readonly statusTop: number
}
export function surfaceRegion(row: number, col: number, g: SurfaceGeometry): SurfaceRegion {
  // The status bar spans the FULL width at the bottom, under the sidebar.
  if (row >= g.statusTop) return 'status'
  // The sidebar column (only present when messageRight < width); its rows span
  // the whole middle row, so any col beyond the message column is the sidebar.
  if (col > g.messageRight) return 'sidebar'
  // The composer box occupies the bottom rows of the message column.
  if (row >= g.composerTop && row <= g.composerBottom) return 'composer'
  return 'message'
}

/** The Steps sidebar's CONTENT column band in 0-based GRID coordinates (the
 *  frame controller's cell space): the bordered sidebar column starts right
 *  after the message column's last 1-based col (`messageRight`); its text
 *  begins two grid cells in (left border + paddingX) and ends two cells before
 *  the terminal edge (right border + paddingX). The LINE/FLOW selection and
 *  copy (frame controller) are bounded to this band when a drag anchors on the
 *  sidebar, so it never sweeps in message-column text on the same rows.
 *  Mirrors the sidebar render (borderStyle round + paddingX 1). */
export function sidebarContentBand(width: number, messageRight: number): { left: number; right: number } {
  return { left: messageRight + 2, right: width - 3 }
}
