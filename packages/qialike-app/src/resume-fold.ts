/**
 * Resume-history fold planning for giant sessions (qialike L1 "tail first"
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
 * @module qialike/resume-fold
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

/**
 * The events folded SYNCHRONOUSLY as the tail (the first painted frame).
 *
 * `events` is the whole log and the plan's `tailStart` is an absolute index into
 * it, so the tail is everything from `tailStart` on. A `fast` plan paints the
 * whole log in one pass and needs no slice.
 * @param plan - the fold plan.
 * @param events - the whole log.
 * @returns the events to fold into the first frame.
 */
export function tailSlice<T extends PlanEvent>(
  plan: ResumeFoldPlan,
  events: readonly T[],
): readonly T[] {
  if (plan.mode !== 'chunked') return events
  return events.slice(plan.tailStart)
}

export interface ResumeFoldOptions {
  fastEvents?: number
  tailEvents?: number
  sliceEvents?: number
}

/** Whether a resume failure is the "session log corrupt" class — a mid-log
 *  seq gap, an unparsable committed record, OR a "torn JSONL record" across a
 *  zstd frame seam. All three are the signature of a session log that another
 *  process is appending to concurrently (e.g. the web and a qialike holding
 *  the same session): the file is usually healthy and the read merely raced
 *  the writer's frame boundary. */
export function isCorruptLogMessage(message: string): boolean {
  return /corrupt( Zstandard)? session log/.test(message)
}

/** User-facing text for one resume failure. The corrupt-log class gets an
 *  actionable explanation (concurrent writers AND real mid-log damage are both
 *  possible — do not misattribute) instead of the raw harness error; everything
 *  else keeps the previous `resume:` prefix and passes the message through. */
export function describeResumeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (isCorruptLogMessage(message)) {
    return 'resume: the session log was rejected as corrupt (out of order / truncated). Two possible causes: '
      + '(1) another process is appending to the same session right now (the web UI or another qialike) and this read '
      + 'landed on a frame/record seam — a transient false positive, already retried several times; close the other '
      + 'holder and retry. (2) real seq damage — typically a tool call was interrupted and the writer resumed from a '
      + 'checkpoint without truncating the leftover lines, leaving duplicate/rewound seq numbers mid-log: replay fails '
      + 'deterministically and cannot self-heal (delete and rebuild, or remove the leftover lines by hand).'
  }
  return `resume: ${message}`
}

/** Retry options for {@link withResumeCorruptRetry}. */
export interface CorruptRetryOptions {
  /** Extra attempts after the first failure (total attempts = retries + 1). */
  retries?: number
  /** Pause between attempts (ms): a concurrent writer usually finishes the
   *  in-flight frame within a few hundred ms. */
  waitMs?: number
}

/** Run `task` (a session open/resume) and, when it fails with a corrupt-log
 *  error, wait and retry a bounded number of times before giving up. A resume
 *  that reads a session WHILE another process is appending often trips the
 *  harness reader's "torn JSONL record / seq gap" check on the frame seam
 *  even though the file is healthy — retrying after the writer advances makes
 *  those false positives disappear. Non-corrupt errors throw immediately.
 *  @param task - the resume/open call.
 *  @param options - retry count and pause (defaults: 2 extra attempts, 250 ms).
 *  @returns the task result.
 *  @throws the last error once every attempt failed. */
export async function withResumeCorruptRetry<T>(
  task: () => Promise<T>,
  options: CorruptRetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 2
  const waitMs = options.waitMs ?? 250
  let attempts = 0
  for (;;) {
    try {
      return await task()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isCorruptLogMessage(message)) throw error
      attempts += 1
      if (attempts > retries) throw error
      await new Promise<void>((resolve) => { setTimeout(resolve, waitMs) })
    }
  }
}

/** Decide how to fold a resumed session of `events.length` events:
 *  - `fast` when the log is small enough for the original single pass;
 *  - `chunked` otherwise: `tailStart` names the newest slice to fold now
 *    (≥ `tailEvents` events long, cut at a safe boundary) and `olderRanges`
 *    splits everything before it into ascending safe slices of at most
 *    `sliceEvents` events. */
/**
 * Ascending SAFE cuts covering `[0, tailStart)`, each span at most
 * `sliceEvents` — the background driver's work list.
 *
 * Extracted from {@link planResumeFold} because the file-first launch (S2 phase
 * 1) already painted the tail from the durable log, so it needs the older-range
 * list for an ALREADY-PAINTED tail without a fold plan of its own.
 * @param safe - ascending safe boundaries (see {@link safeBoundaries}).
 * @param tailStart - first event of the already-painted tail.
 * @param sliceEvents - maximum events per slice.
 * @returns the ranges, ascending (oldest first), covering `[0, tailStart)`.
 */
export function planOlderRanges(
  safe: readonly number[],
  tailStart: number,
  sliceEvents: number = HISTORY_SLICE_EVENTS,
): Array<readonly [number, number]> {
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
  return olderRanges
}

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
  return { mode: 'chunked', tailStart, olderRanges: planOlderRanges(safe, tailStart, sliceEvents) }
}
