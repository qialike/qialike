/**
 * The goal plugin (`tui-goal`): a human `/goal` command over the harness
 * `goals` service, with the same grammar and copy as the harness's
 * `command-goal`. The goal domain, the model tools (`get_goal` /
 * `create_goal` / `update_goal`), and the automatic round driver are all
 * mounted by the base bundle; only the human command plane was missing,
 * because the TUI composer routes to `tui.commands`, not the harness
 * `commands` service. This plugin registers `/goal` there and forwards it to
 * `ctx.goals`, so creating a goal arms the existing round driver.
 *
 * @module @yourname/dsh-tui-app/goal
 */

import type { Context } from '@deepseek-ai/cordis'
import { GoalError, type GoalPhase, type GoalRef, type GoalView } from '@deepseek-ai/dsh-goal'
import type { TuiService, Store } from './index.tsx'

/** Stable Cordis plugin name. */
export const name = 'tui-goal'

/** The `tui` service for command registration; the store and the `agents` /
 *  `goals` seams are injected services read through the plugin context. */
export const inject = ['tui', 'agents', 'goals']

/** The store service (see panels/conversation.tsx for the why-behind-the-seam). */
let store!: Store

/** Same usage string as the harness `command-goal`. */
const USAGE = 'Usage: /goal [<objective>|clear|edit <objective>|pause|resume]'

type GoalCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'create'; readonly objective: string }
  | { readonly kind: 'edit'; readonly objective: string }
  | { readonly kind: 'invalid-edit' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'clear' }

/** Parse only the grammar owned by `/goal`; arbitrary other input is an objective. */
function parseGoalCommand(rawInput: string): GoalCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  const control = input.toLowerCase()
  if (control === 'clear') return { kind: 'clear' }
  if (control === 'pause') return { kind: 'pause' }
  if (control === 'resume') return { kind: 'resume' }
  if (control === 'edit') return { kind: 'invalid-edit' }
  if (/^edit(?=\s)/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim() }
  return { kind: 'create', objective: input }
}

/** Human label for one durable goal phase. */
function phaseLabel(phase: GoalPhase): string {
  switch (phase) {
    case 'active': return 'active'
    case 'paused': return 'paused'
    case 'blocked': return 'blocked'
    case 'complete': return 'complete'
  }
}

/** Commands that are meaningful from one exact live state. */
function commandHint(goal: GoalView): string {
  if (goal.phase === 'active') {
    return goal.activation === 'armed'
      ? '/goal edit <objective>, /goal pause, /goal clear'
      : '/goal edit <objective>, /goal resume, /goal clear'
  }
  switch (goal.phase) {
    case 'paused':
    case 'blocked':
      return '/goal edit <objective>, /goal resume, /goal clear'
    case 'complete':
      return '/goal <objective>, /goal clear'
  }
}

/** Render the goal status as one multi-line status entry. */
function renderGoal(title: string, goal: GoalView): string {
  const reason = goal.phase === 'blocked' ? goal.blockedReason : undefined
  const blocker = reason === undefined ? [] : [`Blocker: ${reason.code}: ${reason.message}`]
  return [
    title,
    `Status: ${phaseLabel(goal.phase)}`,
    ...blocker,
    `Objective: ${goal.objective}`,
    `Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
    `Activation: ${goal.activation}`,
    '',
    `Commands: ${commandHint(goal)}`,
  ].join('\n')
}

/** Exact current compare-and-set ref. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/**
 * Run one `/goal` request: the state machine, the grammar and every human
 * message live HERE; the seam calls go to the local harness (the goal service
 * only accepts the registry's live agent).
 * @param arg - the raw composer argument.
 */
async function runGoal(ctx: Context, arg: string): Promise<void> {
  const session = store.session
  if (session === undefined) {
    store.append('status', 'goal: no active session', true)
    return
  }
  const agent = (ctx.agents as { get(id: string): unknown }).get(String(session.id))
  if (agent === undefined) {
    store.append('status', 'goal: no active agent', true)
    return
  }
  const get = async (): Promise<GoalView | undefined> => ctx.goals.get(agent as never)
  const create = async (objective: string): Promise<GoalView> => ctx.goals.create(agent as never, { objective })
  const edit = async (ref: GoalRef, objective: string): Promise<GoalView> => ctx.goals.edit(agent as never, ref, { objective })
  const pause = async (ref: GoalRef): Promise<GoalView> => ctx.goals.pause(agent as never, ref)
  const resume = async (ref: GoalRef): Promise<GoalView> => ctx.goals.resume(agent as never, ref)
  const clear = async (ref: GoalRef): Promise<void> => { ctx.goals.clear(agent as never, ref) }

  const command = parseGoalCommand(arg)
  try {
    switch (command.kind) {
      case 'show': {
        const current = await get()
        store.append('status', current === undefined
          ? `No goal is currently set.\n${USAGE}`
          : renderGoal('Goal', current), true)
        return
      }
      case 'invalid-edit':
        store.append('status', `Goal editing requires a replacement objective.\n${USAGE}`, true)
        return
      case 'create': {
        const current = await get()
        if (current !== undefined && current.phase !== 'complete') {
          store.append('status',
            `A goal is already ${phaseLabel(current.phase)}. Use /goal edit <objective> to change it or /goal clear before replacing it.`, true)
          return
        }
        store.append('status', renderGoal('Goal created', await create(command.objective)), true)
        return
      }
      case 'edit': {
        const current = await get()
        if (current === undefined) {
          store.append('status', `No goal is currently set; /goal edit requires one. ${USAGE}`, true)
          return
        }
        if (current.phase === 'complete') {
          store.append('status', renderGoal('Goal created', await create(command.objective)), true)
          return
        }
        store.append('status', renderGoal('Goal updated', await edit(goalRef(current), command.objective)), true)
        return
      }
      case 'pause': {
        const current = await get()
        if (current === undefined) {
          store.append('status', `No goal is currently set; /goal pause requires one. ${USAGE}`, true)
          return
        }
        store.append('status', renderGoal('Goal paused', await pause(goalRef(current))), true)
        return
      }
      case 'resume': {
        const current = await get()
        if (current === undefined) {
          store.append('status', `No goal is currently set; /goal resume requires one. ${USAGE}`, true)
          return
        }
        store.append('status', renderGoal('Goal resumed', await resume(goalRef(current))), true)
        return
      }
      case 'clear': {
        const current = await get()
        if (current === undefined) {
          store.append('status', 'No goal to clear.', true)
          return
        }
        await clear(goalRef(current))
        store.append('status', 'Goal cleared.', true)
        return
      }
    }
  } catch (error) {
    if (error instanceof GoalError) {
      store.append('status', 'The goal command is not valid for the current state. Run /goal to view available commands.', true)
      return
    }
    store.append('status', `goal: ${error instanceof Error ? error.message : String(error)}`, true)
  }
}

/** Register the `/goal` command. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  tui.commands.register({
    name: 'goal',
    hint: 'set or view the goal for a long-running task',
    run: (arg) => { void runGoal(ctx, arg) },
  })
}
