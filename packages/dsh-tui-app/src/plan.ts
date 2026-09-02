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
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TuiService, Store } from './index.tsx'

/** Stable Cordis plugin name. */
export const name = 'tui-plan'

/** The `tui` service for command registration; the store and the `agents` /
 *  `planMode` seams are injected services read through the plugin context. */
export const inject = ['tui', 'agents', 'planMode']

/** The store service (see panels/conversation.tsx for the why-behind-the-seam). */
let store!: Store

/** Register the `/plan` command; the harness seams require the live agent. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  tui.commands.register({
    name: 'plan',
    hint: 'enter or leave plan mode',
    run: (arg) => {
      const session = store.session
      if (session === undefined) {
        store.append('status', 'plan: no active session', true)
        return
      }
      const agent = ctx.agents.get(session.id)
      if (agent === undefined) {
        store.append('status', 'plan: no active agent', true)
        return
      }
      const message = arg.trim()
      if (message === 'off') {
        // Leave plan mode, mirroring the harness command's per-outcome copy.
        const outcome = ctx.planMode.set(agent, false)
        let text: string
        switch (outcome) {
          case 'committed': text = 'Plan mode off.'; break
          case 'queued': text = 'Leaving plan mode (applies from the next step).'; break
          case 'cancelled': text = 'Plan mode entry cancelled.'; break
          case 'noop':
            text = foldPlanMode(agent.session.events)
              ? 'Leaving plan mode (applies from the next step).'
              : 'Plan mode is already inactive.'
            break
        }
        store.append('status', text, true)
        return
      }
      const outcome = ctx.planMode.set(agent, true)
      // `/plan <message>` enters plan mode and steers the message into the
      // session (the harness command does the same).
      if (message !== '') {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: message }],
          source: { kind: 'user' },
        }))
      }
      store.append('status', outcome === 'committed'
        ? 'Plan mode on. Use /plan off to leave.'
        : 'Entering plan mode (applies from the next step). Use /plan off to leave.', true)
    },
  })
}
