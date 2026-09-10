/**
 * The read-only sandbox's bash rule, shared by BOTH sides of P4c host mode.
 *
 * In host mode the harness (and therefore the `tools/pre-execute` waterfall)
 * lives in the child process while the permission chip the user cycles with Tab
 * is drawn by the client. The rule below therefore cannot live in the Ink
 * plugin alone: a divergence would silently drop the fence whenever the user
 * switched to `read-only`. One module, imported by both, is what makes the
 * mirrored mode safe.
 *
 * It also keeps the fence OFF the wire: the host answers every tool execution
 * locally from the mirrored mode, because a per-tool round trip would make tool
 * execution wait on the client's render loop — the very coupling P4c removes.
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

/**
 * Decide one tool execution under the `read-only` bash fence.
 *
 * `read-only` denies bash commands that would modify the filesystem; the fs
 * toolbox is fenced by the (pure-JS) fs-sandbox row instead. The denial carries
 * the `[sandbox: …]` marker the model surfaces for a `sandbox_permissions`
 * escalation, which then routes to the approval answerer.
 * @param exec - the tool execution under decision (`name` + `args`).
 * @param permission - the effective sandbox mode (mirrored to the host in host mode).
 * @returns the deny decision, or `undefined` to delegate down the chain.
 */
export function readOnlyBashDecision(
  exec: { readonly name?: unknown; readonly args?: unknown },
  permission: SandboxMode,
): PreToolDecision | undefined {
  if (permission !== 'read-only') return undefined
  const name = exec.name
  const args = exec.args
  const command = String(
    typeof args === 'string'
      ? args
      : typeof args === 'object' && args !== null
        ? (args as Record<string, unknown>).command ?? ''
        : '',
  )
  if (typeof name === 'string' && (name === 'bash' || name === 'pwsh' || name.includes('bash')) && bashMutates(command)) {
    return { kind: 'deny', reason: '[sandbox: file access denied under read-only mode]' }
  }
  return undefined
}
