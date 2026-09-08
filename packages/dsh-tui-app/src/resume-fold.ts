/**
 * Resume-history fold planning for giant sessions (dsh-tui L1 "tail first"
 * fix). Folding a very long durable event log into the transcript in ONE
 * synchronous pass freezes the first frame for seconds (12万-event sessions
 * measured). The planner instead cuts the log at "safe" boundaries so the
 * newest tail can be folded and painted immediately, while the older ranges
 * fold in background slices that are prepended at the front of the transcript
 * later.
 *
 * A fold slice may START at index `s` only when the fold state before `s` is
 * clean:
 *  · no tool call is still awaiting its result — a `tool/call` and the
 *    `tool/result` that settles it must stay in the SAME slice (the fold
 *    settles a tool row by searching backward inside its own items array),
 *    so the open-call balance must be zero at the start;
 *  · the fold's last pushed item is not an open reasoning accumulator —
 *    consecutive reasoning-delta chunks accumulate into ONE Think row, and
 *    only an item-pushing event (user/message, assistant/message, tool/call)
 *    closes that row; a cut inside the run would render it as two rows.
 * Most positions satisfy both (measured ~30% on real logs once the reasoning
 * rule is included — reasoning deltas dominate the event stream), so slices
 * of the desired size are always available.
 *
 * @module dsh-tui/resume-fold
 */

/** Below this many events the existing single-pass resume fold is kept
 *  unchanged (small sessions never pay chunking overhead). */
export const HISTORY_FAST_EVENTS = 20_000

/** Events folded synchronously for the first frame of a chunked resume (the
 *  "recent tail": what the user resumed to continue). */
export const HISTORY_TAIL_EVENTS = 20_000

/** Older events fold in slices no larger than this (each slice is one
 *  setTimeout yield, so the UI keeps painting between slices). */
export const HISTORY_SLICE_EVENTS = 4_000

/** Minimal view of a session event the planner reads (decoupled from the
 *  full `SessionEvent` union so this module stays dependency-light). */
export interface PlanEvent {
  readonly type: string
  readonly data?: unknown
}

function isReasoningDelta(event: PlanEvent): boolean {
  if (event.type !== 'assistant/chunk') return false
  const chunk = event.data as { chunk?: { type?: string } } | undefined
  return chunk?.chunk?.type === 'reasoning-delta'
}

export type ResumeFoldPlan =
  | { readonly mode: 'fast' }
  | {
    readonly mode: 'chunked'
    /** First index of the synchronously folded tail (`events[tailStart..]`). */
    readonly tailStart: number
    /** Older ranges `[from, to)`, ascending, contiguous, covering
     *  `[0, tailStart)`; fold them newest range FIRST for display. */
    readonly olderRanges: ReadonlyArray<readonly [number, number]>
  }

/** Indices where a NEW fold slice may start (`events[start..]`), with the
 *  fold state before `start` clean (see the module doc): no tool call is
 *  awaiting its result and the fold's tail item is not an open reasoning
 *  accumulator — the last item pushed was a settled row, so no Think row is
 *  split and no `tool/result` in a later slice lacks its `tool/call`. The log
 *  head (0) is always an allowed start and is not listed. */
export function safeBoundaries(events: readonly PlanEvent[]): readonly number[] {
  const out: number[] = []
  let openTools = 0
  let reasoningOpen = false
  for (let start = 0; start <= events.length; start++) {
    if (start > 0 && openTools === 0 && !reasoningOpen) out.push(start)
    if (start === events.length) break
    const event = events[start]!
    if (event.type === 'tool/call') openTools += 1
    else if (event.type === 'tool/result') openTools = Math.max(0, openTools - 1)
    // The fold's item-pushing events settle any open reasoning accumulator:
    // user/message, assistant/message and tool/call each append an item, so a
    // later reasoning-delta starts a NEW Think row. Everything else (chunks,
    // step/turn markers, todo/write, tool/result mutations…) leaves an open
    // reasoning tail alone.
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/call') {
      reasoningOpen = false
    }
    if (isReasoningDelta(event)) reasoningOpen = true
  }
  return out
}

export interface ResumeFoldOptions {
  fastEvents?: number
  tailEvents?: number
  sliceEvents?: number
}

/** Whether a resume failure is the "session log corrupt" class (a mid-log seq
 *  gap or an unparsable committed record — the signature of a session log that
 *  two processes wrote concurrently, e.g. the web and a dsh-tui holding the
 *  same session). */
export function isCorruptLogMessage(message: string): boolean {
  return /corrupt session log/.test(message)
}

/** User-facing text for one resume failure. The corrupt-log class gets an
 *  actionable explanation (concurrent writers are the usual cause) instead of
 *  the raw harness error; everything else keeps the previous `resume:` prefix
 *  and passes the message through unchanged. */
export function describeResumeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (isCorruptLogMessage(message)) {
    return 'resume: 会话日志乱序（该会话正被并发写入：web 或另一个 dsh-tui 同时在写，或多个进程先后写过同一日志）或已损坏，无法从磁盘重放——先关闭其它持有它的进程；如确已损坏可在 /sessions 里删除后重建'
  }
  return `resume: ${message}`
}

/** Decide how to fold a resumed session of `events.length` events:
 *  - `fast` when the log is small enough for the original single pass;
 *  - `chunked` otherwise: `tailStart` names the newest slice to fold now
 *    (≥ `tailEvents` events long, cut at a safe boundary) and `olderRanges`
 *    splits everything before it into ascending safe slices of at most
 *    `sliceEvents` events. */
export function planResumeFold(
  events: readonly PlanEvent[],
  options: ResumeFoldOptions = {},
): ResumeFoldPlan {
  const fastEvents = options.fastEvents ?? HISTORY_FAST_EVENTS
  const tailEvents = options.tailEvents ?? HISTORY_TAIL_EVENTS
  const sliceEvents = options.sliceEvents ?? HISTORY_SLICE_EVENTS
  const total = events.length
  if (total <= fastEvents) return { mode: 'fast' }
  const safe = safeBoundaries(events)
  // The tail must start at a safe boundary no later than total − tailEvents so
  // the synchronous first frame covers at least `tailEvents` events; the
  // greatest such boundary keeps the tail as short as possible while still
  // meeting the budget.
  const tailFloor = total - tailEvents
  let tailStart = 0
  for (const b of safe) {
    if (b <= tailFloor) tailStart = b
    else break
  }
  if (tailStart <= 0) {
    // No safe boundary early enough for a real tail (pathological log, e.g.
    // one giant unresolved tool chain): degrade to the original single pass
    // rather than paint an empty first frame.
    return { mode: 'fast' }
  }
  // Ascending safe cuts covering [0, tailStart), each span ≤ sliceEvents.
  const olderRanges: Array<readonly [number, number]> = []
  let cursor = 0
  while (cursor < tailStart) {
    const target = Math.min(cursor + sliceEvents, tailStart)
    let next = tailStart
    for (const b of safe) {
      if (b >= target) { next = b; break }
    }
    if (next <= cursor) next = cursor + 1 // safety: always progress
    if (next > tailStart) next = tailStart
    olderRanges.push([cursor, next])
    cursor = next
  }
  return { mode: 'chunked', tailStart, olderRanges }
}
