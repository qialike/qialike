/**
 * The conversation panel plugin (`tui-panel-conversation`): the terminal's main
 * surface — transcript, todo-steps sidebar, composer, status bar. Registers the
 * `conversation` (fullscreen) panel against the `tui` service. Session history
 * management lives in the `/sessions` plugin (`tui-sessions`).
 *
 * @module @yourname/dsh-tui-app/panels-conversation
 */

import { Box, Text, useStdin, measureElement, type DOMElement } from 'ink'
import React, { useMemo, useState } from 'react'
import { spawnSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import {
  APP_VERSION,
  BETA_FOOTER_SUFFIX,
  type Store,
  type TranscriptItem,
  type StepItem,
  type CommandItem,
  type TuiService,
} from '../index.tsx'
import { MarkdownText, markdownPlain, estimateMarkdownHeight, visualWidth, countWrappedLines } from '../markdown.tsx'
import { SIDEBAR_MIN_WIDTH, dockInnerWidth } from '../config.ts'
import { formatSessionStats } from '../session-stats.ts'
import { theme } from '../theme.ts'
import type { RawKey } from '../stdin.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-panel-conversation'

/** The store service, resolved at apply() from `tuiStore`. The panel plugins
 *  are separate bundles: importing the store VALUE from index.tsx would create
 *  a second store instance, so the store is fetched through the service seam. */
let store!: Store

/** The `tui` service must be available to register panels and commands. */
export const inject = ['tui']

const COMPOSER_MIN_HEIGHT = 5

// opencode-style message area (mirrors ~/opencode routes/session/index.tsx):
// a USER message is a left colored rail (┃ + space) with the text in a column
// next to it (hanging indent), and an ASSISTANT message is indented by a few
// columns before its markdown. Both reduce the text column width by the same
// amount, so estItemLines/layout stay in sync.
//
// Spacing is LAYOUT MARGINS on the message blocks (opencode's model), never
// painted blank rows: a blank row rendered as text can measure 0 rows in a
// scroll re-layout and merge into the next line (the glyph overwrites the next
// line's first cell — the observed PgUp gap collapse), while a margin is pure
// layout and cannot collapse. Margins per base row (see buildRows):
//   user message content: 1 blank above (top rail pad; 2 when not the first
//                          row, where a between-message pad also applies) and
//                          1 blank below (bottom rail pad);
//   every other row      : 1 blank above (between-message pad), none below.
// Message-body alignment (opencode-style, mirrored from the /sessions screenshot):
// the content text starts 4 char-widths from the terminal line start (column 5)
// and leaves 4 char-widths blank at the right, so user and assistant bodies land
// on the SAME left column and never hug the right edge. The message column's
// paddingX=1 supplies one col of each margin; these two insets cover the rest.
const MESSAGE_LEFT_COLS = 3
const MESSAGE_RIGHT_COLS = 3
const MESSAGE_TEXT_WIDTH = (usable: number): number =>
  Math.max(1, usable - MESSAGE_LEFT_COLS - MESSAGE_RIGHT_COLS)
// The flat selection view sits in the SAME content column as the normal
// transcript (col 5 with the message column's paddingX=1, i.e. the 1-based
// column of the first selectable char is 2 + MESSAGE_LEFT_COLS). The `-2` that
// the original flat view used addressed the old left-aligned (no rail/indent)
// rendering; once the flat rows carry the same rail/indent as the normal view
// the selectable span is offset by the inset, so column→char maps with this.
const FLAT_COL_OFFSET = 2 + MESSAGE_LEFT_COLS
// Between-message pad rows (opencode marginTop={1} between messages).
const MESSAGE_PAD_ROWS = 1
// Rail pads above/below a user message's text (opencode keeps user messages
// visually separated); these plus MESSAGE_PAD_ROWS give the user block its
// 2 blank rows above and below (matches the legacy blank-row layout).
const USER_PAD_ROWS = 1

/** Rows scrolled per mouse-wheel tick. */
const WHEEL_STEP = 3

/** The status bar height in terminal rows (bordered single-line bar). */
const STATUS_BAR_HEIGHT = 3

const SPINNER_FRAMES = ['⠋', '⠙', '⠸', '⠴', '⠦', '⠧', '⠇', '⠏']

// ── input history (composer) ────────────────────────────────────────────────
// The history list lives on the store so the runtime's submit path (which
// records every sent message) and this panel's browse path share one list.

let historyBrowse = -1
let historyDraft = ''

function loadHistoryEntry(index: number): void {
  if (index < 0 || index >= store.inputHistory.length) return
  if (historyBrowse === -1) historyDraft = store.input
  historyBrowse = index
  store.setInput(store.inputHistory[index]!)
}

function browseOlder(): void {
  loadHistoryEntry(historyBrowse === -1 ? store.inputHistory.length - 1 : historyBrowse - 1)
}

function browseNewer(): void {
  if (historyBrowse === -1) return
  if (historyBrowse + 1 < store.inputHistory.length) loadHistoryEntry(historyBrowse + 1)
  else { historyBrowse = -1; store.setInput(historyDraft) }
}

function resetHistoryBrowse(): void {
  historyBrowse = -1
  historyDraft = ''
}

function filteredCommands(tui: TuiService): readonly CommandItem[] {
  const filter = store.commandFilter.trim()
  if (filter === '') return tui.commands.list()
  const f = filter.toLowerCase()
  // Match a command whose name the filter PREFIXES (`expo…` narrows to
  // /export) or that the filter starts WITH (`export <args>` — command plus
  // parameters — still resolves to /export), plus hint substring hits.
  return tui.commands.list().filter((c) => {
    const name = c.name.toLowerCase()
    return name.startsWith(f) || f.startsWith(name) || c.hint.toLowerCase().includes(f)
  })
}

// ── row measurement ─────────────────────────────────────────────────────────

const measuredHeights = new Map<string, number>()
let lastLayoutWidth = -1 // last width the row-height cache was computed for
const lastMeasuredNotify = new Map<string, number>()

function setMeasuredHeight(key: string, rows: number): void {
  const prev = measuredHeights.get(key)
  if (prev !== undefined && Math.abs(prev - rows) <= 1) return
  const now = Date.now()
  const last = lastMeasuredNotify.get(key)
  if (last !== undefined && now - last < 250) return
  lastMeasuredNotify.set(key, now)
  measuredHeights.set(key, rows)
  store.touch()
}

function rowHeight(key: string, fallback: number): number {
  return Math.max(fallback, measuredHeights.get(key) ?? 0)
}

// ── transcript rendering helpers ────────────────────────────────────────────

type Row =
  | { type: 'item'; item: TranscriptItem; top: number; bottom: number }
  | { type: 'steps'; top: number; bottom: number }

function itemContent(item: TranscriptItem, expandReasoning: boolean, usable: number, active: boolean): React.ReactNode {
  if (item.kind === 'assistant') {
    // opencode-style assistant: indent the markdown to the shared content column.
    return <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS}><MarkdownText text={item.text} /></Box>
  }
  if (item.kind === 'reasoning') {
    // Collapsed: a "↓ Think" label then the thinking text as its own wrapped
    // paragraph at the shared content column. Keeping the label inline would
    // hang-indent the wrapped lines (they'd start after "↓ Think · " instead of
    // the column), breaking the left alignment. The leading glyph is an
    // animated spinner while the model is actively thinking (ThinkingIcon).
    return expandReasoning
      ? <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS}><Text dimColor wrap="wrap">{item.text}</Text></Box>
      : (
        <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS} flexDirection="column">
          <Text color={theme.accent}><ThinkingIcon active={active} /> Think</Text>
          <Text dimColor wrap="wrap">{item.text.split('\n')[0]}</Text>
        </Box>
      )
  }
  if (item.kind === 'tool') {
    return <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS}><Text color={item.text.startsWith('✓') ? theme.success : theme.secondary} wrap="wrap">{item.text}</Text></Box>
  }
  if (item.kind === 'user') {
    // opencode-style user block: a primary left border (┃) with the text on a
    // panel background. Ink's Box has no background, so each wrapped line is its
    // own pair of <Text> spans; the ┃ rail runs down every line (opencode's
    // border=["left"]) and the text is padded to the content width so the panel
    // block spans from the content column to the right margin.
    // The blank rows above/below the block are LAYOUT MARGINS on the row's
    // wrapper (see buildRows), not painted rows: painted blanks collapse in
    // scroll re-layouts (the PgUp gap bug); margins always survive.
    const w = MESSAGE_TEXT_WIDTH(usable)
    const lines = wrapRows(item.text, w)
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => {
          const pad = Math.max(0, w - visualWidth(line))
          return (
            <Text key={i} wrap="truncate">
              <Text backgroundColor={theme.bg}>{'┃'.padEnd(MESSAGE_LEFT_COLS)}</Text>
              <Text color={theme.text} backgroundColor={theme.panel}>{line}{' '.repeat(pad)}</Text>
            </Text>
          )
        })}
      </Box>
    )
  }
  return (
    <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS}>
      <Text dimColor={item.dim} wrap="wrap">
        {item.text}
      </Text>
    </Box>
  )
}

/** Memoized transcript row: unchanged item objects (stable references, only
 *  the streaming tail is replaced) skip re-render/parse on typing, scroll and
 *  other notify cycles. */
const MemoTranscriptItemView = React.memo(function TranscriptItemView(props: { item: TranscriptItem; expandReasoning: boolean; themeEpoch: number; usable: number; active: boolean }): React.JSX.Element {
  const ref = React.useRef<DOMElement>(null)
  React.useEffect(() => {
    const key = String(props.item.key)
    // Measure immediately (setMeasuredHeight is throttled to 250 ms, so a
    // per-delta notify storm is avoided) so the very next frame lays out with
    // the current height and no content overlaps. Ink can finish laying out a
    // frame AFTER React commits, so also re-measure at 60/400/900 ms through
    // the UN-throttled path: without it a stale (smaller) height would linger
    // in the cache and drift the scroll — the clip boundary lands one row off
    // and a block/heading separator row gets cut (heading looks flush).
    if (ref.current) setMeasuredHeight(key, measureElement(ref.current).height)
    const sample = (): void => {
      if (!ref.current) return
      const rows = measureElement(ref.current).height
      const prev = measuredHeights.get(key)
      if (prev === undefined || Math.abs(prev - rows) > 1) {
        measuredHeights.set(key, rows)
        store.touch()
      }
    }
    const timers = [setTimeout(sample, 60), setTimeout(sample, 400), setTimeout(sample, 900)]
    return () => { for (const t of timers) clearTimeout(t) }
  }, [props.item.text])
  return <Box ref={ref} flexDirection="column">{itemContent(props.item, props.expandReasoning, props.usable, props.active)}</Box>
})

function StepsRow(props: { steps: readonly StepItem[] }): React.JSX.Element {
  const ref = React.useRef<DOMElement>(null)
  React.useEffect(() => {
    if (ref.current) setMeasuredHeight('steps', measureElement(ref.current).height)
  }, [props.steps])
  return <Box ref={ref} flexDirection="column"><StepsBlock steps={props.steps} /></Box>
}

function BusyIndicator(props: { animate: boolean; paused: boolean }): React.JSX.Element | null {
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (!props.animate) return
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 100)
    return () => clearInterval(timer)
  }, [props.animate])
  if (props.paused) return <Text color={theme.warning}>⏸ Paused</Text>
  // Idle: a STATIC marker (⠿, not an animated spinner frame) + "Idle".
  if (!props.animate) return <Text dimColor>⠿ Idle</Text>
  const armed = Date.now() - store.lastEscTime < 800
  return (
    <Text color={theme.info}>
      {SPINNER_FRAMES[frame]}
      <Text dimColor> Working · {armed ? 'Esc again to pause' : 'Esc to pause'}</Text>
    </Text>
  )
}

/** The reasoning ("Think") leading glyph: an animated spinner (the same frames
 *  as the status-bar "Working") while the model is actively thinking, a static
 *  ↓ otherwise. The glyph owns its timer so only this leaf re-renders on a tick
 *  (the reasoning text beside it is a sibling and stays put). */
function ThinkingIcon(props: { active: boolean }): React.JSX.Element {
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (!props.active) { setFrame(0); return }
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 100)
    return () => clearInterval(timer)
  }, [props.active])
  return <Text color={props.active ? theme.info : theme.accent}>{props.active ? SPINNER_FRAMES[frame] : '↓'}</Text>
}

function buildRows(items: readonly TranscriptItem[], steps: readonly StepItem[]): Row[] {
  const base: ({ type: 'item'; item: TranscriptItem } | { type: 'steps' })[] = []
  let inserted = false
  for (const it of items) {
    base.push({ type: 'item', item: it })
    if (steps.length > 0 && !inserted && it.kind === 'user') { base.push({ type: 'steps' }); inserted = true }
  }
  if (steps.length > 0 && !inserted) base.push({ type: 'steps' })
  // Spacing is LAYOUT MARGINS on the rows (opencode's margin model), never
  // blank text rows: a painted blank collapses to 0 rows in a scroll
  // re-layout and merges into the next line, deleting the gap. Margins are
  // pure layout, so they survive every paint path. Each row's wrapper carries
  // marginTop/marginBottom; the layout hts add the same rows so scroll and
  // clipping stay consistent. Visual contract (same as the old blank rows):
  // a USER message keeps USER_PAD_ROWS blanks above and below its text, and
  // every consecutive pair of rows keeps MESSAGE_PAD_ROWS blanks between them.
  const out: Row[] = []
  for (let i = 0; i < base.length; i++) {
    const entry = base[i] as { type: 'item'; item: TranscriptItem } | { type: 'steps' }
    const isUser = entry.type === 'item' && entry.item.kind === 'user'
    const top = (i === 0 ? 0 : MESSAGE_PAD_ROWS) + (isUser ? USER_PAD_ROWS : 0)
    const bottom = isUser ? USER_PAD_ROWS : 0
    if (entry.type === 'steps') out.push({ type: 'steps', top, bottom })
    else out.push({ type: 'item', item: entry.item, top, bottom })
  }
  return out
}

const STEP_ICON: Record<StepItem['status'], string> = { completed: '✓', in_progress: '→', pending: '·' }
/** Step colors read the LIVE theme at render time (theme switches repaint). */
function stepColor(status: StepItem['status']): string | undefined {
  return status === 'completed' ? theme.success : status === 'in_progress' ? theme.info : undefined
}

function StepRows(props: { steps: readonly StepItem[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {props.steps.map((step, i) => (
        <Text key={i} color={stepColor(step.status)}>
          {STEP_ICON[step.status]} {step.content}
        </Text>
      ))}
    </Box>
  )
}

function StepsBlock(props: { steps: readonly StepItem[] }): React.JSX.Element {
  return (
    <Box flexDirection="column" gap={0}>
      {props.steps.length > 0 && <Text color={theme.accent} bold>Steps</Text>}
      <StepRows steps={props.steps} />
    </Box>
  )
}

// ── layout helpers ──────────────────────────────────────────────────────────

function composerHeight(width: number, input: string, min: number): number {
  const usable = Math.max(10, width - 4)
  const wrapped = input.split('\n').reduce((sum, seg) => sum + Math.max(1, Math.ceil(visualWidth(seg) / usable)), 0)
  const cap = Math.max(min, Math.floor(store.rows * 0.4))
  return Math.min(min + wrapped - 1, cap)
}

function estItemLines(item: TranscriptItem, usable: number, expandReasoning: boolean): number {
  const w = MESSAGE_TEXT_WIDTH(usable)
  if (item.kind === 'reasoning') return expandReasoning ? countWrappedLines(item.text, w) : 1
  if (item.kind === 'assistant') return estimateMarkdownHeight(item.text, w)
  if (item.kind === 'user') return countWrappedLines(item.text, w)
  return countWrappedLines(item.text, w)
}

function convUsableWidth(width: number, showSidebar: boolean): number {
  // Same numeric sidebar width the renderer uses (see `sidebarWidth` below):
  // a percentage would let Ink round it independently of this math, flipping
  // the wrap width by ±1 column and churning the measured row heights (the
  // sidebar "jump"/re-layout feedback loop).
  const sidebar = showSidebar ? Math.max(20, Math.round(width * 0.3)) : 0
  return Math.max(20, width - 2 - sidebar)
}

function convViewportLines(composerH: number, stepsH: number, modalH: number): number {
  return Math.max(3, store.rows - composerH - 3 - 2 - stepsH - modalH)
}

function stepsBlockHeight(count: number): number {
  return count > 0 ? Math.min(12, 5 + 2 * count) : 0
}

// ── mouse / selection helpers ───────────────────────────────────────────────

interface TranscriptRow { readonly text: string; readonly itemIndex: number }

function wrapRows(text: string, usable: number): string[] {
  const out: string[] = []
  for (const seg of text.split('\n')) {
    if (visualWidth(seg) <= usable) { out.push(seg); continue }
    let line = ''
    let lineW = 0
    for (const ch of seg) {
      const cw = visualWidth(ch)
      if (line !== '' && lineW + cw > usable) { out.push(line); line = ''; lineW = 0 }
      line += ch
      lineW += cw
    }
    out.push(line)
  }
  return out
}

function buildTranscriptRows(items: readonly TranscriptItem[], usable: number, expandReasoning: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  items.forEach((item, i) => {
    if (i > 0) rows.push({ text: '', itemIndex: i - 1 })
    let plain: string
    if (item.kind === 'reasoning') {
      plain = expandReasoning ? item.text : `◇ Think · ${item.text.split('\n')[0]}`
    } else {
      plain = item.kind === 'assistant' && item.text.length <= 8000 ? markdownPlain(item.text) : item.text
    }
    // Wrap breadth mirrors the rendered layout (one shared content column).
    const w = MESSAGE_TEXT_WIDTH(usable)
    for (const line of wrapRows(plain, w)) rows.push({ text: line, itemIndex: i })
  })
  return rows
}

function colToChar(line: string, col: number): number {
  let w = 0
  for (let i = 0; i < line.length; i++) {
    const cw = visualWidth(line[i]!)
    if (w + cw > col) return i
    w += cw
  }
  return line.length
}

function composerInputIndex(row: number, col: number): number | null {
  const width = process.stdout.columns ?? 80
  const height = process.stdout.rows ?? 24
  const composerH = composerHeight(width, store.input, COMPOSER_MIN_HEIGHT)
  const composerTop = height - composerH - STATUS_BAR_HEIGHT + 1
  const inRow = row - composerTop
  const usable = Math.max(10, width - 4)
  const visualStarts: number[] = []
  for (let i = 0; i <= store.input.length; i++) {
    if (i === 0 || store.input[i - 1] === '\n') visualStarts.push(i)
  }
  const lineAt = (start: number): string => {
    const nl = store.input.indexOf('\n', start)
    return store.input.slice(start, nl === -1 ? store.input.length : nl)
  }
  const inputRows = visualStarts.reduce((sum, start) => sum + Math.max(1, Math.ceil(visualWidth(lineAt(start)) / usable)), 0)
  const clickRow = inRow - 1
  if (clickRow < 0 || clickRow >= inputRows) return null
  let acc = 0
  for (const start of visualStarts) {
    const line = lineAt(start)
    const visLines = Math.max(1, Math.ceil(visualWidth(line) / usable))
    if (clickRow < acc + visLines) {
      return start + colToChar(line, Math.max(0, col - 3))
    }
    acc += visLines
  }
  return null
}

function positionCursorByMouse(row: number, col: number): void {
  const index = composerInputIndex(row, col)
  if (index !== null) store.setCursor(index)
}

function composerCaretCell(): { row: number; col: number } | null {
  const width = process.stdout.columns ?? 80
  const height = process.stdout.rows ?? 24
  const composerH = composerHeight(width, store.input, COMPOSER_MIN_HEIGHT)
  const composerTop = height - composerH - STATUS_BAR_HEIGHT + 1
  const usable = Math.max(10, width - 4)
  const caret = Math.max(0, Math.min(store.cursor, store.input.length))
  let visRow = 0
  let visCol = 0
  let pos = 0
  while (pos < caret) {
    const nl = store.input.indexOf('\n', pos)
    const end = nl === -1 ? store.input.length : nl
    if (caret <= end) {
      const upToCaret = visualWidth(store.input.slice(pos, caret))
      visRow += Math.floor(upToCaret / usable)
      visCol = upToCaret % usable
      pos = caret
    } else {
      visRow += Math.max(1, Math.ceil(visualWidth(store.input.slice(pos, end)) / usable))
      pos = end + 1
    }
  }
  return { row: composerTop + 1 + visRow, col: 3 + visCol }
}

function composerSelectionRange(sel: { aRow: number; aCol: number; cRow: number; cCol: number }): { start: number; end: number } | null {
  const a = composerInputIndex(sel.aRow, sel.aCol)
  const c = composerInputIndex(sel.cRow, sel.cCol)
  if (a === null && c === null) return null
  const start = a === null ? 0 : c === null ? a : Math.min(a, c)
  const end = a === null ? (c ?? 0) : c === null ? store.input.length : Math.max(a, c)
  if (start >= end) return null
  return { start, end }
}

function selectionText(aRow: number, aCol: number, cRow: number, cCol: number): string {
  const width = process.stdout.columns ?? 80
  const height = process.stdout.rows ?? 24
  const input = store.input
  const composerH = composerHeight(width, input, COMPOSER_MIN_HEIGHT)
  const composerTop = height - composerH - STATUS_BAR_HEIGHT + 1
  const usable = convUsableWidth(width, store.width >= SIDEBAR_MIN_WIDTH)
  const rows = buildTranscriptRows(store.getItems(), usable, store.expandReasoning)
  const joined = rows.map((r) => r.text).join('\n')
  const inputStart = joined.length + 1
  const rowPrefix: number[] = []
  {
    let acc = 0
    for (const r of rows) { rowPrefix.push(acc); acc += r.text.length + 1 }
  }
  const composerLastContent = composerTop + composerH - 2
  const cellIndex = (row: number, col: number): number | null => {
    if (row > composerTop && row <= composerLastContent) {
      const ci = composerInputIndex(row, col)
      return ci === null ? null : inputStart + ci
    }
    const flat = store.layoutScroll + (row - store.layoutTopRow)
    if (flat < 0 || flat >= rows.length) return null
    const line = rows[flat]!.text
    return rowPrefix[flat]! + Math.min(colToChar(line, col - FLAT_COL_OFFSET), line.length)
  }
  const a = cellIndex(aRow, aCol)
  const c = cellIndex(cRow, cCol)
  if (a === null || c === null) return ''
  return `${joined}\n${input}`.slice(Math.min(a, c), Math.max(a, c))
}

function writeClipboard(text: string): void {
  // macOS Terminal.app has no OSC 52, so `pbcopy` is the only reliable path; use
  // the ABSOLUTE path and BLOCK until it has consumed stdin (spawnSync), so a
  // Node single-executable binary is guaranteed to deliver the bytes — an async
  // `spawn` + `stdin.end` race under a busy event loop can leave the child
  // reading EOF before the text is flushed, silently setting nothing.
  if (process.platform === 'darwin') {
    for (const cmd of ['/usr/bin/pbcopy', 'pbcopy']) {
      const res = spawnSync(cmd, [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
      if (!res.error && res.status === 0) return
    }
    process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x1b\\`)
    return
  }
  // Linux: no single clipboard tool is guaranteed (X11 vs Wayland). Try the
  // Wayland tool and the two X11 tools in order — opencode does the same
  // (wl-copy / xclip / xsel) — so whichever is installed and matches the session
  // sets the system clipboard. xclip/xsel default to the PRIMARY selection, so
  // the -selection clipboard / --clipboard flag is required for Ctrl+V paste.
  if (process.platform === 'win32') {
    const r = spawnSync('clip', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    if (!r.error && r.status === 0) return
  } else if (process.platform === 'linux') {
    for (const [cmd, args] of [
      ['wl-copy', []],
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ] as const) {
      const r = spawnSync(cmd, [...args], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
      if (!r.error && r.status === 0) return
    }
  }
  // No clipboard command succeeded; send OSC 52 (iTerm2 / Kitty / Alacritty / Windows Terminal).
  process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x1b\\`)
}

/** Copy the currently active mouse selection (the one the frame controller is
 *  highlighting) to the system clipboard. Shared by the mouse-release handler and
 *  the Ctrl+Y keyboard fallback; prefers the frame-buffer `copiedText` (matches
 *  the highlight exactly, no drift across item margins) and falls back to the
 *  flat-model `selectionText`. No-op unless the selection spans a real drag. */
function copyCurrentSelection(): void {
  const sel = store.selection
  if (sel === null || (Math.abs(sel.aRow - sel.cRow) + Math.abs(sel.aCol - sel.cCol)) <= 2) return
  const fc = (globalThis as unknown as { __dshFrameController?: { copiedText?: string } }).__dshFrameController
  const framed = fc && fc.copiedText ? fc.copiedText : ''
  const text = framed || selectionText(sel.aRow, sel.aCol, sel.cRow, sel.cCol)
  const trimmed = text.trim()
  if (trimmed !== '') {
    writeClipboard(trimmed)
    // Show the feedback in the bottom STATUS BAR (transient, not a transcript
    // item): a `status` transcript row would re-layout / follow-tail auto-scroll
    // the transcript and slide the screen-coordinate highlight onto the next
    // block below (the user saw this as the highlight jumping to下文).
    store.flashStatus(`copied: ${trimmed.slice(0, 40)}${trimmed.length > 40 ? '…' : ''}`)
  }
}

// ── the conversation key handler ────────────────────────────────────────────

function conversationKey(k: RawKey, tui: TuiService): void {
  const input = store.input
  const char = k.char ?? ''
  if (char === '\n' || k.altEnter) { resetHistoryBrowse(); store.insertAtCursor('\n'); return }
  // Bracketed paste: if it is a local image path, attach it (opencode-style);
  // otherwise insert the pasted text at the cursor.
  if (k.paste !== undefined) {
    resetHistoryBrowse()
    const path = tui.imageAttach?.imagePathFor(k.paste) ?? null
    if (path !== null) {
      void tui.imageAttach!.attachLocalImage(path)
    } else {
      store.insertAtCursor(k.paste)
    }
    return
  }
  // Ctrl+T (Alt+T fallback) cycles the current model's reasoning effort,
  // opencode-style (`variant_cycle`); no-op status for models without one.
  if ((k.ctrl && char === 't') || (k.meta && char === 't')) {
    resetHistoryBrowse()
    store.cycleEffort()
    return
  }
  if (k.return) {
    const text = input.trim()
    if (text === '') return
    store.setInput('')
    resetHistoryBrowse()
    store.scrollBottom()
    const filtered = filteredCommands(tui)
    const effectiveIndex = filtered.length === 0 ? -1 : (store.commandIndex % filtered.length)
    if (text.startsWith('/') && filtered.length > 0 && effectiveIndex >= 0) {
      const chosen = filtered[effectiveIndex]
      // Skip the leading '/' (text.length > name.length) so the remainder is
      // the args AFTER the command name — without the offset the last letter
      // of the command was included ("/export" → arg "t").
      const remainder = text.slice(chosen.name.length + 1).trim()
      chosen.run(remainder)
    } else {
      store.submitMessage(text)
    }
    return
  }
  if (k.upArrow) {
    if (input.startsWith('/')) {
      // Browse the command palette (wraps over the FILTERED list; the old
      // store.commands array was never populated, which kept the index at 0).
      const len = Math.max(1, filteredCommands(tui).length)
      store.setCommandIndex((store.commandIndex - 1 + len) % len)
      return
    }
    if (historyBrowse !== -1) { browseOlder(); return }
    if (input.includes('\n')) { store.moveCursorUp(); return }
    if (store.cursor > 0) { store.setCursor(0); return }
    browseOlder()
    return
  }
  if (k.downArrow) {
    if (input.startsWith('/')) {
      const len = Math.max(1, filteredCommands(tui).length)
      store.setCommandIndex((store.commandIndex + 1) % len)
      return
    }
    if (historyBrowse !== -1) { browseNewer(); return }
    if (input.includes('\n')) { store.moveCursorDown(); return }
    if (store.cursor < input.length) { store.setCursor(input.length); return }
    browseNewer()
    return
  }
  if (k.leftArrow) { store.moveCursorLeft(); return }
  if (k.rightArrow) { store.moveCursorRight(); return }
  if (k.pageUp) { store.scrollPage(-1); return }
  if (k.pageDown) { store.scrollPage(1); return }
  if (k.home) { store.scrollTop(); return }
  if (k.end) { store.scrollBottom(); return }
  if (k.wheelUp) { store.scrollLines(-WHEEL_STEP); return }
  if (k.wheelDown) { store.scrollLines(WHEEL_STEP); return }
  if (k.mousePress) { store.mousePress(k.mousePress.row, k.mousePress.col); return }
  if (k.mouseDrag) { store.mouseDrag(k.mouseDrag.row, k.mouseDrag.col); return }
  if (k.mouseRelease) {
    const kind = store.mouseRelease(k.mouseRelease.row, k.mouseRelease.col)
    if (kind === 'click') {
      positionCursorByMouse(k.mouseRelease.row, k.mouseRelease.col)
    } else if (kind === 'drag') {
      copyCurrentSelection()
    }
    return
  }
  if (k.ctrl && char === 'u') { resetHistoryBrowse(); store.deleteToLineStart(); return }
  if (k.ctrl && char === 'p') { resetHistoryBrowse(); store.setCommandFilter(''); store.setInput('/'); return }
  if (k.ctrl && char === 'y') { copyCurrentSelection(); return } // Ctrl+Y: copy the active mouse selection (macOS Terminal.app may drop the release event)
  if (k.tab) {
    if (input.startsWith('/')) {
      const filtered = filteredCommands(tui)
      const chosen = filtered.length === 0 ? undefined : filtered[store.commandIndex % filtered.length]
      if (chosen !== undefined) { resetHistoryBrowse(); store.setInput(`/${chosen.name} `); return }
    }
    const next = store.cyclePermission()
    const session = store.session
    if (session !== undefined) {
      try { setSandboxMode(session, next) } catch { /* best-effort */ }
      // Mirror the harness danger-full-access preset: full access also stops
      // asking for approval; every other mode keeps ask.
      try { setApprovalPolicy(session, next === 'danger-full-access' ? 'never' : 'ask') } catch { /* best-effort */ }
    }
    return
  }
  if (k.escape) {
    store.clearSelection()
    if (store.composerImage !== null) { store.clearComposerImage(); return }
    if (input.startsWith('/')) { resetHistoryBrowse(); store.setInput(''); return }
    const now = Date.now()
    if (store.running && now - store.lastEscTime < 800) { store.lastEscTime = 0; store.pauseAgent() }
    else store.lastEscTime = now
    return
  }
  if (k.ctrl && char === 'c') { resetHistoryBrowse(); store.setInput(''); store.cancelAction(); return }
  if (k.backspace) {
    resetHistoryBrowse()
    store.backspaceAtCursor()
    if (store.commandFilter.startsWith('')) store.setCommandFilter(store.input)
    return
  }
  if (k.delete) {
    resetHistoryBrowse()
    store.deleteForward()
    if (store.commandFilter.startsWith('')) store.setCommandFilter(store.input)
    return
  }
  if (char) {
    resetHistoryBrowse()
    store.insertAtCursor(char)
    if (store.input.startsWith('/')) store.setCommandFilter(store.input.slice(1))
  }
}

/** The main conversation surface (fullscreen; overlays render inside it). */
function ConversationMain(props: { tui: TuiService }): React.JSX.Element {
  const { isRawModeSupported } = useStdin()
  const [, forceRender] = React.useReducer((c: number) => c + 1, 0)
  React.useEffect(() => store.subscribe(() => forceRender()), [])
  const version = store.getVersion()
  const themeEpoch = store.themeEpoch
  const items = store.getItems()
  const steps = store.steps
  const stepsDone = store.stepsDone
  const stepsTotal = store.stepsTotal
  const input = store.input
  const commands = props.tui.commands.list()
  const filter = store.commandFilter
  const commandIndex = store.commandIndex
  const approval = store.approval
  const question = store.question
  const width = store.width
  const expandReasoning = store.expandReasoning
  const permissionLabel = store.permissionLabel
  const permissionColor = store.permissionColor
  const modelLabel = store.modelLabel
  // Bottom-bar session stats text (steps/turns · tokens; LLM/Tool durations
  // are folded but not displayed); '' until the session has any activity.
  const statsLine = formatSessionStats(store.stats)
  // The composer shows the model with its reasoning effort as a separate
  // warning-colored chip (like opencode's variant); the full label embeds the
  // effort as ` · <name>`, so the base part strips that suffix.
  const effortName = store.modelEffortName
  const modelBaseLabel = effortName === '' || !modelLabel.endsWith(` · ${effortName}`)
    ? modelLabel
    : modelLabel.slice(0, Math.max(0, modelLabel.length - effortName.length - 3))
  const showSidebar = width >= SIDEBAR_MIN_WIDTH

  const filtered = useMemo(
    () => filteredCommands(props.tui),
    [commands, filter, version],
  )

  const isSlash = input.startsWith('/')
  const [hoverIndex, setHoverIndex] = useState(commandIndex)
  React.useEffect(() => setHoverIndex(commandIndex), [commandIndex])
  const effectiveIndex = filtered.length === 0 ? -1 : (hoverIndex % filtered.length)

  const status = isRawModeSupported ? '' : '(raw input unsupported) '

  const composerH = composerHeight(width, input, COMPOSER_MIN_HEIGHT)
  // Approval dock height: fixed — border 2 + padding 2 + header 1 + gap 1 +
  // one truncated reason line 1 + gap 1 + choice row 1 + gap 1 + hint 1.
  const approvalH = store.approval === null ? 0 : 11
  // Question dock height: border 2 + padding 2 + header 1 + gaps + the
  // wrapped question (capped) + the windowed detail (long details such as
  // plan reviews scroll; window ≤ rows-25, kept in sync with question.tsx)
  // + the single-line option rows (capped) + the hint.
  const questionH = store.question === null ? 0 : (() => {
    const q = store.question
    // Same text width the question panel wraps at (message column minus the
    // dock chrome), so the estimate matches the rendered row count exactly.
    const inner = dockInnerWidth(width)
    const qLines = Math.min(countWrappedLines(q.item.question ?? '', inner), 6)
    if (q.customMode) return 10 + qLines
    const detailWindow = Math.max(2, Math.min(10, store.rows - 25))
    const dLines = q.item.detail === undefined || q.item.detail === ''
      ? 0 : Math.min(countWrappedLines(q.item.detail, inner), detailWindow)
    const optRows = Math.min((q.item.options?.length ?? 0) + 1, 12)
    return 9 + qLines + (dLines > 0 ? 1 + dLines : 0) + optRows
  })()
  const modalH = store.panel === 'approval' ? approvalH
    : store.panel === 'question' ? questionH
    : 0
  const usable = convUsableWidth(width, showSidebar)
  // Deterministic numeric sidebar width (same formula convUsableWidth uses for
  // the message wrap width). A percentage would let Ink round independently of
  // the layout math, flipping the wrap width by ±1 column and churning the
  // measured row heights (sidebar width jump / re-layout feedback).
  const sidebarWidth = showSidebar ? Math.max(20, Math.round(width * 0.3)) : 0
  const viewportLines = convViewportLines(composerH, 0, modalH)
  const rows = useMemo(() => buildRows(items, steps), [items, steps, version, themeEpoch])
  const layout = useMemo(() => {
    // A width change invalidates every cached row height (wrap counts differ);
    // drop the cache so the next pass re-estimates before anything is measured.
    if (usable !== lastLayoutWidth) {
      measuredHeights.clear()
      lastLayoutWidth = usable
    }
    // Row heights come from the measured cache first; a row that has not been
    // painted yet (scrolled out / long history) gets ONE estimated pass that
    // is cached in place, so later notify cycles only walk the cache instead
    // of re-estimating every row's wrapped-line count (O(total chars) each
    // render on long sessions).
    const hts = rows.map((r) => {
      // Content rows first (estimated; the measured cache only overrides when
      // it stays within 1 of the estimate — a wildly-off reading is a scroll
      // artifact), then the row's layout margins add their rows so starts[]
      // tracks the real rendered extent (content + spacing).
      const content = r.type === 'steps'
        ? rowHeight('steps', stepsBlockHeight(steps.length))
        : (() => {
          const key = String(r.item.key)
          // The ESTIMATE is deterministic and correct; the measureElement height
          // is flaky during scroll (a diff-rendered item can measure a collapsed
          // height, e.g. 1 instead of 3). Use the measured value only when it
          // stays within 1 of the estimate — a wildly-off reading is a scroll
          // artifact, so fall back to the estimate to keep every gap stable.
          const est = estItemLines(r.item, usable, expandReasoning)
          const measured = measuredHeights.get(key)
          if (measured !== undefined && Math.abs(measured - est) <= 1) return measured
          measuredHeights.set(key, est)
          return est
        })()
      return content + r.top + r.bottom
    })
    const starts: number[] = []
    let s = 0
    for (let i = 0; i < hts.length; i++) { starts.push(s); s += hts[i] }
    return { hts, starts, content: s }
  }, [rows, usable, expandReasoning, steps, version, themeEpoch])
  const maxScroll = Math.max(0, layout.content - viewportLines)
  const effectiveScroll = store.followTail ? maxScroll : Math.max(0, Math.min(store.scroll, maxScroll))
  const topRow = 2
  store.setLayout(layout.content, viewportLines, effectiveScroll, topRow)
  let first = 0
  while (first < rows.length && layout.starts[first] + layout.hts[first] <= effectiveScroll) first++
  if (first >= rows.length) first = Math.max(0, rows.length - 1)
  let last = rows.length - 1
  while (last >= 0 && layout.starts[last] >= effectiveScroll + viewportLines) last--
  if (first > last) first = Math.max(0, last)
  const shift = first < rows.length ? effectiveScroll - layout.starts[first] : 0
  const sel = store.selection
  const selRange = sel !== null ? composerSelectionRange(sel) : null

  // The reasoning row animates its leading glyph while the model is actively
  // producing it: the agent is running (not paused) and the tail item is that
  // reasoning row (it is the streaming target). Once thinking ends and an
  // assistant body follows, the tail changes and the glyph goes static.
  const tailItem = items.at(-1)
  const reasoningActive = store.running && !store.paused && tailItem?.kind === 'reasoning'
  const renderRow = (r: Row): React.ReactNode =>
    r.type === 'steps'
      ? <Box key="steps" marginTop={r.top} marginBottom={r.bottom}><StepsRow steps={steps} /></Box>
      : (
        <Box key={r.item.key} marginTop={r.top} marginBottom={r.bottom} flexShrink={0}>
          <MemoTranscriptItemView
            item={r.item}
            expandReasoning={expandReasoning}
            themeEpoch={themeEpoch}
            usable={usable}
            active={reasoningActive && r.item.key === tailItem?.key}
          />
        </Box>
      )

  const renderComposerText = (): React.ReactNode => {
    const len = input.length
    const seg = (a: number, b: number, inv: boolean, k: string): React.ReactNode =>
      a < b ? <Text key={k} inverse={inv}>{input.slice(a, b)}</Text> : null
    if (selRange === null) return <>{input}</>
    const s = selRange.start
    const e = selRange.end
    return (
      <>
        {seg(0, s, false, 's0')}
        {seg(s, e, true, 's1')}
        {seg(e, len, false, 's2')}
      </>
    )
  }

  const overlay = (id: string): React.ReactNode | undefined =>
    store.panel === id ? props.tui.panels.byId(id)?.render(store) : undefined

  return (
    <Box flexDirection="column" height={store.rows}>
      {/* Background layer: paints theme.bg so colorscheme switches are
          visible (the transcript/composer are transparent and would otherwise
          show the terminal background). The painted text is static — Ink's
          line diff skips rewriting after the first frame. */}
      <Box position="absolute" width="100%" height={store.rows} flexDirection="column">
        <Text backgroundColor={theme.bg} wrap="wrap">{' '.repeat(Math.max(0, store.width * store.rows))}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="row" width="100%">
        <Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          {items.length === 0
            ? <Text dimColor>Start typing to begin a session. Type <Text color={theme.primary}>/</Text> for commands.</Text>
            : (
              <Box flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden" flexDirection="column">
                <Box marginTop={-shift} flexDirection="column">
                  {rows.slice(first, last + 1).map((r) => renderRow(r))}
                </Box>
              </Box>
            )}
          {/* The approval and question docks live INSIDE the message column so
              their widths always track the (resizable) message box, never the
              sidebar. */}
          {overlay('approval')}
          {overlay('question')}
          {/* Command palette as a bottom-anchored ABSOLUTE overlay inside the
              message column: it takes no layout height, so the transcript keeps
              its full viewport (no compression) and the palette floats just
              above the composer. Each row is opaque (theme.bg) so the
              underlying transcript text never shows through between rows. */}
          {isSlash && filtered.length > 0 && (
            <Box position="absolute" width="100%" height="100%" flexDirection="column" justifyContent="flex-end">
              <Box borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={0}>
                {filtered.map((c, i) => {
                  const line = `/${c.name} — ${c.hint}`
                  const pad = Math.max(1, Math.max(0, usable) - visualWidth(line) - 1)
                  return (
                    <Text key={c.name} color={i === effectiveIndex ? theme.accent : undefined} inverse={i === effectiveIndex} backgroundColor={theme.bg} wrap="truncate">
                      {line}{' '.repeat(pad)}
                    </Text>
                  )
                })}
              </Box>
            </Box>
          )}
        </Box>
        {showSidebar && (
        <Box borderStyle="round" borderColor={theme.border} width={sidebarWidth} flexShrink={0} minHeight={0} flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          <Text color={theme.accent} bold>Steps {stepsTotal > 0 ? `${stepsDone}/${stepsTotal}` : ''}</Text>
          {steps.length === 0
            ? <Text dimColor>no plan yet</Text>
            : <StepRows steps={steps} />}
          <Text dimColor>session {store.session === undefined ? '' : String(store.session.id)}</Text>
          <Box flexGrow={1} />
          {/* Version sits flush against the workspace path at the sidebar bottom. */}
          <Text dimColor>dsh-tui {APP_VERSION}{BETA_FOOTER_SUFFIX}</Text>
          <Text dimColor wrap="truncate">{store.workspace}</Text>
        </Box>
        )}
      </Box>

      <Box flexShrink={0} borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column" justifyContent="space-between"
        height={composerHeight(width, input, COMPOSER_MIN_HEIGHT) + (store.composerImage !== null ? 1 : 0)}>
        <Box flexDirection="column">
          {store.composerImage !== null && (
            <Text color={theme.primary}>
              [Image: {store.composerImage.name}] <Text dimColor>· Esc to remove</Text>
            </Text>
          )}
          <Text color={theme.text} wrap="wrap">{status}{renderComposerText()}</Text>
        </Box>
        <Box flexDirection="row" gap={2} paddingY={1} marginTop={1}>
          <Text color={permissionColor}>{store.permission === 'danger-full-access' ? '🔓' : '🔒'} {permissionLabel} (Tab)</Text>
          <Box flexGrow={1} />
          {modelLabel !== '' && (
            <Text dimColor>Model: {modelBaseLabel}
              {effortName !== '' && <Text color={theme.warning} bold> · {effortName}</Text>}
            </Text>
          )}
        </Box>
      </Box>

      <Box flexShrink={0} flexDirection="row" borderStyle="round" borderColor={theme.border} paddingX={1} height={STATUS_BAR_HEIGHT}>
        {/* The busy indicator (Working/Paused/Idle + icon) is REPLACED on the
            left while a transient status message (e.g. "copied: …") flashes —
            so the confirmation takes the Idle slot for ~2.5s, then Idle returns.
            NOT a transcript row, so it cannot re-layout the transcript or slide
            the selection highlight. */}
        {store.statusFlash
          ? <Text color={theme.success} wrap="truncate">{store.statusFlash.text}</Text>
          : <BusyIndicator animate={store.running} paused={store.paused} />}
        {/* The steps/turns · tokens stats are pinned to the RIGHT edge of the
            status bar regardless of the busy indicator's width: an explicit
            flex spacer pushes the stats group flush right, and the group
            truncates instead of wrapping if the terminal is narrow. */}
        <Box flexGrow={1} />
        {statsLine !== '' && (
          <Box flexShrink={0}>
            <Text dimColor wrap="truncate">{statsLine}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

/** Install the per-frame suffix hook the patched Ink frame writer appends to
 *  every full-screen frame: it re-shows the REAL terminal cursor and parks it
 *  at the composer caret (the macOS IME candidate window anchors to it). The
 *  connect dialog hides the cursor instead (its input is masked dots). */
export function installFrameSuffix(): void {
  const frameSuffix = (): string => {
    // Park the REAL cursor at the composer caret only while the conversation is
    // the active panel (the macOS IME candidate window anchors to it). Any
    // other panel (/sessions, /models, /theme, /help, /export, connect) has its
    // own surface and draws its own caret; re-showing the hardware cursor there
    // would park it at the (hidden) composer caret cell — which can land ON a
    // list row and look like a stray cursor jumping around. Hide it instead.
    if (store.panel !== 'conversation') return '\x1b[?25l'
    const cell = composerCaretCell()
    return `\x1b[?25h${cell === null ? '' : `\x1b[${cell.row};${cell.col}H`}`
  }
  ;(globalThis as unknown as { __dshTuiFrameSuffix?: () => string }).__dshTuiFrameSuffix = frameSuffix
}

/** Register the conversation (fullscreen) panel. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  // The patched Ink frame controller highlights the selection in place (over the
  // real markdown/rail/colors). Clamp the highlight to the transcript viewport:
  // a selection over the composer/status already has its OWN React inverse, and a
  // frame-buffer inverse there would double it (cancelling the composer highlight).
  // 1-based SGR selection rows -> 0-based grid; stop at the last transcript row
  // (the composer box begins at `composerTop`).
  store.setFrameSelectionGuard((sel) => {
    const width = store.width
    const rows = store.rows
    const composerH = composerHeight(width, store.input, COMPOSER_MIN_HEIGHT)
    const composerTop = rows - composerH - STATUS_BAR_HEIGHT + 1
    const y1 = Math.max(0, Math.min(sel.aRow, sel.cRow) - 1)
    const y2 = Math.min(composerTop - 2, Math.max(sel.aRow, sel.cRow) - 1)
    if (y2 < y1) return null // selection sits entirely in the composer/status
    const x1 = Math.max(0, Math.min(sel.aCol, sel.cCol) - 1)
    const x2 = Math.min(width - 1, Math.max(sel.aCol, sel.cCol) - 1)
    return { x1, y1, x2, y2 }
  })
  tui.panels.register({
    id: 'conversation',
    mode: 'fullscreen',
    render: () => <ConversationMain tui={tui} />,
    handleKey: (k) => { conversationKey(k, tui); return true },
  })
  installFrameSuffix()
}
