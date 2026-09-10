/**
 * Plan-review presentation shared by the transcript and the question dock
 * (the harness `exit_plan_mode` flow).
 *
 * Data flow: the model submits a plan by calling the harness tool
 * `exit_plan_mode` with `{ plan: "<markdown>" }`. That tool pauses on a
 * user-questions review whose intent says `plan-review`. dsh-tui presents the
 * review as TWO things:
 *
 *   1. the plan itself becomes a labelled message block in the transcript
 *      (the tool-call event carries the full plan in `arguments` — live and
 *      on resume from the session log, one source);
 *   2. the dock stops showing the plan body and asks only
 *      `确认执行 / 继续规划`.
 *
 * The WIRE stays untouched: the dock answers with the ORIGINAL English option
 * labels the harness compares against (`Approve` vs everything else) — only
 * the painted text is Chinese. `intent.approve` is authoritative for which
 * option approves, never position.
 *
 * @module @yourname/dsh-tui-app/plan-review
 */

import type { AskUserQuestionItem, AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'

/** The harness tool name whose `plan` argument is the plan under review. */
export const EXIT_PLAN_TOOL = 'exit_plan_mode'

/** Is this ask-question a plan-review decision (`intent.kind === 'plan-review'`)? */
export function isPlanReview(item: { readonly intent?: AskUserQuestionItem['intent'] } | null | undefined): boolean {
  return item?.intent?.kind === 'plan-review'
}

/** Wording of the plan-review pinned question (the harness plan-mode's own EN
 *  copy, verbatim — the TUI shows the English UI). */
export const PLAN_REVIEW_QUESTION = 'Approve this plan and leave plan mode?'

/** Display labels of the plan-review options (the harness plan-mode's own EN
 *  labels, verbatim): the approve option reads {@link PLAN_REVIEW_APPROVE_LABEL},
 *  every other option {@link PLAN_REVIEW_KEEP_LABEL} (a plan-review declines
 *  with anything that is not the approve label). The STORED labels stay the
 *  harness ones — nothing here touches the answer encoding. */
export const PLAN_REVIEW_APPROVE_LABEL = 'Approve'
export const PLAN_REVIEW_KEEP_LABEL = 'Keep planning'
export function planReviewOptionLabel(item: AskUserQuestionItem, index: number): string {
  const approve = item.intent?.kind === 'plan-review' ? item.intent.approve : undefined
  const opt = item.options?.[index]
  if (approve === undefined || opt === undefined) return opt?.label ?? ''
  return opt.label === approve ? PLAN_REVIEW_APPROVE_LABEL : PLAN_REVIEW_KEEP_LABEL
}

/** The dock display shape of one question. A plan-review question is shown
 *  with its own wording, WITHOUT the plan body (the plan lives as the
 *  message block in the transcript above — the dock must stay a bare
 *  confirm/decline) and WITHOUT the "Other…" row (declining means pressing
 *  `Keep planning`; a typed opinion goes into the input as a normal message).
 *  Generic questions keep their verbatim question/detail/options/Other. */
export interface QuestionPresentation {
  /** Pinned question line(s) source (translated for plan-review). */
  readonly question: string
  /** Supporting detail (undefined for plan-review — see above). */
  readonly detail: string | undefined
  /** Option rows exactly as painted (translated for plan-review). */
  readonly options: readonly AskUserQuestionOption[]
  /** Whether the dock offers the "Other…" row (plan-review never does). */
  readonly showOther: boolean
}

export function questionPresentation(item: AskUserQuestionItem): QuestionPresentation {
  if (!isPlanReview(item)) {
    return { question: item.question, detail: item.detail, options: item.options ?? [], showOther: true }
  }
  return {
    question: PLAN_REVIEW_QUESTION,
    detail: undefined,
    options: (item.options ?? []).map((_opt, i) => ({ label: planReviewOptionLabel(item, i) })),
    showOther: false,
  }
}

/** Pull the plan markdown out of an `exit_plan_mode` tool-call raw arguments
 *  JSON string (`{"plan":"# heading\\n…"}`) — the SAME text the live event
 *  stream and a resumed session log both carry. `undefined` when the args are
 *  missing, malformed, or carry no plan. */
export function extractPlanMarkdown(argsRaw: string | undefined): string | undefined {
  if (argsRaw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const plan = (parsed as { plan?: unknown }).plan
    return typeof plan === 'string' && plan.trim() !== '' ? plan : undefined
  } catch {
    return undefined
  }
}
