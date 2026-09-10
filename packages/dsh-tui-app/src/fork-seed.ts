/**
 * `/fork` seed construction: turn a parent session's durable log into a SMALL,
 * SELF-CONTAINED seed for a child session that continues the same conversation.
 *
 * Why a seed built here instead of the harness's own fork
 * ------------------------------------------------------
 * `SessionStore.fork` / `session-controller.fork` copy the parent's whole event
 * prefix `[0, cut)` into the child (the prefix is written as ORDINARY storage
 * records, so the child artifact repeats every byte up to the cut) and mark it
 * with `isSeeded: true` + `inheritedEventCount`. For the log this feature was
 * written for (1.49 M events, 28.5 MB compressed) that child is as large and as
 * slow to resume as its parent — the fork changes nothing that hurts.
 *
 * The parent's MODEL-VISIBLE history is a different and much smaller thing. A
 * compaction checkpoint is a `user/message` carrying `surfaceOp: {op:'replace',
 * start, end}`: folding it deletes the shadowed nodes, so the transcript the
 * model actually receives is `[checkpoint, …every surface node after it]`. In
 * the reference log that is 181 messages out of 1.49 M events — the same
 * conversation, 0.01% of the bytes.
 *
 * So this module rebuilds exactly that transcript as a fresh, contiguous log:
 * the last checkpoint's node (rewritten from a replacement to a plain append,
 * because the nodes it shadowed are not copied), every surface node after it up
 * to the last completed turn — plus an unanswered in-flight prompt, which would
 * otherwise vanish — and the last value of each log-only STATE event (route,
 * permissions, plan, goal, todo). The child then inherits the parent's
 * context without inheriting its bytes, and — because the seed is contiguous
 * from seq 0 and carries no `sourceEventSeqs` — it satisfies every invariant the
 * harness enforces on a constructor seed (`Session`'s per-event
 * `assertSessionEventEnvelope` + `SurfaceManager.validateNext`).
 *
 * The old session is never touched: it stays durable, browsable and resumable.
 *
 * @module @yourname/dsh-tui-app/fork-seed
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'

/** The three message-producing event types (`@deepseek-ai/dsh-session/surface`). */
const SURFACE_TYPES = new Set<string>(['user/message', 'assistant/message', 'tool/result'])

/**
 * Log-only events that carry SESSION STATE: one value per fold, so the last
 * occurrence before the cut is the whole of what the child needs to inherit
 * working state rather than history.
 *
 * Deliberately NOT carried: `session/title` (the child gets its own name),
 * `agent/inbox/spliced` (pending input is not history, and a splice whose
 * siblings were dropped fails the inbox's own validation on resume),
 * `approval/asked|decided`, `command/*`, `hook/*`, `llm/retry*`, `tool/call`,
 * `compaction/*` (the checkpoint message already carries the summary text) and
 * every chunk/replay record.
 */
export const FORK_STATE_EVENT_TYPES: readonly string[] = [
  /** The provider/model/effort the parent's last request was built with. */
  'request/header',
  /** Durable request extras (workspace/context blocks) folded at build time. */
  'request/context',
  /** Permission preset + the two knob values it wrote through. */
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  /** Plan mode and goal state ride between turns; the child continues them. */
  'plan/mode',
  'goal/change',
  /** The visible task list. */
  'todo/write',
  /** Live model override and composed agent preset for the session. */
  'model/selection',
  'agent-preset/selected',
]

/** The structural slice of a durable event this module reads. */
export interface ForkSeedSourceEvent {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
  readonly ignorable?: true
}

/** What the caller needs to tell the user what was carried over. */
export interface ForkSeedStats {
  /** Events the parent's snapshot held. */
  readonly parentEvents: number
  /** Seq of the compaction checkpoint the seed starts from (absent = none). */
  readonly checkpointSeq?: number
  /** The `[start, end]` surface range that checkpoint shadowed, when it had one. */
  readonly shadowedRange?: readonly [number, number]
  /** Seq of the last completed turn's `turn/end` the seed ends at. Absent for a
   *  log with no turn markers at all — i.e. a `/fork` child, whose seed carries
   *  the conversation without turn boundaries. */
  readonly lastTurnEndSeq?: number
  /**
   * Seq of an in-flight prompt carried past the cut (absent = none). The client
   * cancels the running turn before it forks, and the cancel may not have
   * reached the durable log when the snapshot is taken — without this the
   * question the user just typed would silently vanish from the child.
   */
  readonly pendingPromptSeq?: number
  /** Surface nodes (messages) in the seed — what the model will see. */
  readonly messages: number
  /** Log-only state events carried over. */
  readonly stateEvents: number
  /** Surface replacements the parent's log applied (compactions, prunes). */
  readonly foldedReplacements: number
}

/** The seed plus its provenance. */
export interface ForkSeedResult {
  readonly seed: readonly SessionEvent[]
  readonly stats: ForkSeedStats
}

/** Why a fork cannot be built from this session. */
export type ForkUnavailableCode =
  /** No completed turn yet: there is no history to continue, and the harness
   *  itself refuses to fork a session with no `turn/end`. */
  | 'no-completed-turn'

/** Raised when the parent has no forkable history; the message is user-facing. */
export class ForkUnavailableError extends Error {
  constructor(readonly code: ForkUnavailableCode, message: string) {
    super(message)
    this.name = 'ForkUnavailableError'
  }
}

/** Whether an event replaces an existing surface range. */
function replaceRange(event: ForkSeedSourceEvent): { start: number; end: number } | undefined {
  const op = event.surfaceOp
  if (typeof op !== 'object' || op === null) return undefined
  const range = op as { op?: unknown; start?: unknown; end?: unknown }
  if (range.op !== 'replace') return undefined
  if (typeof range.start !== 'number' || typeof range.end !== 'number') return undefined
  return { start: range.start, end: range.end }
}

/**
 * Fold the parent's model-visible surface with the harness's own `foldSurface`.
 *
 * The fold needs `seq === index`, so the surface-eligible events are renumbered
 * to their position in a surface-only list and every reference is remapped
 * through the same map. Two rules make the remap safe:
 *   - A replacement's `sourceEventSeqs` must cite every shadowed node
 *     (`assertProvenance`), and shadowed nodes are surface events by definition,
 *     so the remapped list keeps exactly what the fold demands.
 *   - An append's refs are dropped: they cite chunk seqs (not in the list) and
 *     the fold does not require them (`assertProvenance(event, [])`).
 * A replacement whose range cannot be resolved is folded as an append rather
 * than left dangling, so one bad node cannot throw the whole fork away.
 * @param events - the parent's full snapshot.
 * @returns node indexes into `events` in surface order, plus the replacements applied.
 */
function foldParentSurface(events: readonly ForkSeedSourceEvent[]): {
  nodes: number[]
  replacements: Array<{ index: number; start: number; end: number }>
} {
  const indexes: number[] = []
  for (let i = 0; i < events.length; i++) {
    if (SURFACE_TYPES.has(events[i]!.type)) indexes.push(i)
  }
  const positionOf = new Map<number, number>()
  indexes.forEach((index, position) => positionOf.set(events[index]!.seq, position))
  const normalized = indexes.map((index, position) => {
    const event = events[index]!
    const range = replaceRange(event)
    const start = range === undefined ? undefined : positionOf.get(range.start)
    const end = range === undefined ? undefined : positionOf.get(range.end)
    const shadowed = start === undefined || end === undefined
    const refs = shadowed ? undefined : event.sourceEventSeqs
    const cited = Array.isArray(refs)
      ? [...new Set(refs.map(seq => positionOf.get(seq as number)).filter((at): at is number => at !== undefined))]
      : undefined
    return {
      type: event.type,
      seq: position,
      time: event.time,
      data: event.data,
      surfaceOp: shadowed ? 'append' : { op: 'replace' as const, start: start!, end: end! },
      // Required on a replacement (it must cite every shadowed node), dropped on
      // an append (it would cite chunks the fold cannot resolve).
      ...(shadowed || cited === undefined ? {} : { sourceEventSeqs: cited }),
    }
  })
  const fold = foldSurface(normalized as never)
  return {
    nodes: fold.nodes.map(position => indexes[position]!),
    replacements: fold.replacements.map(entry => ({
      index: indexes[entry.seq]!,
      start: indexes[entry.start]!,
      end: indexes[entry.end]!,
    })),
  }
}

/** Every tool-call id an assistant message asks for. */
function toolCallIds(event: ForkSeedSourceEvent): string[] {
  const message = (event.data as { message?: { content?: unknown } } | undefined)?.message
  const content = message?.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    const call = block as { type?: unknown; id?: unknown }
    if (call?.type === 'tool-call' && typeof call.id === 'string') ids.push(call.id)
  }
  return ids
}

/** The tool call a `tool/result` answers. */
function answeredCallId(event: ForkSeedSourceEvent): string | undefined {
  const source = (event.data as { message?: { source?: { callId?: unknown } } } | undefined)?.message?.source
  return typeof source?.callId === 'string' ? source.callId : undefined
}

/**
 * Drop a trailing run that would make the transcript ill-formed: an assistant
 * message whose tool calls have no result, or a tool result whose requesting
 * assistant message is not in front of it. Used for a log with no turn markers
 * (a `/fork` child), where the turn boundary cannot answer the question.
 * @param nodes - candidate node indexes into `events`, in transcript order.
 * @param events - the parent's events.
 * @returns the longest well-formed prefix.
 */
function trimDanglingTail(
  nodes: readonly number[],
  events: readonly ForkSeedSourceEvent[],
): number[] {
  const kept = [...nodes]
  for (;;) {
    const last = kept.at(-1)
    if (last === undefined) return kept
    const event = events[last]!
    if (event.type === 'assistant/message') {
      if (toolCallIds(event).length === 0) return kept
      kept.pop()
      continue
    }
    if (event.type !== 'tool/result') return kept
    const previous = kept.at(-2)
    const callId = answeredCallId(event)
    if (previous !== undefined && events[previous]!.type === 'assistant/message'
      && callId !== undefined && toolCallIds(events[previous]!).includes(callId)) {
      return kept
    }
    kept.pop()
  }
}

/**
 * Build the child's seed from the parent's events.
 *
 * The result is contiguous from `seq: 0`, ordered as `[state events…, surface
 * nodes…]` (log-only events are invisible to the surface fold, so state first is
 * free), and every surface node is a plain append: `sourceEventSeqs` is dropped
 * everywhere because it cites chunk/compaction seqs that are not copied, and
 * `assertProvenance` rejects a stale or empty citation.
 *
 * @param events - the parent's FULL event snapshot (`seq === index`).
 * @returns the seed and what it carries.
 * @throws ForkUnavailableError when the session has no completed turn.
 */
export function buildForkSeed(events: readonly ForkSeedSourceEvent[]): ForkSeedResult {
  let lastTurnEnd = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'turn/end') { lastTurnEnd = i; break }
  }
  /** A log with no turn markers: every `/fork` child (a seed carries the
   *  conversation as plain surface events, so it has no `turn/end`), and any log
   *  whose turn brackets were lost. Such a session is still fully forkable —
   *  its transcript is right there — so the cut falls back to the transcript's
   *  SHAPE (below) instead of a turn boundary. */
  const turnless = lastTurnEnd < 0

  // The parent's FINAL model-visible surface, from the harness's own fold.
  // Nothing here is a "cut at the checkpoint": the fold has already dropped
  // every shadowed node, so the survivors ARE the transcript — including nodes
  // that a compaction left in place (when its region did not reach the top of
  // the history) and nodes appended DURING a compaction, whose seq is lower than
  // the checkpoint's own but whose surface position is after it (measured on the
  // reference log: checkpoint at 1447884, an assistant message at 1447878 that
  // comes after it and belongs to the child's context too).
  const { nodes, replacements } = foldParentSurface(events)
  const lastCheckpoint = replacements.filter(entry => events[entry.index]!.type === 'user/message').at(-1)

  // An OPEN turn at the tail: carry its prompt, never its partial answer. The
  // prompt is the turn's first event, so cutting at the last one keeps the
  // transcript valid (a pending user message is exactly what a mid-turn model
  // request holds) while an assistant message whose tool calls have no results
  // — or a half-streamed step — would poison the child's first request.
  let pendingPrompt = -1
  for (let i = events.length - 1; i > lastTurnEnd; i--) {
    const event = events[i]!
    if (event.type === 'user/message' && replaceRange(event) === undefined) { pendingPrompt = i; break }
  }
  const windowEnd = turnless ? Number.MAX_SAFE_INTEGER : (pendingPrompt < 0 ? lastTurnEnd : pendingPrompt)

  // Everything the fold keeps, up to the end of the copied window. Nodes are
  // already in final surface order, which is NOT always log order (see above),
  // and the window filter is what drops the partial answer of an open turn.
  const keptNodes = turnless
    // No turn to cut at: take the whole transcript, then walk back to its last
    // well-formed end. A provider request whose last assistant message asks for
    // tools that have no results is rejected, so a dangling call (the turn was
    // interrupted mid-step) must not be the child's final message.
    ? trimDanglingTail(nodes, events)
    : nodes.filter(index => index <= windowEnd)

  // One value per state fold: the LAST occurrence of each state type. Searched
  // over the WHOLE parent log, not just the copied window: a permission switch,
  // a plan/goal change or a todo write lands BETWEEN turns (after a `turn/end`)
  // — which is exactly why the harness's own fork extends its cut forward to the
  // next `turn/start` — and a child that missed one would run with the wrong
  // sandbox mode or a stale plan.
  const state: number[] = []
  for (const type of FORK_STATE_EVENT_TYPES) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type === type) { state.push(i); break }
    }
  }
  state.sort((a, b) => a - b)

  if (keptNodes.length === 0) {
    throw new ForkUnavailableError(
      'no-completed-turn',
      'this session has nothing to continue from yet — send a message and /fork again',
    )
  }
  const kept = [...state, ...keptNodes]
  const seed = kept.map((index, seq) => toSeedEvent(events[index]!, seq))
  const shadowed = lastCheckpoint === undefined
    ? undefined
    : replaceRange(events[lastCheckpoint.index]!)
  return {
    seed,
    stats: {
      parentEvents: events.length,
      ...(lastCheckpoint === undefined ? {} : { checkpointSeq: events[lastCheckpoint.index]!.seq }),
      ...(shadowed === undefined ? {} : { shadowedRange: [shadowed.start, shadowed.end] as const }),
      ...(turnless ? {} : { lastTurnEndSeq: events[lastTurnEnd]!.seq }),
      ...(pendingPrompt < 0 ? {} : { pendingPromptSeq: events[pendingPrompt]!.seq }),
      messages: keptNodes.length,
      stateEvents: state.length,
      foldedReplacements: replacements.length,
    },
  }
}

/**
 * Copy one parent event into a seed envelope: renumbered, and with the surface
 * metadata a fresh log needs.
 * @param event - the parent event to copy.
 * @param seq - its index in the seed.
 * @returns the seed event.
 */
function toSeedEvent(event: ForkSeedSourceEvent, seq: number): SessionEvent {
  const envelope: Record<string, unknown> = {
    type: event.type,
    seq,
    time: Number.isSafeInteger(event.time) ? event.time : Date.now(),
    data: event.data,
  }
  // Required on message-producing events, forbidden on log-only ones. A copied
  // replacement becomes an append: its `start`/`end` pointed at nodes that are
  // not in this log, and the fold would reject the dangling range.
  if (SURFACE_TYPES.has(event.type)) envelope['surfaceOp'] = 'append'
  if (event.ignorable === true) envelope['ignorable'] = true
  return envelope as unknown as SessionEvent
}

/**
 * One line for the status bar, from the builder's own numbers.
 * @param stats - the result of {@link buildForkSeed}.
 * @returns e.g. `181 messages from compaction @1447884 of 1491814 events`.
 */
export function describeForkSeed(stats: ForkSeedStats): string {
  const from = stats.checkpointSeq === undefined
    ? `full history (no compaction)`
    : `from compaction @${stats.checkpointSeq}`
  return `${stats.messages} messages ${from} · ${stats.stateEvents} state events · ${stats.parentEvents} parent events`
}
