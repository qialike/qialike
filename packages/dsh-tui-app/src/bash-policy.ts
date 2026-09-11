/**
 * The read-only sandbox's bash rule: the pure decision the tool pre-execute
 * waterfall consults before a shell command runs.
 *
 * It lives in its own module instead of inline in the Ink plugin because it is
 * a security boundary — the effective mode comes from the session's durable
 * `sandbox/mode` event and the decision must run before every tool execution —
 * and because a pure function is independently testable. The decision is local
 * by construction: no round trip per execution, so a tool never waits on the
 * render loop.
 *
 * @module dsh-tui-app/bash-policy
 */

import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

/** Session file-permission mode, cycled by Tab in the composer (matches the web surface). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * Whether a shell command would modify the filesystem (and is therefore denied
 * under `read-only`). Deliberately heuristic and deliberately conservative:
 * false positives cost a `sandbox_permissions` escalation prompt, false
 * negatives cost the sandbox's promise.
 * @param command - the command string about to run.
 * @returns true when the command can write to disk.
 */
export function bashMutates(command: string): boolean {
  const c = command.trim()
  if (c === '') return false
  if (/(^|\s)(rm|mv|cp|mkdir|rmdir|touch|truncate|install|dd|ln)\b/.test(c)) return true
  if (/(^|\s)(echo|printf|tee|cat|sed|awk)\b[^|;]*[>»]/.test(c)) return true
  if (/(^|\s)sed\b[^|;]*-i\b/.test(c)) return true
  if (/(^|\s)(chmod|chown|chattr)\b/.test(c)) return true
  if (/(^|\s)git\b.*\b(add|commit|checkout|reset|clean|restore)\b/.test(c)) return true
  if (/(^|\s)(python3?|python|node|deno|bun|ruby|perl)\b.*(-c|-e|-w)\b/.test(c)) return true
  if (/(^|\s)(python3?|python|node|deno|bun|ruby|perl)\b.*[>»]/.test(c)) return true
  if (/[^|;]*(>|»|>>)[^|;]*/.test(c)) return true
  return false
}

/** The denial marker, verbatim as the harness's own sandbox emits it
 *  (`dsh-sandbox` `sandboxDenialMarker`) — a UI must not invent a second
 *  dialect for the same refusal. */
const DENIAL_MARKER = '[sandbox: file access denied under read-only mode]'

/** The same-turn escalation hint the harness appends to a denial
 *  (`dsh-sandbox` `escalationHintMarker`, subject `command`): our refusal must
 *  carry it too, or the model never learns the sanctioned retry exists and the
 *  approval path becomes unreachable. */
const ESCALATION_HINT = '[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'

/**
 * The command a tool execution is about to run.
 *
 * NOTE the field name: the harness's `tools/pre-execute` payload is a
 * `ToolExecution`, whose parsed arguments live on **`arguments`**. Reading a
 * (nonexistent) `args` silently yields `''` and makes every check fail OPEN —
 * this fence shipped that way once and never denied anything.
 * @param exec - the pending tool execution.
 * @returns the command string (empty when this execution carries none).
 */
function commandOf(exec: { readonly arguments?: unknown }): string {
  const args = exec.arguments
  if (typeof args === 'string') return args
  if (typeof args === 'object' && args !== null) {
    const command = (args as Record<string, unknown>).command
    return typeof command === 'string' ? command : ''
  }
  return ''
}

/**
 * The session's DURABLE sandbox mode: its LAST `sandbox/mode` event.
 *
 * The durable mode is what the harness's own filesystem/bash backends enforce,
 * so the chip the user sees must show THIS (not a fresh default) — otherwise the
 * UI and the real boundary disagree after a resume. The caller scans the
 * snapshot it already folded, so no extra read is needed.
 * @param events - durable session events (oldest first).
 * @returns the mode, or `undefined` when the session never recorded one.
 */
export function lastSandboxMode(events: readonly { type?: string; data?: unknown }[]): SandboxMode | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'sandbox/mode') continue
    const mode = (event.data as { mode?: unknown } | undefined)?.mode
    if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') return mode
  }
  return undefined
}

/**
 * Decide one tool execution under the `read-only` bash fence.
 *
 * `read-only` denies bash commands that would modify the filesystem; the fs
 * toolbox is fenced by the (pure-JS) fs-sandbox row instead. The denial carries
 * the `[sandbox: …]` marker AND the escalation hint the model surfaces for a
 * `sandbox_permissions` escalation, which then routes to the approval answerer.
 * @param exec - the tool execution under decision (`name` + `arguments`).
 * @param permission - the effective sandbox mode from the session's durable
 *   `sandbox/mode` event (the mode the composer chip shows).
 * @returns the deny decision, or `undefined` to delegate down the chain.
 */
export function readOnlyBashDecision(
  exec: { readonly name?: unknown; readonly arguments?: unknown },
  permission: SandboxMode,
): PreToolDecision | undefined {
  if (permission !== 'read-only') return undefined
  const name = exec.name
  if (typeof name !== 'string' || !(name === 'bash' || name === 'pwsh' || name.includes('bash'))) return undefined
  if (!bashMutates(commandOf(exec))) return undefined
  return { kind: 'deny', reason: `${DENIAL_MARKER}\n${ESCALATION_HINT}` }
}
