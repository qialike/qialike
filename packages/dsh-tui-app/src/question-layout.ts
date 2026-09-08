/**
 * Shared layout math for the in-band user-question dock (`tui-panel-question`).
 *
 * The dock is a flex child of the conversation's message column, so its
 * RENDERED height must exactly equal the `modalH` estimate conversation.tsx
 * reserves (questionH). Both sides therefore derive every row count from these
 * pure functions — never duplicated constants — so the two can't drift:
 *
 *   - `visualWrap` — the exact row-splitting the renderer uses (one terminal
 *     row per string; wide chars count two columns);
 *   - `questionBody` — the dock's scrollable body (detail + every option's
 *     fully-wrapped block + the "Other…" row) as pre-wrapped rows, with one
 *     blank separator between the detail block and the options block;
 *   - `questionDockRows` — the FULL dock row count (chrome + the pinned
 *     question + the bounded body window or the custom-answer block + hint).
 *
 * Layout contract (mirrors the harness `.body { overflow-y:auto }`): the dock
 * never ellipsizes an option row. Long options wrap across rows, and when the
 * body is taller than `questionBodyWindowRows`, the dock keeps that fixed
 * window size and scrolls inside it (PgUp/PgDn + selection follow) so every
 * option row is reachable — never cut with '…'.
 *
 * @module @yourname/dsh-tui-app/question-layout
 */

import { visualWidth } from './markdown.tsx'

/** Max rows of the dock's scrollable body window. Reserve `rows - 25` for
 *  composer + status + a minimum transcript viewport (same spirit as the old
 *  detail window's `rows - 25` budget), capped to keep very tall terminals
 *  from swallowing the whole screen. */
export function questionBodyWindowRows(terminalRows: number): number {
  return Math.max(3, Math.min(10, terminalRows - 25))
}

/** Split one logical line into visual rows at `usable` columns — the same
 *  per-character width rule the renderer relies on (wide chars count two), so
 *  `rows.length` is the terminal row count Ink will paint for the text. */
export function visualWrap(text: string, usable: number): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    if (raw === '') { out.push(''); continue }
    let cur = ''
    let w = 0
    for (const ch of raw) {
      const cw = visualWidth(ch)
      if (w + cw > usable && cur !== '') {
        out.push(cur)
        cur = ''
        w = 0
      }
      cur += ch
      w += cw
    }
    out.push(cur)
  }
  return out
}

/** Number of terminal rows `text` occupies after the renderer's own wrapping
 *  (an empty logical line still occupies one row). */
export function visualRowCount(text: string, usable: number): number {
  return text.split('\n').reduce((sum, seg) => sum + visualWrap(seg, usable).length, 0)
}

/** One pre-wrapped row of the dock body. `option` is the selectable index
 *  (0..options.length, where `options.length` is the "Other…" row) or -1 for
 *  detail/separator rows. */
export interface QuestionBodyRow {
  readonly kind: 'detail' | 'option' | 'other' | 'sep'
  readonly text: string
  readonly option: number
}

/** An `ask_user_question` option exactly as the panel renders it: the number
 *  prefix is part of the wrapped paragraph, and the description (when present)
 *  hangs on the same line(s) after an em dash. */
export function optionText(index: number, label: string, description?: string): string {
  return `${index + 1}. ${label}${description !== undefined ? ` — ${description}` : ''}`
}

/** Build the dock's scrollable body: the detail block (dim), then every option
 *  fully soft-wrapped (each option a contiguous block of rows so the selection
 *  highlight spans the whole option), then — unless `includeOther` is false
 *  (plan-review: a bare confirm/decline dock, no free-text row) — the "Other…"
 *  row. One blank row separates the detail block from the options block
 *  (mirrors the margin the old layout used); blanks are ordinary content rows
 *  and scroll along. */
export function questionBody(
  detail: string | undefined,
  options: readonly { readonly label: string; readonly description?: string }[],
  dockInner: number,
  includeOther = true,
): QuestionBodyRow[] {
  const rows: QuestionBodyRow[] = []
  const dText = detail ?? ''
  const dRows = dText === '' ? [] : visualWrap(dText, dockInner)
  const optRows: QuestionBodyRow[] = []
  for (let i = 0; i < options.length; i++) {
    const o = options[i]!
    for (const line of visualWrap(optionText(i, o.label, o.description), dockInner)) {
      optRows.push({ kind: 'option', text: line, option: i })
    }
  }
  if (includeOther) {
    for (const line of visualWrap(optionText(options.length, 'Other…'), dockInner)) {
      optRows.push({ kind: 'other', text: line, option: options.length })
    }
  }
  if (dRows.length > 0) {
    for (const text of dRows) rows.push({ kind: 'detail', text, option: -1 })
    rows.push({ kind: 'sep', text: ' ', option: -1 })
  }
  rows.push(...optRows)
  return rows
}

/** [start, end) row span of every selectable entry (0..options.length) inside
 *  the body built by `questionBody`, for selection-follow scrolling and for
 *  mapping a mouse row to the option under it. */
export function bodyOptionRanges(
  body: readonly QuestionBodyRow[],
  optionsLength: number,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  for (let i = 0; i <= optionsLength; i++) ranges.push({ start: -1, end: -1 })
  let start = -1
  let current = -1
  body.forEach((row, idx) => {
    if (row.option !== current) {
      if (current >= 0 && start >= 0) ranges[current] = { start, end: idx }
      current = row.option
      start = idx
    }
  })
  if (current >= 0 && start >= 0) ranges[current] = { start, end: body.length }
  return ranges
}

/** Max visible rows of the custom ("Other") answer input; longer input scrolls
 *  inside the input area with the caret kept in view (composer semantics). */
export const QUESTION_INPUT_MAX_ROWS = 5

/** Visible rows of the custom answer input — the caret-following window never
 *  exceeds QUESTION_INPUT_MAX_ROWS and hugs short content. Counts rows exactly
 *  like question.tsx's `inputVisualRows` (each empty logical line contributes
 *  its wrapped row plus one caret row — the same rule the input window uses),
 *  so the dock-height estimate and the painted rows never drift. */
export function customInputRows(text: string, usable: number): number {
  const rows = text.split('\n').reduce((sum, seg) => sum + visualWrap(seg, usable).length + (seg === '' ? 1 : 0), 0)
  return Math.min(QUESTION_INPUT_MAX_ROWS, rows)
}

/** EXACT dock row count for the question panel — the number conversation.tsx
 *  reserves as questionH (the dock lives IN-FLOW in the message column, so a
 *  mismatch would compress the transcript by the wrong amount) AND the number
 *  the panel paints. The dock is a per-question card of a possibly
 *  multi-question ask:
 *  with more than one question a TAB BAR row (one segment per question, click
 *  to jump — opencode dock style) sits right under the title; then the pinned
 *  question + the bounded option body; when the "Other" row is being answered
 *  the ≤5-row inline editor sits directly UNDER that body (same dock — no
 *  second dialog). Structure (each margin is 1 row, mirroring how Ink lays the
 *  dock out):
 *
 *  border 2 + padding 2
 *  + title 1
 *  + tab bar 1 (only when the ask carries >1 question)
 *  + pinned question block: margin 1 + fully-wrapped question rows (never
 *    truncated — a long question is shown in full, exactly as requested)
 *  + body window: margin 1 + min(body rows, window rows)
 *  + OTHER-editor open: label 1 + input rows (≤5) directly under the body
 *  + hint: margin 1 + 1
 */
export function questionDockRows(
  question: string | undefined,
  detail: string | undefined,
  options: readonly { readonly label: string; readonly description?: string }[],
  customMode: boolean,
  customText: string,
  dockInner: number,
  terminalRows: number,
  showTabs = false,
  includeOther = true,
): number {
  const windowRows = questionBodyWindowRows(terminalRows)
  const qRows = question === undefined || question === '' ? 0 : visualRowCount(question, dockInner)
  const chrome = 4 + 1 + 1 + 1 // border 2 + padding 2, title 1, hint margin 1, hint 1
  const qBlock = qRows > 0 ? 1 + qRows : 0
  const body = questionBody(detail, options, dockInner, includeOther)
  const shown = Math.min(body.length, windowRows)
  let rows = chrome + (showTabs ? 1 : 0) + qBlock + 1 + shown
  if (customMode) {
    // The Other editor is ONE extra block (label + caret window) under the
    // body — the options stay visible above it (opencode dock semantics).
    rows += 1 + customInputRows(customText, dockInner)
  }
  return rows
}
