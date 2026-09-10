/**
 * The plan plugin (`tui-plan`): a human `/plan` command over the harness
 * plan-mode service, with the same grammar and copy as the harness's
 * `dsh-plan-mode` command. Plan mode (the logged `plan/mode` state, the
 * injected guidance prompt section, and the `exit_plan_mode` review tool)
 * is mounted by the base bundle; only the human command plane was missing,
 * because the TUI composer routes to `tui.commands`, not the harness
 * `commands` service.
 *
 * @module @yourname/dsh-tui-app/plan
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-plan-mode'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { HostCommandResult, PlanSetOutcome } from './host-command.ts'
import type { TuiService, Store } from './index.tsx'

/** Stable Cordis plugin name. */
export const name = 'tui-plan'

/** The `tui` service for command registration; the store and the `agents` /
 *  `planMode` seams are injected services read through the plugin context. */
export const inject = ['tui', 'agents', 'planMode']

/** The store service (see panels/conversation.tsx for the why-behind-the-seam). */
let store!: Store

/**
 * Run one `/plan` request: the grammar and the copy live here; the seam calls go
 * either to the local harness or (host mode) over the protocol. Plan mode only
 * accepts the registry's live agent, and `/plan <message>` must steer that agent
 * — in host mode both exist only in the child, so the message travels WITH the
 * request instead of being steered into a session-less shim.
 * @param ctx - plugin context carrying the local seams.
 * @param arg - the raw composer argument.
 */
async function runPlan(ctx: Context, arg: string): Promise<void> {
  const session = store.session
  if (session === undefined) {
    store.append('status', 'plan: no active session', true)
    return
  }
  const host = store.hostCommand
  const agent = host === undefined
    ? (ctx.agents as { get(id: string): unknown }).get(String(session.id))
    : undefined
  if (host === undefined && agent === undefined) {
    store.append('status', 'plan: no active agent', true)
    return
  }
  const message = arg.trim()
  try {
    if (message === 'off') {
      // Leave plan mode, mirroring the harness command's per-outcome copy.
      const outcome = host === undefined
        ? ctx.planMode.set(agent as never, false)
        : planOutcome(await host({ kind: 'plan', op: 'set', active: false }))
      let text: string
      switch (outcome) {
        case 'committed': text = 'Plan mode off.'; break
        case 'queued': text = 'Leaving plan mode (applies from the next step).'; break
        case 'cancelled': text = 'Plan mode entry cancelled.'; break
        case 'noop': {
          // Distinguish an already-inactive session from one whose logged
          // state is active; get() reports the logged projection state.
          const active = host === undefined
            ? ctx.planMode.get(agent as never).active
            : (await host({ kind: 'plan', op: 'get' })).active === true
          text = active
            ? 'Leaving plan mode (applies from the next step).'
            : 'Plan mode is already inactive.'
          break
        }
      }
      store.append('status', text, true)
      return
    }
    const outcome = host === undefined
      ? ctx.planMode.set(agent as never, true)
      : planOutcome(await host({ kind: 'plan', op: 'set', active: true, ...message === '' ? {} : { message } }))
    // `/plan <message>` also steers the message into the session (the harness
    // command does the same); the host does that inline, in-process we do it here.
    if (message !== '' && host === undefined) {
      (agent as { steer(message: unknown): void }).steer(createUserMessage({
        content: [{ type: 'text', text: message }],
        source: { kind: 'user' },
      }))
    }
    store.append('status', outcome === 'committed'
      ? 'Plan mode on. Use /plan off to leave.'
      : 'Entering plan mode (applies from the next step). Use /plan off to leave.', true)
  } catch (error) {
    store.append('status', `plan: ${error instanceof Error ? error.message : String(error)}`, true)
  }
}

/** The harness's `set` outcome, or a thrown rejection (the host classifies it). */
function planOutcome(result: HostCommandResult): PlanSetOutcome {
  if (result.error !== undefined) throw new Error(result.error.message)
  return result.outcome ?? 'noop'
}

/** Register the `/plan` command. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  tui.commands.register({
    name: 'plan',
    hint: 'enter or leave plan mode',
    run: (arg) => { void runPlan(ctx, arg) },
  })
}
