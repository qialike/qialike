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
  const min = 5 // COMPOSER_MIN_HEIGHT (chrome-inclusive minimum)
  const statusH = 3 // STATUS_BAR_HEIGHT (composer bottom sits above the status bar)
  // Mirrors conversation.tsx composerHeight: rows of the wrapped draft at the
  // usable width, then min(min + wrapped − 1, cap). The card is BORDERLESS but
  // paints two half-row fill edges (▄ above, ▀ below), so this height counts
  // them just like the framed card counted its two border rows. The height cap
  // is tied to the TERMINAL HEIGHT — cap = max(min, rows − 8); the text window
  // is height − 4, so the max VISIBLE text rows scale with the screen. Beyond it
  // the draft scrolls inside a caret-following window — exactly the conversation
  // render's formula.
  const wrapped = input.split('\n').reduce(
    (sum, seg) => sum + (seg === '' ? 1 : wrapAnsi(seg, usable, { trim: false, hard: true }).split('\n').length),
    0,
  )
  const cap = Math.max(min, rows - 8)
  const composerH = Math.min(min + wrapped - 1, cap) // includes the 2 half-row fill edges
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
 *  first row of the status bar (rows − STATUS_BAR_HEIGHT + 1), and the optional
 *  `composerLeft/`composerRight` = the 1-based first/last COLUMN of that box
 *  (the hero centers a NARROWER card, so its column band matters there; both
 *  default to the whole message column, i.e. 1 … `messageRight`). */
export type SurfaceRegion = 'message' | 'composer' | 'sidebar' | 'status'
export interface SurfaceGeometry {
  readonly messageRight: number
  readonly composerTop: number
  readonly composerBottom: number
  readonly statusTop: number
  /** 1-based first column of the composer box (default 1). */
  readonly composerLeft?: number
  /** 1-based last column of the composer box (default `messageRight`). */
  readonly composerRight?: number
}
export function surfaceRegion(row: number, col: number, g: SurfaceGeometry): SurfaceRegion {
  // The status bar spans the FULL width at the bottom, under the sidebar.
  if (row >= g.statusTop) return 'status'
  // The sidebar column (only present when messageRight < width); its rows span
  // the whole middle row, so any col beyond the message column is the sidebar.
  if (col > g.messageRight) return 'sidebar'
  // The composer box occupies the bottom rows of the message column — and,
  // while the hero is up, only its CENTERED columns: a click beside the narrow
  // card belongs to the hero background, not to the draft.
  const left = g.composerLeft ?? 1
  const right = g.composerRight ?? g.messageRight
  if (row >= g.composerTop && row <= g.composerBottom && col >= left && col <= right) return 'composer'
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

/** Rows the bottom status bar occupies (mirrors conversation.tsx). */
export const SIDEBAR_STATUS_BAR_ROWS = 3

/** Rows of one sidebar Text at `contentWidth` columns, using the SAME wrapper
 *  Ink's `<Text wrap="wrap">` uses (see composerWrap) so the budget below can
 *  never disagree with what is laid out. */
function sidebarWrappedRows(text: string, contentWidth: number): number {
  if (text === '') return 1
  return wrapAnsi(text, Math.max(1, contentWidth), { trim: false, hard: true }).split('\n').length
}

/** How many Steps the sidebar may render, and how many it must hide.
 *
 *  Why a budget exists at all: Ink 4 has NO `overflow`, so a `flexDirection:
 *  column` box whose children need more rows than the box has does not clip —
 *  Yoga lays the extra rows out BELOW the box and Ink paints them there. On a
 *  short (or narrow, which wraps the footer) terminal the Steps sidebar's
 *  content outgrew its box and its FOOTER was painted onto the composer card's
 *  bottom-border row — the version lines appeared to sit inside the input box.
 *  Measured on a real pty: 80×20 and 60×24 overflow with an EMPTY draft (the
 *  draft's line count is irrelevant; 80×24 and 133×37 are fine).
 *
 *  Mirrors the sidebar render exactly (borderStyle round + paddingX 1 +
 *  paddingTop 1 + gap 1 over five children: heading, steps, session block,
 *  spacer, footer) and reserves the fixed rows first, so the footer and the
 *  session id stay visible and only the STEPS list gives way. Pure; unit-tested.
 *
 *  @param rows - terminal rows (store.rows).
 *  @param width - terminal columns (store.width).
 *  @param steps - one rendered step text per step, in order (`${icon} ${content}`).
 *  @param sessionTitle - display title, or undefined when there is none.
 *  @param sessionId - the session id shown wrapped under the title, if any.
 *  @param footerLines - the sidebar footer's version lines (harness, dsh-tui);
 *    the workspace path line below them is always counted as one row.
 *  Priority when space runs out: the heading and footer are reserved first (small,
 *  bounded, and they carry the step COUNT and the versions/workspace), then the
 *  STEPS take the slack, then the session block gets what is left over.
 *  `showSession` is false when the block does not fit — dropping it whole is
 *  honest and predictable, whereas truncating the id mid-way would look like a
 *  different id.
 *
 *  @returns `visible` = how many leading steps to render; `hidden` = how many
 *    are dropped; `rows`/`capacity` = the rows this plan will occupy and the
 *    rows the box actually has (`rows <= capacity` is the no-overflow invariant
 *    the unit test sweeps); `showMore` = whether the `… +hidden more` row fits
 *    (the caller renders it ONLY when this is true — that row costs a row, and
 *    forgetting to budget it overflowed a 120×18 sidebar again); `showSession`
 *    = whether to render the session block. */
export function sidebarStepPlan(input: {
  rows: number
  width: number
  steps: readonly string[]
  sessionTitle?: string
  sessionId?: string
  footerLines: readonly string[]
}): { visible: number; hidden: number; showMore: boolean; showSession: boolean; rows: number; capacity: number } {
  const { steps } = input
  const sidebarWidth = Math.max(20, Math.round(input.width * 0.3))
  const contentWidth = Math.max(1, sidebarWidth - 4) // round border (2) + paddingX (1 each side)
  const inner = Math.max(0, input.rows - SIDEBAR_STATUS_BAR_ROWS - 2 /* border */ - 1 /* paddingTop */)
  const gaps = 4 // gap 1 between the five children
  const heading = 1 // 'Steps n/m'
  const footer = 3 // two version lines + the workspace path, all wrap="truncate"
  const slack = Math.max(0, inner - gaps - heading - footer)
  // STEPS ARE THE PRIMARY CONTENT: they get the slack first, then the session
  // block takes whatever is left. (Reserving the session block first made the
  // visible step count NON-monotone in the terminal height — one extra row let
  // the block back in and pushed steps out again.)
  let used = 0
  let visible = 0
  for (const step of steps) {
    const need = sidebarWrappedRows(step, contentWidth)
    if (used + need > slack) break
    used += need
    visible += 1
  }
  let hidden = steps.length - visible
  let showMore = false
  if (hidden > 0) {
    // The `… +hidden more` marker costs one more row. Make room for it by
    // dropping steps (the marker says more than the extra step would), and only
    // show it when it actually fits.
    while (visible > 0 && used + 1 > slack) {
      visible -= 1
      hidden += 1
      used -= sidebarWrappedRows(steps[visible]!, contentWidth)
    }
    showMore = used + 1 <= slack
  }
  const sessionNeeds = 1 // 'Session' heading
    + (input.sessionTitle === undefined ? 0 : 1)
    + (input.sessionId === undefined ? 0 : sidebarWrappedRows(input.sessionId, contentWidth))
  const leftover = slack - used - (showMore ? 1 : 0)
  const showSession = input.sessionId !== undefined && leftover >= sessionNeeds
  const sessionRows = showSession ? sessionNeeds : 0
  const total = gaps + heading + sessionRows + used + (showMore ? 1 : 0) + footer
  return { visible, hidden, showMore, showSession, rows: total, capacity: inner }
}

/** Whether the sidebar's MINIMUM content fits in `rows` terminal rows.
 *
 *  The minimum is: status bar (3) + round border (2) + paddingTop (1) + the four
 *  `gap 1` rows + the `Steps` heading (1) + the three footer rows (each kept to
 *  one row by `wrap="truncate"`, so they can never grow). Below that the sidebar
 *  cannot be drawn without overflowing its box (Ink 4 has no `overflow`), so the
 *  renderer hides it entirely instead of painting over the composer. */
export function sidebarFits(rows: number): boolean {
  const inner = rows - SIDEBAR_STATUS_BAR_ROWS - 2 /* border */ - 1 /* paddingTop */
  return inner >= 4 /* gaps */ + 1 /* heading */ + 3 /* footer */
}
