/**
 * Wire types for the session-scoped harness command plane — `/goal` and
 * `/plan` — when the session lives in another process (P4c M4.3).
 *
 * Both commands operate on the LIVE agent (`ctx.goals` / `ctx.planMode` reject
 * anything else), so in host mode the work has to happen where that agent is.
 * The client keeps the GRAMMAR and the human copy (it owns the composer) and
 * sends one semantic operation per seam call; the host answers with the raw
 * service value. That is why this module carries types only: the command
 * plugins are separate bundles, so a shared VALUE would land on a second module
 * copy (see `Store.hostCommand`, the runtime's seam for exactly that reason).
 *
 * @module dsh-tui-app/host-command
 */

import type { GoalRef, GoalView } from '@deepseek-ai/dsh-goal'

/** One goal/plan operation the client asks the host to perform. */
export type HostCommand =
  | { readonly kind: 'goal'; readonly op: 'get' }
  | { readonly kind: 'goal'; readonly op: 'create'; readonly objective: string }
  | {
    readonly kind: 'goal'
    readonly op: 'edit' | 'pause' | 'resume' | 'clear'
    /** Compare-and-set ref from the preceding `get` (the harness rejects a stale one). */
    readonly ref: GoalRef
    readonly objective?: string
  }
  | { readonly kind: 'plan'; readonly op: 'get' }
  | {
    readonly kind: 'plan'
    readonly op: 'set'
    readonly active: boolean
    /** `/plan <message>`: the text the host steers into the session. */
    readonly message?: string
  }

/** The harness plan-mode `set` outcome vocabulary, verbatim. */
export type PlanSetOutcome = 'committed' | 'queued' | 'cancelled' | 'noop'

/** The host's answer: the raw service value, or a classified rejection. */
export interface HostCommandResult {
  /** `goal` op results. */
  readonly goal?: GoalView
  /** `plan get`: whether plan mode is on. */
  readonly active?: boolean
  /** `plan set`: the harness outcome code (the client owns the copy). */
  readonly outcome?: PlanSetOutcome
  /** Rejection: `GoalError` code (or `failed`), so the client can rebuild the
   *  error and keep its human-readable mapping in one place. */
  readonly error?: { readonly code: string; readonly message: string }
}
