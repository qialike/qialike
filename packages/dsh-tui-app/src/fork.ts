/**
 * The `/fork` plugin (`tui-fork`): continue this conversation in a NEW session.
 *
 * Why it exists next to `/new` (and what a user actually wants at that moment):
 * a session that has grown to hundreds of thousands of events is slow to resume
 * and expensive to keep in context, but `/new` throws the conversation away.
 * `/fork` keeps the conversation and drops the bytes: the host rebuilds the
 * parent's model-visible surface (the last compaction checkpoint plus everything
 * after it, plus the session's route/permission/plan/goal/todo state) as a small
 * self-contained seed, and starts a fresh session from it (`fork-seed.ts`).
 *
 * The parent is left exactly as it was — durable, browsable from `/sessions`,
 * resumable — so `/fork` is a branch, never a move.
 *
 * The switch itself lives in the runtime (`store.forkSessionAction`, injected by
 * start() in index.tsx), next to the single-conversation loop it has to
 * repoint; this plugin only registers the command against the `tui` service.
 *
 * @module @yourname/dsh-tui-app/fork
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TuiService, Store } from './index.tsx'

/** Stable Cordis plugin name. */
export const name = 'tui-fork'

/** The store service (shared across the surface plugins). */
let store!: Store

/** The `tui` service (command registration). */
export const inject = ['tui']

/** Register the `/fork` command. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  tui.commands.register({
    name: 'fork',
    hint: 'continue this conversation in a new session (the old one is kept)',
    run: () => { store.forkSessionAction() },
  })
}
