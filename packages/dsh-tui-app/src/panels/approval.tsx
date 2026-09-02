/**
 * The approval panel plugin (`tui-panel-approval`): an in-band prompt over a
 * pending tool approval. Registers the `approval` overlay panel against the
 * `tui` service.
 *
 * @module @yourname/dsh-tui-app/panels-approval
 */

import { Box, Text } from 'ink'
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PendingApproval, TuiService, Store } from '../index.tsx'
import { theme } from '../theme.ts'
import type { RawKey } from '../stdin.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-panel-approval'

/** The store service (see panels/conversation.tsx). */
let store!: Store

/** The `tui` service must be available to register the panel. */
export const inject = ['tui']

/** The three approval actions, selectable with ←/→ (opencode-style dock). */
const APPROVAL_CHOICES = ['Deny', 'Allow always', 'Allow once'] as const

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
  return (
    <Box flexShrink={0} borderStyle="round" borderColor={theme.warning} flexDirection="column" paddingX={1} paddingY={1}>
      <Text color={theme.warning} bold wrap="wrap">⚠ Permission required · {req.toolName}</Text>
      <Box marginTop={1}>
        <Text wrap="truncate">{conciseReason(req.reason, req.toolName)}</Text>
      </Box>
      <Box flexDirection="row" gap={2} marginTop={1}>
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
function approvalKey(k: RawKey): boolean {
  const approval = store.approval
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
    handleKey: (k) => approvalKey(k),
  })
}
