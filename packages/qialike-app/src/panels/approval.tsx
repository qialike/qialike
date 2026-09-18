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
import { visualWidth } from '../markdown.tsx'
import { WHEEL_STEP } from '../config.ts'
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

/** Strip the harness escalation boilerplate ("escalate sandbox to <mode>: ")
 *  so the dock shows the model's explanation alone, on one truncated line. */
function conciseReason(reason: string | undefined, toolName: string): string {
  if (reason === undefined) return `Tool ${toolName} requests privileged execution`
  return reason.replace(/^escalate sandbox to [^:]+:\s*/i, '')
}

/** In-band approval dock over a pending tool call: key info only (tool +
 *  one truncated reason line), docked above the composer. It is rendered
 *  inside the message column, so it stretches to the message box's current
 *  width (the column re-lays out on every terminal resize). */
function ApprovalDialog(props: { approval: PendingApproval }): React.JSX.Element {
  const { req } = props.approval
  const dockRef = React.useRef<DOMElement>(null)
  const rowRef = React.useRef<DOMElement>(null)
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
      <Box marginTop={1}>
        <Text wrap="truncate">{stripTerminalControls(conciseReason(req.reason, req.toolName))}</Text>
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
