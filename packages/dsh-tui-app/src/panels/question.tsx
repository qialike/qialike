/**
 * The question panel plugin (`tui-panel-question`): the in-band
 * `ask_user_question` dialog (single-select options plus a typeable "Other"
 * row). Registers the `question` overlay panel against the `tui` service.
 *
 * @module @yourname/dsh-tui-app/panels-question
 */

import { Box, Text } from 'ink'
import type { DOMElement } from 'ink'
import React from 'react'
import { spawnSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { PendingQuestion, TuiService, Store } from '../index.tsx'
import { visualWidth, truncateWide } from '../markdown.tsx'
import { dockInnerWidth } from '../config.ts'
import { theme } from '../theme.ts'
import type { RawKey } from '../stdin.ts'
import { useListGeometry, dialogListIndexFromRow, measureDomTop, measureDomLeft } from '../list-geometry.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-panel-question'

/** Max wrapped rows the question sentence itself may occupy before being
 *  truncated (kept in sync with the conversation's modalH estimate: a verbose
 *  model dumping long text into `question` must not inflate the dock; long
 *  content belongs in the scrollable `detail` window). */
const questionCapLines = 6

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

/** The `tui` service must be available to register the panel. */
export const inject = ['tui']

/** Max detail rows shown inside the dock window (kept in sync with the
 *  conversation's modalH estimate: window ≤ rows - 25 so composer + status
 *  + a minimum transcript viewport still fit). */
function detailWindowRows(rows: number): number {
  return Math.max(2, Math.min(10, rows - 25))
}

/** Max VISIBLE rows of the Other (custom) answer input; longer input scrolls
 *  inside the input area with the caret kept in view (composer semantics). */
const INPUT_MAX_ROWS = 5

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

/** Split text into visual lines wrapped at `usable` columns, using the same
 *  per-character width rule as the renderer (wide chars count two). */
function wrapVisualLines(text: string, usable: number): string[] {
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

/** The in-band user-question dock: header + question + numbered selectable
 *  options (digits 1..N select directly, N+1 = "Other"), docked above the
 *  composer and rendered inside the message column like the approval dock.
 *  A long `detail` (e.g. a plan review) is shown in a bounded window that
 *  scrolls with PgUp/PgDn so the full text stays reviewable. */
function QuestionPanel(props: { question: PendingQuestion }): React.JSX.Element {
  const { item, index, custom, customCursor, customMode, position, total } = props.question
  const options = item.options ?? []
  const title = total !== undefined && total > 1 ? `Ask question ${position ?? 1}/${total}` : 'Ask question'
  const dockInner = dockInnerWidth(store.width)
  const windowRows = detailWindowRows(store.rows)
  const detailLines = item.detail === undefined || item.detail === ''
    ? []
    : wrapVisualLines(item.detail, dockInner)
  const detailOverflow = detailLines.length > windowRows
  const maxScroll = Math.max(0, detailLines.length - windowRows)
  const scroll = Math.min(store.questionScroll, maxScroll)
  const shown = detailLines.slice(scroll, scroll + windowRows)
  const questionText = item.question ?? ''
  const questionAll = questionText === '' ? [] : wrapVisualLines(questionText, dockInner)
  const questionLines = questionAll.slice(0, questionCapLines)
  const questionTruncated = questionAll.length > questionCapLines
  const listRef = React.useRef<DOMElement>(null)
  // The selectable options (+ the "Other…" row) form a vertical list; register
  // its geometry so mouse hover/click can map a screen row to an option index.
  useListGeometry(listRef, options.length + 1, 1, [options.length, index, customMode])
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
  return (
    <Box flexShrink={0} marginLeft={3} marginRight={3} borderStyle="round" borderColor={theme.accent} flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.accent} bold wrap="truncate">{title}<Text dimColor> · waiting</Text></Text>
      {questionLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {questionLines.map((line, i) => (
            <Text key={i} wrap="truncate">
              {questionTruncated && i === questionLines.length - 1
                ? truncateWide(line + '…', dockInner)
                : line}
            </Text>
          ))}
        </Box>
      )}
      {detailLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {shown.map((line, i) => (
            <Text key={scroll + i} wrap="wrap" dimColor>{line === '' ? ' ' : line}</Text>
          ))}
        </Box>
      )}
      {customMode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.accent} wrap="truncate">Your answer:</Text>
          {/* ≤5 visible rows, caret-following window (see inputWindow). The
              caret cell is the character under it shown inverse (same width,
              no reflow); an end-of-input caret appends an inverted NBSP block.
              A live mouse selection (drag) inverts the selected span instead.
              Linux/Windows/macOS paint inverse as a solid block — the real
              terminal cursor is hidden inside the overlay. */}
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
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1} ref={listRef}>
          {options.map((opt, i) => (
            <Text key={i} wrap="truncate" color={i === index ? theme.accent : undefined} inverse={i === index}>
              {i + 1}. {opt.label}{opt.description !== undefined ? ` — ${opt.description}` : ''}
            </Text>
          ))}
          <Text wrap="truncate" color={options.length === index ? theme.accent : undefined} inverse={options.length === index}>
            {options.length + 1}. Other…
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{customMode
          ? 'type your answer · Enter confirm · Esc cancel'
          : `${detailOverflow ? 'PgUp/PgDn scroll · ' : ''}number / ↑/↓ choose · Enter confirm · Esc cancel`}</Text>
      </Box>
    </Box>
  )
}

/** Handle one key while the question panel is active; returns true (consumed). */
function questionKey(k: RawKey): boolean {
  const char = k.char ?? ''
  const question = store.question
  if (question === null) { store.setPanel('conversation'); return true }
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
  // anchors on the clicked option, then runs the current highlight (== Enter) by
  // re-dispatching as a return key. Hover (no-button motion) highlights the option
  // under the cursor via the registered list geometry.
  if (k.mousePress) return true
  if (k.mouseMove) {
    if (!question.customMode) {
      const idx = dialogListIndexFromRow(k.mouseMove.row)
      if (idx >= 0) store.setQuestionIndex(idx)
    }
    return true
  }
  if (k.mouseRelease) {
    if (store.mouseRelease(k.mouseRelease.row, k.mouseRelease.col) === 'click') {
      // A click only acts when it lands on a real OPTION row (highlights it and
      // confirms, like Enter). Clicks anywhere else — including a stray click
      // on the question text / background, left or right button — are consumed
      // and keep the popup open: only Esc cancels it.
      if (!question.customMode) {
        const idx = dialogListIndexFromRow(k.mouseRelease.row)
        if (idx >= 0 && idx <= (question.item.options?.length ?? 0)) {
          store.setQuestionIndex(idx)
          return questionKey({ return: true } as RawKey)
        }
      }
    }
    return true
  }
  if (question.customMode) {
    // Composer-like editing in the "Other" input: Enter submits, Alt+Enter
    // inserts a newline, arrows/Home/End move the caret, Backspace/Delete
    // delete, Ctrl+U clears to the current line start, Ctrl+C clears the input
    // (kept open), Esc cancels.
    if (k.return) {
      const custom = question.custom.trim()
      store.clearQuestion()
      question.resolve({ id: question.item.id, selected: [], custom: custom === '' ? undefined : custom })
    } else if (char === '\n' || k.altEnter) {
      store.questionType('\n')
    } else if (k.escape) {
      const rejectFn = question.reject; store.clearQuestion(); rejectFn(new Error('ask_user_question was cancelled'))
    } else if (k.ctrl && char === 'c') {
      store.questionClearInput()
    } else if (k.ctrl && char === 'u') {
      store.questionCtrlU()
    } else if (k.leftArrow) {
      store.questionCursorLeft()
    } else if (k.rightArrow) {
      store.questionCursorRight()
    } else if (k.upArrow) {
      // Visual-line caret movement: one line up, preserving the column.
      store.questionCursorTo(caretMoveVertical(question.custom, question.customCursor, dockInnerWidth(store.width), -1))
    } else if (k.downArrow) {
      store.questionCursorTo(caretMoveVertical(question.custom, question.customCursor, dockInnerWidth(store.width), 1))
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
    } else if (char) {
      store.questionType(char)
    }
    return true
  }
  if (k.upArrow) store.bumpQuestionIndex(-1)
  else if (k.downArrow) store.bumpQuestionIndex(1)
  else if (k.wheelUp) store.bumpQuestionIndex(-1)
  else if (k.wheelDown) store.bumpQuestionIndex(1)
  else if (k.pageUp) store.scrollQuestion(-5)
  else if (k.pageDown) store.scrollQuestion(5)
  else if (k.return) {
    const options = question.item.options ?? []
    if (question.index < options.length && options[question.index]) {
      const label = options[question.index].label
      store.clearQuestion()
      question.resolve({ id: question.item.id, selected: [label] })
    } else {
      store.setQuestionCustom('', true)
    }
  }
  else if (/^[1-9]$/.test(char)) {
    // Number keys pick the numbered option directly (1..N); N+1 opens "Other".
    const digit = Number(char)
    const options = question.item.options ?? []
    if (digit <= options.length + 1) {
      if (digit <= options.length && options[digit - 1]) {
        const label = options[digit - 1].label
        store.clearQuestion()
        question.resolve({ id: question.item.id, selected: [label] })
      } else {
        store.setQuestionCustom('', true)
      }
    }
  }
  else if (k.escape || (k.ctrl && char === 'c')) {
    const rejectFn = question.reject; store.clearQuestion(); rejectFn(new Error('ask_user_question was cancelled'))
  }
  else if (char) {
    store.setQuestionCustom(char, true)
  }
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
    handleKey: (k) => questionKey(k),
  })
}
