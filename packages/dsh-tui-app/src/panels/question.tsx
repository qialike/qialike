/**
 * The question panel plugin (`tui-panel-question`): the in-band
 * `ask_user_question` dialog (single-select options plus a typeable "Other"
 * row). Registers the `question` overlay panel against the `tui` service.
 *
 * @module @yourname/dsh-tui-app/panels-question
 */

import { Box, Text } from 'ink'
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PendingQuestion, TuiService, Store } from '../index.tsx'
import { visualWidth, truncateWide } from '../markdown.tsx'
import { dockInnerWidth } from '../config.ts'
import { theme } from '../theme.ts'
import type { RawKey } from '../stdin.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-panel-question'

/** Max wrapped rows the question sentence itself may occupy before being
 *  truncated (kept in sync with the conversation's modalH estimate: a verbose
 *  model dumping long text into `question` must not inflate the dock; long
 *  content belongs in the scrollable `detail` window). */
const questionCapLines = 6

/** The store service (see panels/conversation.tsx). */
let store!: Store

/** The `tui` service must be available to register the panel. */
export const inject = ['tui']

/** Max detail rows shown inside the dock window (kept in sync with the
 *  conversation's modalH estimate: window ≤ rows - 25 so composer + status
 *  + a minimum transcript viewport still fit). */
function detailWindowRows(rows: number): number {
  return Math.max(2, Math.min(10, rows - 25))
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
  const { item, index, custom, customMode, position, total } = props.question
  const options = item.options ?? []
  const title = total !== undefined && total > 1 ? `Question ${position ?? 1}/${total}` : 'Question'
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
  return (
    <Box flexShrink={0} marginLeft={3} marginRight={3} borderStyle="round" borderColor={theme.accent} flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.accent} bold wrap="truncate">{title}</Text>
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
        <Box marginTop={1}>
          <Text color={theme.primary}>Your answer: {custom || ''}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
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
  if (question.customMode) {
    if (k.return) {
      const custom = question.custom.trim()
      store.clearQuestion()
      question.resolve({ id: question.item.id, selected: [], custom: custom === '' ? undefined : custom })
    } else if (k.backspace || k.delete) {
      store.setQuestionCustom(question.custom.slice(0, -1), true)
    } else if (k.escape || (k.ctrl && char === 'c')) {
      const rejectFn = question.reject; store.clearQuestion(); rejectFn(new Error('ask_user_question was cancelled'))
    } else if (char) {
      store.setQuestionCustom(question.custom + char, true)
    }
    return true
  }
  if (k.upArrow) store.bumpQuestionIndex(-1)
  else if (k.downArrow) store.bumpQuestionIndex(1)
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
