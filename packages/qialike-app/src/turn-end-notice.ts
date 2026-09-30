/**
 * qialike — the status line a finished turn owes the user.
 *
 * `turn/end` carries a structured reason, but only `max-tokens` was ever
 * rendered; every other ending left the transcript untouched. That silence is
 * what turned a turn which died before its first model call — a runtime fault,
 * a pre-step refusal, a waking message a plugin consumed — into "submitted, no
 * response", with nothing on screen pointing at a cause. This module owns the
 * translation, so each reason either produces a visible line or is deliberately
 * quiet.
 *
 * @module @qialike/qialike-app/turn-end-notice
 */

/** The part of a `turn/end` reason this notice interprets; every other field is ignored. */
export interface TurnEndReasonLike {
  /** The `TurnEndReason` discriminant (`completed`, `aborted`, `blocked`, `error`, `max-tokens`, or a plugin's own). */
  kind?: string
  /** Present on `error`: the flattened failure facts the harness attached (`LlmFailure`). */
  error?: { message?: string; code?: string }
}

/** What the finished turn produced, as far as the transcript can tell. */
export interface TurnOutcome {
  /** The turn produced assistant text, settled or streamed. */
  textProduced: boolean
  /** The turn started at least one model step. */
  stepped: boolean
}

/** The `max-tokens` notice for a turn whose whole budget went to reasoning. */
const MAX_TOKENS_NO_TEXT = '⚠ Previous turn hit the output length cap (usually spent on reasoning) and produced no text — send any message to continue; for long tasks lower the reasoning effort with Ctrl+T.'

/** The `max-tokens` notice for a turn whose truncated output was kept. */
const MAX_TOKENS_KEPT = '⚠ Response truncated: the output token cap was reached; everything generated so far is kept — send "continue" to let the model carry on.'

/**
 * The status line a finished turn owes the user, or `undefined` when the ending
 * needs none.
 *
 * Quiet endings are `completed` after at least one step (the transcript shows
 * the work) and `aborted` (the user cancelled, and knows it). A `completed`
 * turn with neither a step nor text, a `blocked` turn, and an `error` all say
 * so: a turn that ends invisibly is indistinguishable from one that never ran.
 *
 * @param reason - the event's `reason`; an absent or unrecognized kind is quiet.
 * @param outcome - what the turn produced, used to detect an empty `completed`.
 * @returns the status text, or `undefined` for a quiet ending.
 */
export function turnEndNotice(reason: TurnEndReasonLike | undefined, outcome: TurnOutcome): string | undefined {
  switch (reason?.kind) {
    case 'max-tokens':
      return outcome.textProduced ? MAX_TOKENS_KEPT : MAX_TOKENS_NO_TEXT
    case 'error': {
      const message = reason.error?.message?.trim()
      const code = reason.error?.code?.trim()
      const detail = message === undefined || message === '' ? 'no detail reported' : message
      return `⚠ This turn failed: ${detail}${code === undefined || code === '' ? '' : ` (${code})`}`
    }
    case 'blocked':
      return '⚠ This turn was blocked before any model call: a pre-step policy refused it, so nothing was sent. The app log records the same turn/end reason.'
    case 'completed':
      return outcome.stepped || outcome.textProduced
        ? undefined
        : "⚠ This turn ended before any model call and produced no output — send it again; if it repeats, the app log holds this turn's turn/end reason."
    default:
      return undefined
  }
}
