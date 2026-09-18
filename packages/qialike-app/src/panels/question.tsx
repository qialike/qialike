/**
 * The question panel plugin (`tui-panel-question`): the in-band
 * `ask_user_question` CARD dialog. One ask request may carry several
 * questions; the card shows them ONE at a time (question-dock
 * semantics), keeps each committed answer, lets the user move back/forth
 * (←/→ or Tab), and submits the whole batch once every question is answered.
 * Each question offers single-select options plus a typeable "Other" row
 * whose editor opens INLINE under the option list — never a second dialog.
 *
 * Rendering model (mirrors the harness `.body { overflow-y:auto }` + `.option
 * { flex-wrap }`): NO content row is ever truncated. The question sentence is
 * pinned and fully soft-wrapped (a long question shows in full — never a
 * '…'), and below it a bounded body window holds the detail text plus every
 * option's fully-wrapped block. When the body is taller than the window it
 * scrolls (PgUp/PgDn), with the highlighted option kept in view. All row
 * counts come from question-layout.ts so the dock height and the conversation
 * `modalH` estimate can never drift.
 *
 * @module @yourname/qialike-app/panels-question
 */

import { Box, Text, measureElement } from 'ink'
import type { DOMElement } from 'ink'
import React from 'react'
import { spawnSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { PendingQuestion, TuiService, Store } from '../index.tsx'
import { visualWidth } from '../markdown.tsx'
import { WHEEL_STEP, dockInnerWidth } from '../config.ts'
import { theme } from '../theme.ts'
import type { RawKey } from '../stdin.ts'
import { measureDomTop, measureDomLeft } from '../list-geometry.ts'
import {
  questionBodyWindowRows,
  visualWrap,
  questionBody,
  bodyOptionRanges,
  isMultiSelect,
  optionChecked,
  QUESTION_INPUT_MAX_ROWS,
  type QuestionBodyRow,
} from '../question-layout.ts'
import { pointerRegion, composerStripRows, messageRightFor, type PointerRegion } from '../pointer-region.ts'
import { isPlanReview, questionPresentation } from '../plan-review.ts'
import { stripTerminalControls } from '../terminal-safe.ts'
import { handleDialogPaste } from '../clipboard.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-panel-question'

/** The store service (see panels/conversation.tsx). */
let store!: Store

/** Copy text to the system clipboard (pbcopy / clip / wl-copy/xclip/xsel,
 *  falling back to OSC 52) — same strategy the conversation panel uses. */
function writeClipboard(text: string): void {
  const commands: { cmd: string; args: string[] }[] =
    process.platform === 'darwin'
      ? [{ cmd: '/usr/bin/pbcopy', args: [] }]
      : process.platform === 'win32'
        ? [{ cmd: 'clip', args: [] }]
        : [{ cmd: 'wl-copy', args: [] }, { cmd: 'xclip', args: ['-selection', 'clipboard'] }, { cmd: 'xsel', args: ['-b'] }]
  for (const { cmd, args } of commands) {
    try {
      const r = spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
      if (r.status === 0 && r.error === undefined) return
    } catch { /* try the next */ }
  }
  try {
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x1b\\`)
  } catch { /* best-effort */ }
}

/** Latest measured geometry of the custom ("Other") input area: where its
 *  first visible row starts on screen and which full-input visual rows it
 *  shows (windowStart..windowStart+count-1), so mouse rows/cols map back to
 *  character indexes. Refreshed after every render of the custom input. */
let questionInputGeo: { top: number; left: number; windowStart: number; count: number; rows: { start: number; text: string }[] } | null = null

/** Latest measured geometry of the scrollable body window + the option each
 *  currently-visible body row belongs to, so hover/click can map a screen row
 *  back to the option under it (options are multi-row now; rows of a wrapped
 *  option all map to that option). */
let questionBodyGeo: { top: number; owners: number[] } | null = null

/** Latest measured geometry of the multi-question TAB BAR row (its screen row,
 *  its first visible question index, plus one horizontal column span per
 *  VISIBLE segment), so a click on a tab jumps straight to that question
 *  (dock semantics). */
let questionTabsGeo: { top: number; left: number; from: number; segs: { from: number; to: number }[] } | null = null

/** Latest measured SCREEN ROW SPAN of the whole question dock (its root Box;
 *  the dock lives IN-FLOW in the message column, right under the transcript,
 *  so its top moves with the transcript while its bottom sits above the
 *  composer). The message column rows inside this span count as "on the dock".
 *  Refreshed whenever the dock's height report lands. */
let questionDockSpan: { top: number; height: number } | null = null

/** Rightmost column (1-based, inclusive) of the MESSAGE column — the whole
 *  terminal width minus the Steps sidebar when it is drawn. Mirrors the
 *  conversation's sidebarVisibleFor/sidebarWidthFor so pointer routing never
 *  disagrees with what is actually rendered. */
function messageColumnRight(): number {
  return messageRightFor(store.width, store.sidebarMode ?? 'auto')
}

/** Pointer-region routing while the question dock is open. Re-exported (under
 *  the panel's historical names) from the shared pointer-region module the
 *  approval dock uses too — one router for both in-flow docks. */
export type QuestionPointerRegion = PointerRegion
export const questionPointerRegion = pointerRegion
export { composerStripRows }

/** Question index whose tab segment sits under the 1-based mouse (row, col),
 *  or -1 when the pointer is outside the tab bar. */
function questionTabAt(row: number, col: number): number {
  const g = questionTabsGeo
  if (g === null) return -1
  const lineIdx = Math.floor(row - 1 - g.top)
  if (lineIdx !== 0) return -1
  const x = col - 1 - g.left
  if (x < 0) return -1
  for (let i = 0; i < g.segs.length; i++) {
    const s = g.segs[i]!
    if (x >= s.from && x < s.to) return g.from + i
  }
  return -1
}

/** Column budget the tab bar keeps for its `… ` / ` …` overflow markers while
 *  a page of tabs is shown (both sides, so the window size stays stable). */
const TAB_PAGE_RESERVE = 4

/** One row of the multi-question tab bar as the dock paints it. When the
 *  labels do not fit the dock width the bar PAGES: only `visible` tabs are
 *  drawn starting at `from`, flanked by `…` markers, and ←/→ page the window
 *  (the active tab is kept in view). Pure (explicit `tabFrom`) — render, mouse
 *  mapping and tests share it; exported for tests/question-popup.test.ts. */
export function questionTabWindow(q: PendingQuestion, dockInner: number, tabFrom: number): {
  labels: string[]
  total: number
  from: number
  visible: number
  overflow: boolean
  segs: { from: number; to: number }[]
} {
  const total = q.questions.length
  // Tab headers are external text (ask_user_question): strip control bytes so
  // a header can never inject terminal sequences through the tab bar.
  const labels = q.questions.map((it, i) =>
    `${q.answers[i] === null ? '' : '✓'}${stripTerminalControls(it.header ?? String(i + 1)).slice(0, 14)}`)
  if (total <= 1) return { labels, total, from: 0, visible: total, overflow: false, segs: [] }
  const display = (i: number): string => (q.active === i ? `[${labels[i]!}]` : labels[i]!)
  const widthAll = labels.reduce((sum, _, i) => sum + visualWidth(display(i)) + (i > 0 ? 2 : 0), 0)
  const overflow = widthAll > dockInner
  const avail = overflow ? Math.max(8, dockInner - TAB_PAGE_RESERVE) : dockInner
  let visible = 0
  let w = 0
  for (let i = 0; i < labels.length; i++) {
    const add = visualWidth(display(i)) + (visible > 0 ? 2 : 0)
    if (w + add > avail) break
    w += add
    visible += 1
  }
  if (visible === 0) visible = 1 // ultra-narrow: still expose one tab
  const maxFrom = Math.max(0, total - visible)
  const from = overflow ? Math.max(0, Math.min(tabFrom, maxFrom)) : 0
  // Column spans of the painted segments (leading `… ` marker consumed when a
  // middle page is shown; separators two cells) — used for click mapping.
  const segs: { from: number; to: number }[] = []
  {
    const first = overflow ? from : 0
    const last = overflow ? from + visible : total
    let col = overflow && from > 0 ? 2 : 0
    for (let i = first; i < last; i++) {
      const width = visualWidth(display(i))
      segs.push({ from: col, to: col + width })
      col += width + (i < last - 1 ? 2 : 0)
    }
  }
  return { labels, total, from, visible, overflow, segs }
}

/** A transcript-scroll command the plan-review dock issues (keyboard only). */
export type ReviewScrollCommand = { type: 'page'; dir: -1 | 1 }

/** While the plan-review dock is up, PgUp/PgDn must roll the MESSAGE LIST
 *  behind the dock: the plan block lives in the transcript and the dock itself
 *  is a bare confirm/decline whose 2-option body never scrolls (PgUp/PgDn were
 *  dead keys while deciding). The WHEEL is deliberately NOT mapped here any
 *  more: a wheel tick is routed by the POINTER's screen region (see
 *  questionKey) — inert over the dock, scrolling the transcript only when the
 *  pointer sits on the message column outside it. Every other key (incl. ↑/↓ —
 *  option nav stays on the arrows) maps to null. Exported for
 *  tests/review-scroll.test.ts. */
export function reviewScrollCommand(k: RawKey): ReviewScrollCommand | null {
  if (k.pageUp) return { type: 'page', dir: -1 }
  if (k.pageDown) return { type: 'page', dir: 1 }
  return null
}/** Last valid caret cell while the "Other" editor is open. The measured
 *  {@link questionInputGeo} (and the input ref behind it) can briefly go null
 *  on a frame — Ink measures the element on a lag — which made {@link
 *  questionCaretCell} return null and the frame suffix flip the hardware cursor
 *  ?25h → ?25l: the "flash then disappear" on VTE. Keep the last good cell so
 *  the cursor stays put during those gaps (it only resets when the editor
 *  actually closes). */
let questionCaretCellLast: { row: number; col: number } | null = null

/** Screen cell (1-based SGR row/col) of the inline "Other" editor's caret, or
 *  null when the editor is closed / its geometry is not measured yet. The
 *  conversation frame suffix parks the REAL terminal cursor here so IME
 *  composition/candidate windows anchor next to the typed text instead of the
 *  bottom-right corner (Chinese input).
 *
 *  The caret-following window is recomputed FRESH from the CURRENT caret every
 *  read, so the caret's visual row is always inside it; the measured
 *  {@link questionInputGeo} supplies the absolute screen top/left. While the
 *  editor is open, a transient null measurement returns the LAST valid cell
 *  (never hides the cursor). */
function questionCaretCell(): { row: number; col: number } | null {
  const q = store.question
  if (q === null || !q.customMode) { questionCaretCellLast = null; return null }
  const g = questionInputGeo
  if (g === null) return questionCaretCellLast
  const inner = dockInnerWidth(store.width, store.sidebarMode ?? 'auto')
  const win = inputWindow(q.custom, inner, q.customCursor)
  const caretLineIdx = win.lines.findIndex((l) => l.caretAt !== null)
  if (caretLineIdx < 0) return questionCaretCellLast
  const line = win.lines[caretLineIdx]!
  const caretAt = line.caretAt ?? 0
  const before = line.text.slice(0, Math.max(0, caretAt))
    .split('').reduce((acc, ch) => acc + visualWidth(ch), 0)
  const cell = { row: g.top + caretLineIdx + 1, col: g.left + before + 1 }
  questionCaretCellLast = cell
  return cell
}

/** Global hook identity used by the conversation panel's frame suffix. */
function installQuestionCaretHook(active: boolean): void {
  const host = globalThis as { __dshTuiQuestionCaretCell?: (() => { row: number; col: number } | null) | null }
  if (active) host.__dshTuiQuestionCaretCell = questionCaretCell
  else if (host.__dshTuiQuestionCaretCell === questionCaretCell) host.__dshTuiQuestionCaretCell = null
}

/** Map a 1-based SGR mouse (row, col) to a character index inside the custom
 *  input, or null when the point is outside the input area. */
function inputCharAt(row: number, col: number): number | null {
  const g = questionInputGeo
  if (g === null) return null
  const lineIdx = Math.floor(row - 1 - g.top)
  if (lineIdx < 0 || lineIdx >= g.count) return null
  const visRow = g.windowStart + lineIdx
  if (visRow < 0 || visRow >= g.rows.length) return null
  const line = g.rows[visRow]!
  const x = col - 1 - g.left
  if (x <= 0) return line.start
  let acc = 0
  let idx = line.text.length
  for (let i = 0; i < line.text.length; i++) {
    if (acc >= x) { idx = i; break }
    const cw = visualWidth(line.text[i]!)
    acc += cw
    if (acc > x) { idx = i; break }
    if (acc === x) { idx = i + 1 }
  }
  return line.start + idx
}

/** Pure predicate for the dock wheel branch: does a wheel tick at the 1-based
 *  SGR mouse (row, col) scroll the inline "Other" editor? Requires BOTH that
 *  the point hovers the editor's box AND that the input overflows the ≤5-row
 *  window (more visual rows than the window shows — otherwise the wheel stays
 *  inert like everywhere else on the dock). Column containment mirrors the
 *  input box: its content spans the whole dock-inner width starting at
 *  `g.left` over `g.count` rows starting at `g.top + 1`. */
export function inputWheelScrollsAt(
  row: number,
  col: number,
  g: { top: number; left: number; count: number },
  totalRows: number,
  usable: number,
): boolean {
  if (totalRows <= g.count) return false // nothing to scroll
  const lineIdx = row - 1 - g.top
  if (lineIdx < 0 || lineIdx >= g.count) return false
  return col >= g.left + 1 && col <= g.left + usable
}

/** The `tui` service must be available to register the panel. */
export const inject = ['tui']

/** Max visible rows of the Other (custom) answer input; longer input scrolls
 *  inside the input area with the caret kept in view (composer semantics).
 *  Single source of truth with question-layout's estimate (QUESTION_INPUT_MAX_ROWS). */
const INPUT_MAX_ROWS = QUESTION_INPUT_MAX_ROWS

/** Visual (wrapped) rows of one logical line with their char offsets inside
 *  the line. */
export function wrappedSegments(line: string, usable: number): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = []
  let start = 0
  let cur = ''
  let w = 0
  for (const ch of line) {
    const cw = visualWidth(ch)
    if (w + cw > usable && cur !== '') {
      out.push({ text: cur, start })
      start += cur.length
      cur = ''
      w = 0
    }
    cur += ch
    w += cw
  }
  out.push({ text: cur, start })
  return out
}

/** Flatten the whole input into VISUAL rows (wrapped by width; empty logical
 *  lines occupy one row each) with each row's global char start. */
export function inputVisualRows(text: string, usable: number): { start: number; text: string }[] {
  const rows: { start: number; text: string }[] = []
  let globalStart = 0
  for (const seg of text.split('\n')) {
    for (const part of wrappedSegments(seg, usable)) {
      rows.push({ start: globalStart + part.start, text: part.text })
    }
    if (seg === '') rows.push({ start: globalStart, text: '' })
    globalStart += seg.length + 1
  }
  if (rows.length === 0) rows.push({ start: 0, text: '' })
  return rows
}

/** Index of the visual row containing `caret` (boundaries go to the next row;
 *  an empty row owns a caret equal to its start). */
export function caretRowIndex(rows: { start: number; text: string }[], caret: number): number {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    const rowEnd = r.start + r.text.length
    if (caret >= r.start && caret < rowEnd) return i
    if (r.text === '' && caret === r.start) return i
    if (caret === rowEnd) {
      // Boundary between two visual rows of the SAME wrapped logical line:
      // the caret belongs to the next (continuation) row, column 0.
      if (i + 1 < rows.length && rows[i + 1]!.start === rowEnd) return i + 1
      // Boundary at a REAL newline (or end of input): the caret belongs to
      // THIS row at its end, so an end-of-line caret never maps onto a
      // later/incorrect row.
      return i
    }
  }
  return rows.length - 1
}

/** New caret index after moving one VISUAL line up (-1) or down (+1),
 *  preserving the horizontal cell column; stays put at the first/last row. */
export function caretMoveVertical(text: string, caret: number, usable: number, dir: -1 | 1): number {
  const rows = inputVisualRows(text, usable)
  const from = caretRowIndex(rows, caret)
  const target = from + dir
  if (target < 0 || target >= rows.length) return caret
  // Column (cells) of the caret inside its source row.
  const src = rows[from]!
  const srcCol = src.text.slice(0, caret - src.start).split('').reduce((acc, ch) => acc + visualWidth(ch), 0)
  // Walk the target row to the same column.
  const dst = rows[target]!
  let acc = 0
  let idx = dst.text.length
  for (let i = 0; i < dst.text.length; i++) {
    const cw = visualWidth(dst.text[i]!)
    if (acc >= srcCol) { idx = i; break }
    acc += cw
    if (acc === srcCol) { idx = i + 1; break }
  }
  return dst.start + Math.min(idx, dst.text.length)
}

/** Break the full input into visual rows (char offsets are global into
 *  `text`) and locate the caret row, for the ≤5-row caret-following window. */
export function inputWindow(
  text: string,
  usable: number,
  caret: number,
): { startRow: number; lines: { text: string; start: number; caretAt: number | null }[] } {
  const rows = inputVisualRows(text, usable)
  const caretRow = caretRowIndex(rows, caret)
  // Bottom-anchored ≤5-row window keeping the caret row visible.
  const start = Math.max(0, caretRow - (INPUT_MAX_ROWS - 1))
  const end = Math.min(rows.length, start + INPUT_MAX_ROWS)
  const shown = rows.slice(start, end)
  return {
    startRow: start,
    lines: shown.map((r, idx) => {
      const isCaretRow = start + idx === caretRow
      return { text: r.text, start: r.start, caretAt: isCaretRow ? caret - r.start : null }
    }),
  }
}

/** The in-band user-question dock: header + pinned question (fully wrapped,
 *  never truncated) + a bounded scrollable body holding detail and every
 *  option's full multi-line text + the hint. Digits 1..N select directly,
 *  N+1 opens "Other". A `multiSelect` question paints an `[x]`/`[ ]` box per
 *  option row (checked rows in the success ink) and Space / digits / a click
 *  TOGGLE instead of answering — Enter commits the checked set. The body
 *  scrolls like the harness `.body` when content overflows: no option row is
 *  ever ellipsized — long options wrap and the window reveals the rest. */
function QuestionPanel(props: { question: PendingQuestion }): React.JSX.Element {
  const q = props.question
  const total = q.questions.length
  const position = q.active + 1
  const { item, index, custom, customCursor, customMode } = q
  const options = item.options ?? []
  // Plan-review: the dock title + pinned question read Chinese and the body is
  // only the two options (see questionPresentation) — the plan itself lives as
  // the labelled message block in the transcript above.
  const review = isPlanReview(item)
  const title = review ? 'Confirm the plan' : total > 1 ? `Ask question ${position}/${total}` : 'Ask question'
  const dockInner = dockInnerWidth(store.width, store.sidebarMode ?? 'auto')
  const tw = questionTabWindow(q, dockInner, store.questionTabFrom)
  const tabsRef = React.useRef<DOMElement>(null)
  // Measure the tab bar's screen row/left and its visible segments so a click
  // on a tab maps back to its question (only the CURRENT window is clickable;
  // ←/→ page the bar when it overflows).
  React.useEffect(() => {
    if (total <= 1) { questionTabsGeo = null; return }
    const el = tabsRef.current
    if (el === null) { questionTabsGeo = null; return }
    questionTabsGeo = {
      top: Math.round(measureDomTop(el)),
      left: Math.round(measureDomLeft(el)),
      from: tw.from,
      segs: tw.segs.map((s) => ({ ...s })),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measured when the bar re-renders
  }, [total, tw.overflow, tw.from, q.active, q.answers, dockInner])
  // Keep the ACTIVE tab inside the visible window: after answering/advancing
  // or jumping, page the bar so the current question's tab is always shown.
  React.useEffect(() => {
    if (total <= 1 || !tw.overflow) {
      if (store.questionTabFrom !== 0) store.setQuestionTabFrom(0)
      return
    }
    const maxFrom = Math.max(0, total - tw.visible)
    let from = Math.min(store.questionTabFrom, maxFrom)
    if (q.active < from) from = q.active
    else if (q.active >= from + tw.visible) from = Math.max(0, q.active - tw.visible + 1)
    if (from !== store.questionTabFrom) store.setQuestionTabFrom(Math.max(0, Math.min(maxFrom, from)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per active question
  }, [total, q.active, tw.overflow, tw.visible, dockInner])
  const windowRows = questionBodyWindowRows(store.rows)
  // The question sentence: FULL wrap, no cap, no '…' (requirement: a question
  // that must span several lines is shown completely). Plan-review paints its
  // own Chinese wording via questionPresentation.
  const pres = questionPresentation(item)
  // The question sentence is external text: strip control bytes before wrap.
  const qText = stripTerminalControls(pres.question)
  const questionLines = qText === '' ? [] : visualWrap(qText, dockInner)
  // Multi-select: the checked OPTION LABELS of this question — one `[x]`/`[ ]`
  // box per option row (never the "Other…" row, whose typed text is a separate
  // answer field). `undefined` on a single-select question keeps the plain
  // numbered rows.
  const multi = isMultiSelect(item)
  const checked = multi ? optionChecked(pres.options, q.picks[q.active]) : undefined
  // Body rows: detail (if any) + every option's wrapped block + Other… row
  // (plan-review drops detail and the Other row — see questionPresentation).
  const body = questionBody(pres.detail, pres.options, dockInner, pres.showOther, checked)
  const bodyRows = body.length
  const maxScroll = Math.max(0, bodyRows - windowRows)
  const scroll = Math.min(store.questionScroll, maxScroll)
  const shown = body.slice(scroll, scroll + windowRows)
  const overflow = bodyRows > windowRows
  // Plan-review: the wheel / PgUp/PgDn roll the MESSAGE LIST behind the dock
  // (the plan block), so show that affordance only when the transcript
  // actually has something to scroll (layout recorded this frame by the
  // conversation panel, which renders the dock overlay after setLayout).
  const msgScrollable = review && store.layoutContent > store.layoutViewport
  const bodyRef = React.useRef<DOMElement>(null)
  const dockRef = React.useRef<DOMElement>(null)
  // Report the dock's REAL rendered height (rows): conversation.tsx reserves
  // exactly this many transcript rows (questionH) since the dock lives IN-FLOW
  // in the message column — typing in the "Other" editor grows the dock (and
  // pushes the message history up) until its ≤5-row input window caps it.
  // Falls back to the layout estimate on the very first frame (before this
  // measurement lands).
  React.useEffect(() => {
    const report = (): void => {
      const el = dockRef.current
      if (el === null) { questionDockSpan = null; return }
      const h = Math.round(measureElement(el).height)
      store.setQuestionRows(h)
      questionDockSpan = { top: Math.round(measureDomTop(el)), height: h }
    }
    report()
    const t = setTimeout(report, 80) // layout may settle a frame after commit
    return () => clearTimeout(t)
  }, [q.active, q.customMode, q.custom, q.answers, dockInner, store.rows])
  // Custom-input windowing + mouse geometry (see inputWindow/inputCharAt).
  const customInputRef = React.useRef<DOMElement>(null)
  const inputRowsAll = inputVisualRows(custom, dockInner)
  const inputWin = inputWindow(custom, dockInner, customCursor)
  React.useEffect(() => {
    if (!customMode) { questionInputGeo = null; return }
    const el = customInputRef.current
    if (!el) { questionInputGeo = null; return }
    questionInputGeo = {
      top: Math.round(measureDomTop(el)),
      left: Math.round(measureDomLeft(el)),
      windowStart: inputWin.startRow,
      count: inputWin.lines.length,
      rows: inputRowsAll,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measured per input change
  }, [customMode, custom, customCursor, dockInner, inputWin.startRow, inputWin.lines.length, inputRowsAll])
  // While the inline "Other" editor is open, expose the editor caret cell to
  // the conversation frame suffix so the REAL terminal cursor parks there —
  // IME composition/candidate windows then anchor next to the typed text.
  React.useEffect(() => {
    installQuestionCaretHook(customMode)
    return () => installQuestionCaretHook(false)
  }, [customMode])
  // Register the BODY window's screen geometry and, for each of its currently
  // visible rows, the option it belongs to (-1 = detail/separator row), so the
  // key handler can map a mouse row to the option under it even when options
  // span multiple wrapped rows.
  React.useEffect(() => {
    const el = bodyRef.current
    if (customMode || el === null) { questionBodyGeo = null; return }
    questionBodyGeo = {
      top: Math.round(measureDomTop(el)),
      owners: shown.map((r) => r.option),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measured per scroll/render
  }, [customMode, shown, scroll, index])
  // When the dialog opens, make sure the currently highlighted option is
  // inside the visible window (an option far down a long body would otherwise
  // be highlighted but invisible until the user scrolls).
  const openedQuestion = React.useRef<unknown>(null)
  React.useEffect(() => {
    if (openedQuestion.current === props.question) return
    openedQuestion.current = props.question
    revealOption(index)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per question open
  }, [props.question])
  // When switching to another question of the card, bring the restored
  // selection into view (revealOption is a no-op while the Other editor is
  // open — the dedicated editor effect scrolls the body to its end instead).
  React.useEffect(() => {
    revealOption(index)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per active question
  }, [q.active])
  // Opening the "Other" editor scrolls the body to its END so the Other row
  // sits directly above the inline input (body rows above can still be
  // browsed with PgUp/PgDn).
  React.useEffect(() => {
    if (!customMode) return
    const q2 = store.question
    if (q2 === null) return
    const pres2 = questionPresentation(q2.item)
    const checked2 = isMultiSelect(q2.item) ? optionChecked(pres2.options, q2.picks[q2.active]) : undefined
    const b = questionBody(pres2.detail, pres2.options, dockInnerWidth(store.width, store.sidebarMode ?? 'auto'), pres2.showOther, checked2)
    const max = Math.max(0, b.length - questionBodyWindowRows(store.rows))
    if (store.questionScroll !== max) store.scrollQuestionTo(max)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per editor open
  }, [customMode])
  const rowColor = (row: QuestionBodyRow): string | undefined => {
    if (row.option === index) return theme.accent
    // A checked multi-select option is marked by its `[x]` box AND the success
    // ink (the same "answered" colour the tab bar uses).
    return checked !== undefined && row.option >= 0 && checked[row.option] === true ? theme.success : undefined
  }
  const rowInverse = (row: QuestionBodyRow): boolean => row.option === index
  // Plan-review dock = bare confirm/decline; keep its keys hint in Chinese to
  // match the 确认执行/继续规划 options.
  const hint = review
    ? `${msgScrollable ? 'wheel/PgUp/PgDn scroll · ' : ''}↑/↓ select · Enter confirm & run · Esc cancel (type an opinion in the input instead)`
    : customMode
      ? `${overflow ? 'PgUp/PgDn scroll · ' : ''}type your answer${multi ? ' (checks kept)' : ''} · Enter = answer & next · Esc close`
      : multi
        ? `${overflow ? 'PgUp/PgDn scroll · ' : ''}${
            total > 1
              ? tw.overflow
                ? '←/→ page tabs · ↑/↓ move · space / digits check · Enter answer & next · Esc cancel'
                : '↑/↓ move · space / digits check · Enter answer & next · ←/→ or click a tab · Esc cancel'
              : '↑/↓ move · space / digits check · Enter confirm · Esc cancel'
          }`
        : `${overflow ? 'PgUp/PgDn scroll · ' : ''}${
            total > 1
              ? tw.overflow
                ? '←/→ page tabs · ↑/↓ choose · Enter answer & next · digits pick · Esc cancel'
                : '↑/↓ choose · Enter answer & next · ←/→ or click a tab · digits pick · Esc cancel'
              : 'number / ↑/↓ choose · Enter confirm · Esc cancel'
          }`
  return (
    <Box ref={dockRef} flexShrink={0} marginLeft={3} marginRight={3} borderStyle="round" borderColor={theme.accent} flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.accent} bold wrap="truncate">{title}<Text dimColor> · waiting</Text></Text>
      {total > 1 && (
        <Box ref={tabsRef} flexDirection="column">
          <Text wrap="truncate">
            {tw.from > 0 && <Text dimColor>…{' '}</Text>}
            {tw.labels.slice(tw.from, tw.from + tw.visible).map((label, offset) => {
              const i = tw.from + offset
              const active = i === q.active
              const answered = q.answers[i] !== null
              const txt = active ? `[${label}]` : label
              return (
                <Text key={i} inverse={active} color={active ? theme.accent : answered ? theme.success : theme.textMuted}>
                  {(offset > 0 ? '  ' : '') + txt}
                </Text>
              )
            })}
            {tw.from + tw.visible < total && <Text dimColor>{' …'}</Text>}
          </Text>
        </Box>
      )}
      {questionLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {questionLines.map((line, i) => (
            <Text key={i} wrap="wrap">{line === '' ? ' ' : line}</Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1} ref={bodyRef}>
        {shown.map((row, i) => (
          <Text key={scroll + i} wrap="wrap"
            color={row.kind === 'detail' || row.kind === 'sep' ? undefined : rowColor(row)}
            dimColor={row.kind === 'detail'}
            inverse={rowInverse(row)}>
            {row.text === '' ? ' ' : stripTerminalControls(row.text)}
          </Text>
        ))}
      </Box>
      {customMode && (
        <>
          {/* The inline Other editor lives UNDER the option body, in the SAME
              dock — no second dialog. ≤5 visible
              rows, caret-following window (see inputWindow). The caret cell is
              the character under it shown inverse (same width, no reflow); an
              end-of-input caret appends an inverted NBSP block. A live mouse
              selection (drag) inverts the selected span instead.
              Linux/Windows/macOS paint inverse as a solid block — the real
              terminal cursor is hidden inside the overlay. */}
          <Text color={theme.accent} wrap="truncate">✎ your answer</Text>
          <Box ref={customInputRef} flexDirection="column">
            {inputWin.lines.map((line, i) => {
              const sel = props.question.sel
              const sLocal = sel === null ? -1 : Math.max(0, sel.from - line.start)
              const eLocal = sel === null ? -1 : Math.min(line.text.length, sel.to - line.start)
              const selected = sel !== null && sLocal < eLocal
              return (
                <Text key={i} color={theme.primary} wrap="truncate">
                  {selected
                    ? (
                      <>
                        {line.text.slice(0, sLocal)}
                        <Text inverse>{line.text.slice(sLocal, eLocal)}</Text>
                        {line.text.slice(eLocal)}
                      </>
                    )
                    : line.caretAt === null
                      ? line.text
                      : (
                        <>
                          {line.text.slice(0, line.caretAt)}
                          <Text inverse>{line.text[line.caretAt] ?? '\u00a0'}</Text>
                          {line.text.slice(line.caretAt + 1)}
                        </>
                      )}
                </Text>
              )
            })}
          </Box>
        </>
      )}
      <Box marginTop={1}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  )
}

/** Option index currently hovered by the mouse (from the registered body
 *  geometry), or -1 when the pointer is over a non-option row (detail,
 *  separator) or outside the window. */
function optionFromRow(row: number): number {
  const g = questionBodyGeo
  if (g === null) return -1
  const idx = Math.floor(row - 1 - g.top)
  if (idx < 0 || idx >= g.owners.length) return -1
  return g.owners[idx]!
}

/** Scroll the body window so the given option's whole wrapped block is in
 *  view (selection-follow for ↑/↓/digits/hover/click; no-op when everything
 *  fits). */
function revealOption(index: number): void {
  const q = store.question
  if (q === null || q.customMode) return
  const options = q.item.options ?? []
  const pres = questionPresentation(q.item)
  const dockInner = dockInnerWidth(store.width, store.sidebarMode ?? 'auto')
  const checked = isMultiSelect(q.item) ? optionChecked(pres.options, q.picks[q.active]) : undefined
  const body = questionBody(pres.detail, pres.options, dockInner, pres.showOther, checked)
  const windowRows = questionBodyWindowRows(store.rows)
  const maxScroll = Math.max(0, body.length - windowRows)
  const ranges = bodyOptionRanges(body, options.length)
  const r = ranges[index]
  if (r === undefined || r.start < 0) return
  // Desired window top: if the block is shorter than the window, show it
  // fully (top-aligned when it starts above, bottom-aligned when below);
  // taller blocks keep their start in view.
  let top: number
  if (r.end - r.start <= windowRows) {
    const current = Math.min(store.questionScroll, maxScroll)
    if (r.start < current) top = r.start
    else if (r.end > current + windowRows) top = Math.max(0, r.end - windowRows)
    else top = current
  } else {
    top = r.start
  }
  if (top !== Math.min(store.questionScroll, maxScroll)) {
    store.scrollQuestionTo(Math.min(top, maxScroll))
  }
}

/** Handle one key while the question panel is active; returns true (consumed).
 *  The dock is a card over the whole ask: answering a question commits it and
 *  moves to the next (or submits when all are answered); ←/→ (or Tab) move
 *  between questions freely; selecting the "Other…" row opens its inline
 *  editor UNDER the option list (no second dialog); Esc cancels the whole ask
 *  (closing the inline editor first when it is open). On a `multiSelect`
 *  question Space / digits / a click check an option and Enter is the only
 *  commit, so several options can be checked before advancing.
 *
 *  Mouse & wheel events are FIRST routed by the pointer's screen region (see
 *  the pointer block below): on the dock they drive the dock only (wheel is
 *  inert — the ONE exception: the inline "Other" editor, where the wheel
 *  scrolls the ≤5-row input window when its content overflows); on the message
 *  column outside the dock they act on the message box (wheel scrolls the
 *  transcript, press/drag/release select & copy — the same behaviour as on the
 *  normal surface); outside the message column (Steps sidebar) nothing
 *  responds. */function questionKey(k: RawKey, tui: TuiService): boolean {
  const char = k.char ?? ''
  const question = store.question
  if (question === null) { store.setPanel('conversation'); return true }
  const options = question.item.options ?? []
  const optsLen = options.length
  // Plan-review: the dock is a bare confirm/decline — no "Other" row, no
  // free-text editor (an opinion goes into the composer as a normal message).
  const review = isPlanReview(question.item)
  // ── Pointer routing by screen region (mouse + wheel). The dock is an
  //    IN-FLOW block in the message column (right under the transcript); what
  //    a mouse event means depends on where the pointer is:
  //    · ON the dock rows — only BUTTONS drive the dock (tab / option / the
  //      inline editor, handled below); the WHEEL is inert there (it must
  //      neither bump the choice nor roll the message behind the dock) — save
  //      for the ONE exception below: hovering the "Other" editor whose
  //      content overflows its ≤5-row window scrolls that input (see the dock
  //      wheel branch).
  //    · On the MESSAGE COLUMN outside the dock AND above the composer — the
  //      event acts on the MESSAGE BOX exactly as on the normal surface: the
  //      wheel scrolls the transcript, press/drag/release select & copy.
  //      Those keys are forwarded to the conversation panel's own handler
  //      (single source of truth — no duplicated selection/copy logic here).
  //    · On the COMPOSER's rows (the box at the very bottom, below the dock) —
  //      same surface behaviour as the message column: the wheel scrolls the
  //      transcript and press/drag/release EDIT THE DRAFT (caret / selection /
  //      copy) exactly as on the normal surface. Those keys are forwarded to
  //      the conversation handler too.
  //    · Outside the message column (the Steps sidebar…) — no response.
  const ptr = k.mousePress ?? k.mouseDrag ?? k.mouseMove ?? k.mouseRelease
  const wheelUp = k.wheelUp
  const wheelDown = k.wheelDown
  const ptrRow = ptr?.row ?? wheelUp?.row ?? wheelDown?.row
  const ptrCol = ptr?.col ?? wheelUp?.col ?? wheelDown?.col
  if (ptrRow !== undefined && ptrCol !== undefined) {
    const msgRight = messageColumnRight()
    const region = questionPointerRegion(ptrRow, ptrCol, questionDockSpan, msgRight,
      composerStripRows(store.width, store.rows, store.input, store.composerImage !== null, msgRight))
    if (region === 'none') return true // outside the message column: ignore the mouse event
    if (region === 'dock') {
      // Wheel over the dock: inert EXCEPT on the "Other" input box when its
      // content overflows the ≤5-row window — there the wheel scrolls the box
      // (visual-line caret moves, exactly like ↑/↓) so a long answer can be
      // paged inside the input. Button events fall through to the dock logic
      // below (tabs, options, the inline editor).
      if (wheelUp !== undefined || wheelDown !== undefined) {
        if (question.customMode && questionInputGeo !== null) {
          const usable = dockInnerWidth(store.width, store.sidebarMode ?? 'auto')
          if (inputWheelScrollsAt(ptrRow, ptrCol, questionInputGeo, questionInputGeo.rows.length, usable)) {
            const dir: -1 | 1 = wheelUp !== undefined ? -1 : 1
            store.questionCursorTo(caretMoveVertical(question.custom, question.customCursor, usable, dir))
          }
        }
        return true
      }
    } else {
      // Message column outside the dock (message rows AND the composer strip
      // below the dock): act on the surface exactly as when no dock is open —
      // wheel scrolls the transcript, everything else is forwarded to the
      // conversation panel's own handler (single source of truth: composer
      // caret/selection/copy, transcript select/copy, tool-row clicks…).
      if (wheelUp !== undefined) { store.scrollLines(-WHEEL_STEP); return true }
      if (wheelDown !== undefined) { store.scrollLines(WHEEL_STEP); return true }
      const conv = tui.panels.byId('conversation')
      if (conv !== undefined && conv.handleKey !== undefined) conv.handleKey(k, store)
      return true
    }
  }
  // Clicking a question TAB (multi-question card) jumps straight to it —
  // handled before every other mouse mapping (tab bar is the top row).
  const pressTab = k.mousePress === undefined ? -1 : questionTabAt(k.mousePress.row, k.mousePress.col)
  const releaseTab = k.mouseRelease === undefined ? -1 : questionTabAt(k.mouseRelease.row, k.mouseRelease.col)
  if (pressTab >= 0 || releaseTab >= 0) {
    store.questionJump(pressTab >= 0 ? pressTab : releaseTab)
    return true
  }
  // Custom ("Other") input mouse: click positions the caret, drag selects
  // (highlighted), release copies the selection. Only mapped when the click
  // lands inside the measured input area; other mouse events are consumed.
  if (question.customMode && questionInputGeo !== null) {
    if (k.mousePress) {
      const at = inputCharAt(k.mousePress.row, k.mousePress.col)
      if (at !== null) store.questionMousePress(at)
      return true
    }
    if (k.mouseDrag) {
      const at = inputCharAt(k.mouseDrag.row, k.mouseDrag.col)
      if (at !== null) store.questionMouseDrag(at)
      return true
    }
    if (k.mouseMove) return true
    if (k.mouseRelease) {
      const range = store.questionMouseEnd()
      const at = inputCharAt(k.mouseRelease.row, k.mouseRelease.col)
      if (at !== null) store.questionCursorTo(at)
      if (range !== null && range.from !== range.to) {
        const text = question.custom.slice(range.from, range.to)
        if (text !== '') {
          writeClipboard(text)
          store.flashStatus(`copied ${text.length} chars`)
        }
      }
      return true
    }
  }
  // Mouse in the question dock: consume the press (no selection) and a left-click
  // anchors on the clicked option, then answers it (like Enter). Hover
  // (no-button motion) highlights the option under the cursor via the
  // registered body-window geometry (multi-row options map every row of their
  // block back to the option).
  if (k.mousePress) return true
  if (k.mouseMove) {
    if (!question.customMode) {
      const owner = optionFromRow(k.mouseMove.row)
      if (owner >= 0) store.setQuestionIndex(owner)
    }
    return true
  }
  if (k.mouseRelease) {
    if (store.mouseRelease(k.mouseRelease.row, k.mouseRelease.col) === 'click') {
      // A click only acts when it lands on a real OPTION row (answers it —
      // like Enter; on a multi-select question it CHECKS it instead, like
      // Space). Clicks anywhere else — including a stray click on the
      // question text / detail / background — are consumed and keep the dock
      // open: only Esc cancels the whole ask.
      if (!question.customMode) {
        const owner = optionFromRow(k.mouseRelease.row)
        if (owner >= 0 && owner <= optsLen) {
          if (isMultiSelect(question.item) && owner < optsLen) store.toggleQuestionPick(owner)
          else {
            store.setQuestionIndex(owner)
            store.questionEnter()
          }
        }
      }
    }
    return true
  }
  if (question.customMode) {
    // Inline "Other" editor (under the option list): Enter commits the text
    // and moves on, Alt+Enter inserts a newline, arrows/Home/End move the
    // caret, Backspace/Delete delete, Ctrl+U clears to the current line start,
    // Ctrl+C clears the input (kept open), Esc discards the typed text and
    // closes the editor (stays on this question; Esc there cancels the ask).
    if (k.return) store.questionEnter()
    else if (char === '\n' || k.altEnter) store.questionType('\n')
    else if (k.escape) store.questionCloseEditor()
    else if (k.ctrl && char === 'c') store.questionClearInput()
    else if (k.ctrl && char === 'u') store.questionCtrlU()
    else if (k.leftArrow) store.questionCursorLeft()
    else if (k.rightArrow) store.questionCursorRight()
    else if (k.upArrow) {
      // Visual-line caret movement: one line up, preserving the column.
      store.questionCursorTo(caretMoveVertical(question.custom, question.customCursor, dockInnerWidth(store.width, store.sidebarMode ?? 'auto'), -1))
    } else if (k.downArrow) {
      store.questionCursorTo(caretMoveVertical(question.custom, question.customCursor, dockInnerWidth(store.width, store.sidebarMode ?? 'auto'), 1))
    } else if (k.home) {
      // Home: start of the current LOGICAL line.
      const nl = question.custom.lastIndexOf('\n', question.customCursor - 1)
      store.questionCursorTo(nl + 1)
    } else if (k.end) {
      // End: end of the current LOGICAL line (before its newline, if any).
      const nl = question.custom.indexOf('\n', question.customCursor)
      store.questionCursorTo(nl === -1 ? question.custom.length : nl)
    } else if (k.backspace) {
      store.questionBackspace()
    } else if (k.delete) {
      store.questionDelete()
    } else if (handleDialogPaste(k, store, (text) => store.questionType(text), { maxChars: 8192 })) {
      return true
    } else if (char) {
      store.questionType(char)
    }
    return true
  }
  // Plan-review: the KEYBOARD scrolls the TRANSCRIPT (the plan block above the
  // dock) instead of the option body — reviewScrollCommand maps PgUp/PgDn (the
  // wheel is already routed by the pointer region above, so a tick over the
  // dock stays inert and one over the message column scrolls the transcript);
  // ↑/↓ below still move the confirm/decline choice.
  if (review) {
    const cmd = reviewScrollCommand(k)
    if (cmd !== null) {
      store.scrollPage(cmd.dir)
      return true
    }
  }
  if (k.upArrow) { store.bumpQuestionIndex(-1); revealOption(question.index) }
  else if (k.downArrow) { store.bumpQuestionIndex(1); revealOption(question.index) }
  else if (k.pageUp) store.scrollQuestion(-questionBodyWindowRows(store.rows))
  else if (k.pageDown) store.scrollQuestion(questionBodyWindowRows(store.rows))
  else if (k.leftArrow || k.rightArrow) {
    // When the tab bar overflows the dock width ←/→ PAGE the bar (the active
    // tab stays in view); otherwise they switch between questions.
    const tw = questionTabWindow(question, dockInnerWidth(store.width, store.sidebarMode ?? 'auto'), store.questionTabFrom)
    if (tw.overflow) {
      const step = Math.max(1, tw.visible - 1)
      store.setQuestionTabFrom(tw.from + (k.rightArrow ? step : -step))
    } else {
      store.questionGo(k.leftArrow ? -1 : 1)
    }
  }
  else if (k.tab) store.questionGo(1)
  else if (k.return) store.questionEnter()
  else if (/^[1-9]$/.test(char)) {
    // Number keys answer the numbered option directly (1..N); N+1 = Other
    // (plan-review has no Other row, so N+1 is ignored there). On a
    // multi-select question 1..N CHECK that option instead of answering (a
    // digit must not commit, or several could never be checked); N+1 still
    // opens the Other editor.
    const digit = Number(char)
    if (digit <= optsLen + 1 && (!review || digit <= optsLen)) {
      if (isMultiSelect(question.item) && digit <= optsLen) store.toggleQuestionPick(digit - 1)
      else {
        store.setQuestionIndex(digit - 1)
        store.questionEnter()
      }
    }
  }
  else if (char === ' ' && isMultiSelect(question.item)) {
    // Space is the toggle key of a multi-select question (typing a literal
    // space is meaningless in answer text): it checks the highlighted option,
    // and on the "Other…" row it opens the inline editor instead — a space
    // there would otherwise become the first typed character.
    if (question.index < optsLen) store.toggleQuestionPick(question.index)
    else store.setQuestionCustom('', true)
  }
  else if (k.escape || (k.ctrl && char === 'c')) store.cancelQuestion()
  else if (char && !review) store.setQuestionCustom(char, true)
  return true
}

/** Register the question overlay panel. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  tui.panels.register({
    id: 'question',
    mode: 'overlay',
    render: () => (store.question === null ? null : <QuestionPanel question={store.question} />),
    handleKey: (k) => questionKey(k, tui),
  })
}
