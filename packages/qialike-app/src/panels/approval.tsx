/**
 * The approval panel plugin (`tui-panel-approval`): an in-band dock over a
 * pending tool approval. Registers the `approval` overlay panel against the
 * `tui` service.
 *
 * Mouse & wheel routing mirrors the question dock: the FIRST thing every
 * pointer event does is decide where the pointer sits (shared pointer-region
 * router) — on the dock (hover/click an action, wheel inert), on the message
 * column outside the dock (including the composer strip below it: wheel
 * scrolls the transcript, press/drag/release select & copy / edit the draft
 * exactly as on the normal surface, forwarded to the conversation panel's own
 * handler), or outside the message column (Steps sidebar: no response).
 *
 * @module @yourname/qialike-app/panels-approval
 */

import { Box, Text, measureElement } from 'ink'
import type { DOMElement } from 'ink'
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PendingApproval, TuiService, Store } from '../index.tsx'
import { visualWidth, truncateWide, countWrappedLines } from '../markdown.tsx'
import { WHEEL_STEP, dockInnerWidth } from '../config.ts'
import type { SidebarMode } from '../config.ts'
import { theme } from '../theme.ts'
import type { RawKey } from '../stdin.ts'
import { useRowGeometry, dialogRowIndexFromCol, measureDomTop } from '../list-geometry.ts'
import { pointerRegion, composerStripRows, messageRightFor } from '../pointer-region.ts'
import { stripTerminalControls } from '../terminal-safe.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-panel-approval'

/** The store service (see panels/conversation.tsx). */
let store!: Store

/** The `tui` service must be available to register the panel. */
export const inject = ['tui']

/** The three approval actions, selectable with ←/→ (dock choices). */
const APPROVAL_CHOICES = ['Deny', 'Allow always', 'Allow once'] as const

/** Latest measured SCREEN ROW SPAN of the whole approval dock (its root Box;
 *  the dock lives IN-FLOW in the message column, right under the transcript,
 *  so its top moves with the transcript while its bottom sits above the
 *  composer). The message column rows inside this span count as "on the dock".
 *  Refreshed whenever the dock renders. */
let approvalDockSpan: { top: number; height: number } | null = null

/**
 * How many wrapped rows the reason may occupy in the dock.
 *
 * The reason is often the model's own multi-sentence justification (an
 * escalation request always carries one), and it IS the thing being approved: a
 * single truncated line hid the reason to grant wider access. Five rows shows
 * every reason seen in practice whole while keeping the dock's in-flow height
 * bounded on a short terminal.
 */
export const REASON_MAX_ROWS = 5

/** The marker appended to a reason that still does not fit {@link REASON_MAX_ROWS}. */
const REASON_TAIL = ' … (full text below the prompt)'

/**
 * The dock's rows at a given reason height — the FIRST-FRAME ESTIMATE.
 *
 * The dock's fixed chrome measured 10 rows with Ink (border 2 + vertical padding
 * 2 + title 1 + the reason block's margin 1 + the actions row's margin 1 + the
 * actions row 1 + the hint's margin 1 + the hint row 1); the optional
 * `Requests access:` block adds 1, and the reason adds its own wrapped rows.
 *
 * {@link conversation} reserves this many transcript rows, and a one-row reason
 * is the 11-row dock this panel has always painted — the number a hard-coded 11
 * there used to stand for. That hard-coding under-reserved the moment the reason
 * took a second row, and the dock's bottom edge (hint + border) would fall off
 * the screen; the panel now also reports the height MEASURED by Ink, and the
 * caller takes `max(estimate, measured)`, so an estimate that is off by one only
 * costs a row of transcript on the first frame. The reason's row count comes
 * from the shared `wrap-ansi` oracle, which can disagree with Ink by one row
 * when a break lands on the boundary — hence the measurement.
 * @param reasonRows - wrapped rows the reason occupies (1..{@link REASON_MAX_ROWS}).
 * @param hasTarget - whether the dock also renders the escalation-target row.
 * @returns the dock's estimated painted rows.
 */
export function approvalDialogRows(reasonRows: number, hasTarget: boolean): number {
  return 10 + (hasTarget ? 1 : 0) + Math.max(1, reasonRows)
}

/** One approval reason, split into its escalation target and its prose. */
export interface ApprovalReason {
  /** The sandbox mode the caller is asking to widen to, when the reason requests one. */
  target: string | undefined
  /** Everything the caller said, with the harness's `escalate sandbox to <mode>:` prefix removed. */
  text: string
}

/**
 * Split an approval reason into the escalation TARGET and the prose.
 *
 * The harness prefixes an escalation reason with `escalate sandbox to <mode>: `.
 * That mode is the single most useful fact in the prompt — it is what the user
 * is being asked to permit — so it is returned separately for its own labelled
 * line instead of being stripped away with the rest of the boilerplate.
 * @param reason - the request's reason, or `undefined` when it carries none.
 * @param toolName - the tool the request came from, used for the fallback text.
 * @returns the target (if any) and the prose to render.
 */
export function approvalReason(reason: string | undefined, toolName: string): ApprovalReason {
  if (reason === undefined) return { target: undefined, text: `Tool ${toolName} requests privileged execution` }
  const match = /^\s*escalate sandbox to ([^:]+):\s*/i.exec(reason)
  if (match === null) return { target: undefined, text: reason.trim() }
  return { target: (match[1] ?? '').trim(), text: reason.slice(match[0].length).trim() }
}

/**
 * Fit a reason into the dock's row budget, keeping it whole when it fits.
 *
 * Bounded by ROWS, not characters: the same text occupies a different number of
 * rows at every terminal width, so a character cap would either clip a short
 * reason on a narrow terminal or leave a long one unreadable on a wide one.
 * @param text - the reason prose.
 * @param cols - display columns inside the dock.
 * @param maxRows - the row budget (defaults to {@link REASON_MAX_ROWS}).
 * @returns text that wraps to at most `maxRows`, shortened with a visible marker.
 */
export function fitReason(text: string, cols: number, maxRows: number = REASON_MAX_ROWS): string {
  const usable = Math.max(1, cols)
  if (countWrappedLines(text, usable) <= maxRows) return text
  // Binary search the longest prefix whose wrapped form (plus the tail marker)
  // still fits. One cell at a time would be O(n²) `wrap-ansi` passes, and a real
  // session's reasons are hundreds of characters while a pasted one can be
  // thousands; the predicate is monotone in the cut, so bisection is exact.
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (countWrappedLines(`${truncateWide(text, mid)}${REASON_TAIL}`, usable) <= maxRows) low = mid
    else high = mid - 1
  }
  return `${truncateWide(text, low)}${REASON_TAIL}`
}

/**
 * Everything the dock needs to size and render one reason: the target it asks
 * for, the prose (fitted to the row budget), and the height that results.
 * @param reason - the request's reason.
 * @param toolName - the tool the request came from.
 * @param width - terminal width.
 * @param mode - the right-sidebar mode (decides the dock's real inner width).
 * @returns the target, the fitted prose, the reason's rows, whether it was shortened, and the dock's rows.
 */
export function approvalReasonLayout(
  reason: string | undefined,
  toolName: string,
  width: number,
  mode: SidebarMode,
): { target: string | undefined; shown: string; rows: number; shortened: boolean; dockRows: number } {
  const { target, text } = approvalReason(reason, toolName)
  const cols = Math.max(1, dockInnerWidth(width, mode))
  const shown = fitReason(text, cols)
  const rows = Math.min(REASON_MAX_ROWS, countWrappedLines(shown, cols))
  const hasTarget = target !== undefined && target.length > 0
  return { target, shown, rows, shortened: shown !== text, dockRows: approvalDialogRows(rows, hasTarget) }
}

/** In-band approval dock over a pending tool call: the tool, the access being
 *  requested, and the full reason (wrapped, and shortened only if it exceeds
 *  {@link REASON_MAX_ROWS} rows), docked above the composer. It is rendered
 *  inside the message column, so it stretches to the message box's current
 *  width (the column re-lays out on every terminal resize).
 *
 *  Exported so the height the transcript reserves can be pinned against the
 *  height Ink actually paints (`tests/approval-reason-layout.test.ts`). */
export function ApprovalDialog(props: { approval: PendingApproval }): React.JSX.Element {
  const { req } = props.approval
  const dockRef = React.useRef<DOMElement>(null)
  const rowRef = React.useRef<DOMElement>(null)
  // The dock's wrap width comes from the SAME helper the question dock uses:
  // re-wrapping at the bare terminal width would overflow the narrower column
  // and silently double the dock's height.
  const layout = approvalReasonLayout(req.reason, req.toolName, store.width, store.sidebarMode ?? 'auto')
  // The three actions form one horizontal row; register its geometry so mouse
  // hover/click can map a screen (row, col) to an action index — the row is
  // part of the geometry, so hovering the dock's title/reason/hint rows never
  // highlights an option that merely shares its column.
  const widths = APPROVAL_CHOICES.map((label) => visualWidth(label))
  useRowGeometry(rowRef, widths, [store.approvalChoice, req.toolName])
  // Report the dock's REAL rendered row span (like the question dock): the
  // region router classifies rows inside it as dock territory. Fixed 11-row
  // dock, but measured (top moves with the transcript) — falls back to
  // "unmeasured → everything is dock" on the very first frame.
  React.useEffect(() => {
    const report = (): void => {
      const el = dockRef.current
      if (el === null) { approvalDockSpan = null; return }
      const h = Math.round(measureElement(el).height)
      approvalDockSpan = { top: Math.round(measureDomTop(el)), height: h }
      // conversation.tsx reserves exactly this many transcript rows (the dock is
      // IN-FLOW in the message column), so report the REAL painted height: the
      // layout estimate above is what it uses on the first frame, before this
      // measurement lands.
      store.setApprovalRows(h)
    }
    report()
    const t = setTimeout(report, 80) // layout may settle a frame after commit
    return () => clearTimeout(t)
    // The dock's top row moves with the composer's height, which depends on the
    // terminal width (wrap) / rows / draft / image chip — re-measure whenever
    // any of them could have changed (resize while the dock is open).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.rows, store.width, store.input, store.composerImage !== null, req.toolName])
  return (
    <Box ref={dockRef} flexShrink={0} borderStyle="round" borderColor={theme.warning} flexDirection="column" paddingX={1} paddingY={1}>
      <Text color={theme.warning} bold wrap="wrap">⚠ Permission required · {stripTerminalControls(req.toolName)}</Text>
      {layout.target !== undefined && layout.target.length > 0 && (
        <Box marginTop={1}>
          <Text color={theme.warning} wrap="truncate">Requests access: {stripTerminalControls(layout.target)}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text wrap="wrap">{stripTerminalControls(layout.shown)}</Text>
      </Box>
      <Box flexDirection="row" gap={2} marginTop={1} ref={rowRef}>
        {APPROVAL_CHOICES.map((label, i) => (
          <Text key={label} color={i === store.approvalChoice ? theme.warning : undefined} inverse={i === store.approvalChoice}>
            {label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>←/→ choose · Enter confirm · Esc reject</Text>
      </Box>
    </Box>
  )
}

/** Handle one key while the approval panel is active; returns true (consumed). */
function approvalKey(k: RawKey, tui: TuiService): boolean {
  const approval = store.approval
  if (approval === null) { store.setPanel('conversation'); return true }
  // ── Pointer routing by screen region (mouse + wheel), same as the question
  //    dock: on the dock → hover/click actions only (wheel inert); on the
  //    MESSAGE COLUMN outside the dock (incl. the composer strip below it) →
  //    act on the surface as when no dock is open (wheel scrolls, clicks /
  //    drags edit the draft / select & copy), forwarded to the conversation
  //    panel's own handler; outside the message column (sidebar) → ignore.
  const ptr = k.mousePress ?? k.mouseDrag ?? k.mouseMove ?? k.mouseRelease
  const wheelUp = k.wheelUp
  const wheelDown = k.wheelDown
  const ptrRow = ptr?.row ?? wheelUp?.row ?? wheelDown?.row
  const ptrCol = ptr?.col ?? wheelUp?.col ?? wheelDown?.col
  if (ptrRow !== undefined && ptrCol !== undefined) {
    const msgRight = messageRightFor(store.width, store.sidebarMode ?? 'auto')
    const region = pointerRegion(ptrRow, ptrCol, approvalDockSpan, msgRight,
      composerStripRows(store.width, store.rows, store.input, store.composerImage !== null, msgRight))
    if (region === 'none') return true // outside the message column: ignore the mouse event
    if (region === 'dock') {
      // Wheel over the dock: inert. Button events fall through to the dock
      // logic below (hover/click an action).
      if (wheelUp !== undefined || wheelDown !== undefined) return true
    } else {
      // Message column outside the dock (message rows AND the composer strip
      // below the dock): act on the surface exactly as when no dock is open —
      // wheel scrolls the transcript, everything else is forwarded to the
      // conversation panel's own handler (single source of truth: composer
      // caret/selection/copy, transcript select/copy, tool-row clicks…).
      if (wheelUp !== undefined) { store.scrollLines(-WHEEL_STEP); return true }
      if (wheelDown !== undefined) { store.scrollLines(WHEEL_STEP); return true }
      const conv = tui.panels.byId('conversation')
      if (conv !== undefined && conv.handleKey !== undefined) conv.handleKey(k, store)
      return true
    }
  }
  // Mouse in the dock: hover highlights the action under the cursor (via the
  // registered row geometry — only on the actions row); a left-click anchors
  // on that action, then runs the highlighted choice (== Enter). Press/drag
  // are consumed (no transcript drag).
  if (k.mousePress) return true
  if (k.mouseMove) {
    const idx = dialogRowIndexFromCol(k.mouseMove.row, k.mouseMove.col)
    if (idx >= 0) store.setApprovalChoice(idx)
    return true
  }
  if (k.mouseRelease) {
    if (store.mouseRelease(k.mouseRelease.row, k.mouseRelease.col) === 'click') {
      const idx = dialogRowIndexFromCol(k.mouseRelease.row, k.mouseRelease.col)
      if (idx >= 0) store.setApprovalChoice(idx)
      return approvalKey({ return: true } as RawKey, tui)
    }
    return true
  }
  if (k.leftArrow) { store.cycleApprovalChoice(-1); return true }
  if (k.rightArrow) { store.cycleApprovalChoice(1); return true }
  const settle = (choice: number): void => {
    if (approval === null) return
    // Allow always (choice 1): remember the tool for this session AND allow.
    if (choice === 1 && approval.req.toolName !== undefined) store.rememberAllowAlways(approval.req.toolName)
    store.setApproval(null)
    approval.resolve(choice === 0 ? 'rejected' : 'allowed-once')
    store.cancelAction()
  }
  if (k.return) settle(store.approvalChoice)
  else if (k.escape || (k.ctrl && (k.char ?? '') === 'c')) settle(0)
  return true
}

/** Register the approval overlay panel. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  tui.panels.register({
    id: 'approval',
    mode: 'overlay',
    render: () => (store.approval === null ? null : <ApprovalDialog approval={store.approval} />),
    handleKey: (k) => approvalKey(k, tui),
  })
}
