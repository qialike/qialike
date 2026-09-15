/**
 * The goal bar (`tui-goal-bar`): a right-sidebar section showing the session's
 * current goal — the TUI counterpart of the Web GUI's `ui-goal` GoalBar.
 *
 * The goal domain itself is NOT reimplemented here: `goal`, `goal-round-driver`
 * and `tool-goal` are mounted by the base bundle (so the model can create a goal
 * on its own and the round driver continues it), and `/goal` is the human command
 * plane (`tui-goal`). What was missing was a place to SEE the goal: the TUI
 * renders no `goal/change` state anywhere, so a goal could run for forty rounds
 * with only `/goal` output to explain why.
 *
 * This plugin contributes a sidebar section through the `tui.sidebar` extension
 * point. The conversation panel owns the height budget (`sidebarStepPlan`), so
 * the section reports its own row needs (`full`, plus a one-row `compact`
 * fallback) and is dropped entirely when neither fits — it can never push the
 * sidebar's footer over the composer.
 *
 * Read-only by design: mutations stay on `/goal` (and the model's goal tools),
 * so this plugin adds no key or mouse surface.
 *
 * @module @yourname/dsh-tui-app/goal-bar
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { Context } from '@deepseek-ai/cordis'
import type { GoalPhase, GoalView } from '@deepseek-ai/dsh-goal'
import type { Store, TuiService, TuiSidebarSection } from './index.tsx'
import { theme } from './theme.ts'
import { stripTerminalControls } from './terminal-safe.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-goal-bar'
/** The sidebar section id (also the `tui.sidebar` registration key). */
export const SECTION_ID = 'goal-bar'
/** Render order inside the sidebar column: above the Steps list (smaller wins). */
export const SECTION_ORDER = 10
/** Services read at apply time; the goal domain must be mounted. */
export const inject = ['tui', 'tuiStore', 'agents', 'goals']

let store!: Store
/** Latest known goal for the CURRENT session (undefined = none / unresolved). */
let goal: GoalView | undefined
/** Session the cached `goal` belongs to, so a session switch refreshes once. */
let cachedSessionId: string | undefined
/** Agent the cached `goal` was read for. The read-only view knows the session
 *  BEFORE the agent attaches, so "the agent appeared" is its own transition. */
let cachedAgent: unknown

/** Durable phase labels, identical to `tui-goal`'s `/goal` output. */
const PHASE_LABEL: Record<GoalPhase, string> = {
  active: 'active',
  paused: 'paused',
  blocked: 'blocked',
  complete: 'complete',
}

/** The section's heading: `Goal · <phase>[ · disarmed] <rounds>/<cap>`. */
export function goalBarTitle(view: GoalView): string {
  const disarmed = view.phase === 'active' && view.activation !== 'armed' ? ' · disarmed' : ''
  return `Goal · ${PHASE_LABEL[view.phase]}${disarmed} ${view.roundsStarted}/${view.maxGoalRounds}`
}

/** Rows the section wants: nothing without a goal, else heading + objective
 *  (+ the blocker line while blocked), with a one-row compact fallback. */
export function goalBarRows(view: GoalView | undefined): { full: number; compact: number } {
  if (view === undefined) return { full: 0, compact: 0 }
  const blocked = view.phase === 'blocked' && view.blockedReason !== undefined
  return { full: blocked ? 3 : 2, compact: 1 }
}

/** Paint the section (pure: takes the goal, returns the node). */
export function renderGoalBar(view: GoalView | undefined, compact: boolean): React.ReactNode {
  if (view === undefined) return null
  const title = goalBarTitle(view)
  if (compact) return <Text color={theme.accent} bold wrap="truncate">{title}</Text>
  const blocker = view.phase === 'blocked' ? view.blockedReason : undefined
  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold wrap="truncate">{title}</Text>
      <Text color={theme.text} wrap="truncate">{stripTerminalControls(view.objective)}</Text>
      {blocker === undefined
        ? null
        : <Text color={theme.warning} wrap="truncate">{stripTerminalControls(`⛔ ${blocker.code}: ${blocker.message}`)}</Text>}
    </Box>
  )
}

/** The current session id, or undefined before the agent attaches. */
function currentSessionId(): string | undefined {
  return store.session === undefined ? undefined : String(store.session.id)
}

/** The live agent whose session owns the goal, or undefined before attach. */
function agentFor(ctx: Context): unknown {
  const sessionId = currentSessionId()
  return sessionId === undefined ? undefined : (ctx.agents as { get(id: string): unknown }).get(sessionId)
}

/** Re-read the live goal for the current session (the service read is sync, so
 *  the cache can never be a stale in-flight answer). */
function refresh(ctx: Context): void {
  cachedSessionId = currentSessionId()
  cachedAgent = agentFor(ctx)
  if (cachedAgent === undefined) { goal = undefined; return }
  try {
    goal = (ctx.goals as { get(agent: unknown): GoalView | undefined }).get(cachedAgent)
  } catch {
    goal = undefined
  }
}

/** Register the sidebar section and keep it in sync with the goal domain. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  const section: TuiSidebarSection = {
    id: SECTION_ID,
    order: SECTION_ORDER,
    rows: () => goalBarRows(goal),
    render: (_store, _contentWidth, compact) => renderGoalBar(goal, compact),
  }
  tui.sidebar.register(section)
  // The goal domain's scoped live event: every mutation (model tool, `/goal`,
  // round driver, resume re-arm) lands here after the durable event commits.
  ctx.effect(
    () => ctx.on('goal/changed', () => { refresh(ctx); store.repaint() }),
    'tui-goal-bar: goal watch',
  )
  // A session switch (attach / `/new` / `/sessions`) or the read-only view's
  // later attach replaces the agent, so the cached goal belongs to another
  // (or not-yet-existing) owner: refresh on either transition, not every notify.
  ctx.effect(
    () => store.subscribe(() => {
      if (cachedSessionId === currentSessionId() && cachedAgent === agentFor(ctx)) return
      refresh(ctx)
      store.repaint()
    }),
    'tui-goal-bar: session watch',
  )
  refresh(ctx)
}
