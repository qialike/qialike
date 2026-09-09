/**
 * The `/new` plugin (`tui-new`): start a brand-new session in place, modeled
 * on the command-palette "New session" entry (`/new`).
 *
 * dsh-tui is single-session: one process hosts one live agent. `/new`
 * therefore switches in place — the current turn is cancelled, a fresh agent
 * is created, the old agent is disposed, and the runtime repoints its
 * listeners at the new session. The harness persists every session durably
 * (write-behind on session/event), so the old session stays reachable from
 * `/sessions` / `--resume` afterward.
 *
 * The switch itself lives in the runtime (`store.newSessionAction`, injected
 * by start() in index.tsx) so the single-conversation loop — agent, session
 * refs, and the event listeners that close over them — stays in one place;
 * this plugin only registers the command against the `tui` service.
 *
 * @module @yourname/dsh-tui-app/new
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TuiService, Store } from './index.tsx'

/** Stable Cordis plugin name. */
export const name = 'tui-new'

/** The store service (shared across the surface plugins). */
let store!: Store

/** The `tui` service (command registration). */
export const inject = ['tui']

/** Register the `/new` command. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  tui.commands.register({
    name: 'new',
    hint: 'start a new session (the current one is saved)',
    run: () => { store.newSessionAction() },
  })
}
