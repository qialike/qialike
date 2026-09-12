/**
 * The conversation panel plugin (`tui-panel-conversation`): the terminal's main
 * surface — transcript, todo-steps sidebar, composer, status bar. Registers the
 * `conversation` (fullscreen) panel against the `tui` service. Session history
 * management lives in the `/sessions` plugin (`tui-sessions`).
 *
 * @module @yourname/dsh-tui-app/panels-conversation
 */

import { Box, Text, useStdin, measureElement, type DOMElement } from 'ink'
import React, { useEffect, useMemo, useState } from 'react'
import { spawnSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import {
  describeActivity,
  eventRateTick,
  APP_VERSION,
  sessionLoadBar,
  sessionLoadPercent,
  compactionRowHeader,
  preparingRequestStatusText,
  compactionStatusText,
  sessionLoadingStatusText,
  sessionLoadingText,
  BETA_FOOTER_SUFFIX,
  type Store,
  type TranscriptItem,
  type StepItem,
  type CommandItem,
  type TuiService,
} from '../index.tsx'
import { MarkdownText, markdownPlain, estimateMarkdownHeight, visualWidth, countWrappedLines } from '../markdown.tsx'
import { stripTerminalControls } from '../terminal-safe.ts'
import wrapAnsi from 'wrap-ansi'
import { SIDEBAR_MIN_WIDTH, WHEEL_STEP, dockInnerWidth } from '../config.ts'
import { questionDockRows } from '../question-layout.ts'
import { questionPresentation } from '../plan-review.ts'
import {
  HERO_ART_CELL_GLYPH,
  HERO_COMPOSER_EXTRA_ROWS,
  HERO_PLACEHOLDER,
  HERO_TITLE_CARD_GAP,
  HERO_TITLE,
  HERO_WORDMARK,
  heroArtCells,
  heroArtInkColors,
  heroArtMarkKind,
  heroArtMode,
  heroComposerLeft,
  heroComposerWidth,
  heroLayout,
  heroMarkRows,
  type HeroMarkKind,
} from '../hero-layout.ts'
import { surfaceRegion, sidebarContentBand, type SurfaceRegion, type SurfaceGeometry } from '../pointer-region.ts'
import { formatSessionStatsParts } from '../session-stats.ts'
import { sessionDisplayTitle } from '../session-titles.ts'
import { logError, logErrorFileOnly } from '../log.ts'
import { HARNESS_VERSION } from '../harness-version.ts'
import { theme } from '../theme.ts'
import type { RawKey } from '../stdin.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-panel-conversation'

/** The store service, resolved at apply() from `tuiStore`. The panel plugins
 *  are separate bundles: importing the store VALUE from index.tsx would create
 *  a second store instance, so the store is fetched through the service seam. */
let store!: Store

/** Whether the COMMAND PALETTE is painted this frame (`/` + at least one
 *  match). Set by the render, read by {@link installFrameSuffix}: while the
 *  popup covers the composer card (hero — the card sits mid-screen and the
 *  popup is lifted onto it) the hardware caret must NOT blink through it. */
let commandPaletteOpen = false

/** The `tui` service must be available to register panels and commands. */
export const inject = ['tui']

const COMPOSER_MIN_HEIGHT = 5

/** Minimum composer BOX height: the hero card is a two-row input box
 *  (`HERO_COMPOSER_INPUT_ROWS`), the docked card keeps a single row so the
 *  transcript viewport is not eaten by chrome. Every width/height/row
 *  computation funnels through this, so caret, mouse mapping and the painted
 *  card can never disagree. */
function composerMinHeight(): number {
  return COMPOSER_MIN_HEIGHT + (store.hero ? HERO_COMPOSER_EXTRA_ROWS : 0)
}

/** Theme-aware muted text: bright on DARK backgrounds (the terminal's own
 *  colors, status bar, hints, empty-state, composer footer) and a dark gray on
 *  the LIGHT skin. The old single #b8b8c0 was unreadable against a white page;
 *  mutedReadable() alone (#808080) is a touch too dim on dark. */
function isLightTheme(): boolean {
  const bg = theme.bg.replace(/^#/, '')
  if (bg.length !== 6) return false
  const r = parseInt(bg.slice(0, 2), 16)
  const g = parseInt(bg.slice(2, 4), 16)
  const b = parseInt(bg.slice(4, 6), 16)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5
}
function mutedReadable(): string {
  return isLightTheme() ? theme.textMuted : '#b8b8c0'
}

// Message-area layout:
// a USER message is a left colored rail (┃ + space) with the text in a column
// next to it (hanging indent), and an ASSISTANT message is indented by a few
// columns before its markdown. Both reduce the text column width by the same
// amount, so estItemLines/layout stay in sync.
//
// Spacing is LAYOUT MARGINS on the message blocks, never
// painted blank rows: a blank row rendered as text can measure 0 rows in a
// scroll re-layout and merge into the next line (the glyph overwrites the next
// line's first cell — the observed PgUp gap collapse), while a margin is pure
// layout and cannot collapse. Margins per base row (see buildRows):
//   user message content: 1 blank above (top rail pad; 2 when not the first
//                          row, where a between-message pad also applies) and
//                          1 blank below (bottom rail pad);
//   every other row      : 1 blank above (between-message pad), none below.
// Message-body alignment (mirrored from the /sessions screenshot):
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
// Between-message pad rows (marginTop={1} between messages).
const MESSAGE_PAD_ROWS = 1
// Rail pads above/below a user message's text (keeping user messages
// visually separated); these plus MESSAGE_PAD_ROWS give the user block its
// 2 blank rows above and below (matches the legacy blank-row layout).
const USER_PAD_ROWS = 1

/** The status bar height in terminal rows (bordered single-line bar). */
const STATUS_BAR_HEIGHT = 3

const SPINNER_FRAMES = ['⠋', '⠙', '⠸', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Collapsed Think preview for the LIVE streaming tail — ONE fixed row
 *  (harness-web parity: a fixed-height slot that rolls the newest reasoning
 *  instead of growing the layout). Content = the latest line (text after the
 *  final newline), windowed from its END so it always fits one visual line;
 *  the row keeps exactly 2 terminal rows (Think label + preview) whether
 *  streaming or settled, so the message area never jumps mid-think. Used only
 *  while the row is the streaming tail; SETTLED rows show the first line via
 *  thinkSettledLine (web `running ? latestLine : firstLine`). Deterministic
 *  from (text, usable) alone, so render/estimate/copy share one string. */
function thinkLiveLine(text: string, usable: number): string {
  // The preview tracks the LAST logical line. Providers may emit a reasoning
  // line atomically with its newline, so the raw tail after the final '\n' is
  // momentarily EMPTY between lines — without a fallback the preview would sit
  // blank (looks "stuck") until the next line's first characters arrive. Trim
  // trailing whitespace/newlines FIRST so the previous non-empty line stays on
  // show while the stream waits for the next chunk (continuous rolling).
  let seg = text.trimEnd()
  const nl = seg.lastIndexOf('\n')
  seg = nl === -1 ? seg : seg.slice(nl + 1)
  if (seg === '') return '\u00a0' // keep the reserved preview row occupied
  const budget = Math.max(8, MESSAGE_TEXT_WIDTH(usable) - 1) // cells; reserve the leading …
  if (visualWidth(seg) <= budget) return seg
  let cells = 0
  let from = seg.length
  while (from > 0) {
    const cw = visualWidth(seg[from - 1]!)
    if (cells + cw > budget - 1) break
    cells += cw
    from -= 1
  }
  return `…${seg.slice(from)}`
}

/** First LOGICAL line of a block of text (everything before the first newline;
 *  the whole text when it has none) — the harness-web settled Think/tool
 *  preview source. */
function firstLineOf(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** Head-window one line so it fits `widthCells` (keeps the HEAD, adds `…` at
 *  the end) — web CSS ellipsis semantics for the SETTLED collapsed preview. */
function capHead(text: string, widthCells: number): string {
  const seg = text.trimEnd()
  if (seg === '') return '\u00a0'
  if (visualWidth(seg) <= widthCells) return seg
  let cells = 0
  let out = ''
  for (const ch of seg) {
    const cw = visualWidth(ch)
    if (cells + cw > widthCells - 1) break
    out += ch
    cells += cw
  }
  return `${out}…`
}

/** Collapsed Think preview when the reasoning block is SETTLED (harness-web
 *  `ReasoningRow` settles to the FIRST line): first logical line, head-capped
 *  to one terminal line with `…`. */
function thinkSettledLine(text: string, usable: number): string {
  const seg = firstLineOf(text).trimEnd()
  if (seg === '') return '\u00a0' // keep the reserved preview row occupied
  return capHead(seg, Math.max(8, MESSAGE_TEXT_WIDTH(usable) - 1))
}

/** Collapsed Think preview for one reasoning row: while the row is the LIVE
 *  streaming tail follow the newest line (thinkLiveLine); once settled show
 *  the FIRST line (thinkSettledLine) — matching harness-web ReasoningRow
 *  `running ? latestLine : firstLine`. */
function thinkPreviewLine(text: string, liveTail: boolean, usable: number): string {
  return liveTail ? thinkLiveLine(text, usable) : thinkSettledLine(text, usable)
}

/** Tail-window one line so it fits `widthCells` (keeps the END, adds `…` at
 *  the front). The collapsed single-line preview uses this so that, when the
 *  content exceeds the fixed one line, the NEWEST (tail) content stays visible
 *  and "scrolls" as more streams in, rather than pinning the head (harness
 *  `data-follow-end` semantics). Deterministic from (text, widthCells) alone. */
function capTail(text: string, widthCells: number): string {
  const seg = text.trimEnd()
  if (seg === '') return '\u00a0'
  if (visualWidth(seg) <= widthCells) return seg
  let cells = 0
  let from = seg.length
  while (from > 0) {
    const cw = visualWidth(seg[from - 1]!)
    if (cells + cw > widthCells - 1) break
    cells += cw
    from -= 1
  }
  return `…${seg.slice(from)}`
}

/** Canonical tool-row TITLES, verbatim from the harness web client's locale
 *  (`tool.title.*` EN in ui-conversation locales + the ui-tool variant/title
 *  mapping) so dsh-tui's headers read the same as deepseek-harness. Unknown
 *  tool names keep their own name (web shows generic "Tool call" with the name
 *  in the summary; keeping the name inline stays unambiguous in one line). */
const TOOL_ROW_TITLES: Readonly<Record<string, string>> = {
  bash: 'Bash',
  pwsh: 'Pwsh',
  read: 'Read',
  web_fetch: 'Fetch',
  web_search: 'Search',
  grep: 'Search',
  glob: 'Search',
  write: 'Write',
  edit: 'Edit',
  run_code: 'Code',
  todo_write: 'Update to-do list',
}

/** Per-tool leading GLYPH (terminal stand-in for harness-web vector icons;
 *  terminal-TUI family). The glyph is fixed per tool — while the tool is in
 *  flight the render swaps it for a live spinner frame (see ToolLiveHeader);
 *  after settling it returns and ok/error read via the header color/✗. */
const TOOL_ROW_ICONS: Readonly<Record<string, string>> = {
  bash: '$',
  pwsh: '$',
  read: '←',
  web_fetch: '%',
  web_search: '◈',
  grep: '✱',
  glob: '✱',
  write: '⚙',
  edit: '←',
  run_code: '▷',
  todo_write: '☑',
}

/** One-line per-tool detail from raw args (web-style summary keys): bash/pwsh
 *  show the model-given `description` (falling back to the command), read/
 *  web_fetch/write/edit show the path, grep/glob/web_search the query/pattern,
 *  run_code the description (falling back to the command), todo_write
 *  done/total (+active). `null` → caller falls back. */
function toolDetail(name: string, args: Record<string, unknown>): string | null {
  const take = (keys: readonly string[]): string | null => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return null
  }
  const collapse = (value: string): string => value.replace(/\s*\n\s*/g, ' ')
  if (name === 'bash' || name === 'pwsh') {
    const picked = take(['description', 'command', 'cmd'])
    return picked === null ? null : collapse(picked)
  }
  // The harness read/write/edit schemas name the path `file_path` (required);
  // camelCase/legacy keys are tolerated for other callers.
  if (name === 'read' || name === 'web_fetch') return take(['path', 'file_path', 'url', 'file', 'id'])
  if (name === 'write' || name === 'edit' || name === 'file_mutation') return take(['path', 'file_path', 'file', 'filePath'])
  if (name === 'grep' || name === 'glob' || name === 'web_search') return take(['query', 'pattern', 'url', 'q'])
  if (name === 'run_code') {
    const picked = take(['description', 'command', 'cmd'])
    return picked === null ? null : collapse(picked)
  }
  if (name === 'todo_write') {
    const todos = args['todos']
    if (Array.isArray(todos)) {
      let done = 0
      let active = 0
      for (const it of todos) {
        const status = it !== null && typeof it === 'object' ? (it as { status?: unknown }).status : undefined
        if (status === 'completed') done += 1
        else if (status === 'in_progress') active += 1
      }
      const base = `${done}/${todos.length}`
      return active > 0 ? `${base} · ${active} active` : base
    }
    return null
  }
  return null
}

/** Live single-line tool state passed ONLY by the animating render (running
 *  row during an active run): the current spinner frame (replaces the static
 *  glyph) and the whole elapsed seconds since the call started (tail). The
 *  estimate/selection-copy paths call without it and get the static header —
 *  row height is one line either way, so the layout never moves. */
interface ToolLive {
  readonly frame: string
  readonly seconds: number | null
}

/** One-line tool summary row text: a per-tool GLYPH icon (terminal stand-in
 *  for the harness web vector icons — terminal-TUI family: `$` bash, `←`
 *  read/edit, `⚙` write, `✱` search, `%` web fetch, `◈` web search, `☑`
 *  todo, `◇` unknown) + canonical TITLE (harness-web `tool.title.*`, e.g.
 *  "Bash") with the argument detail appended when the args parse and name a
 *  known shape, plus a trailing `…` marker while the result body is
 *  collapsed and a `✗` suffix on error rows (color-blind visible, web state
 *  dot equivalent). Unknown tools use the web generic title "Tool call" with
 *  the real name riding the summary. Deterministic from (item, usable) —
 *  render, height estimate and selection copy share it, so they never drift;
 *  `live` is the one render-only exception (see ToolLive). Exported for the
 *  row-math unit tests (tests/tool-row-live.test.ts). */
export function toolRowHeader(item: TranscriptItem, usable: number, live: ToolLive | null = null): string {
  const name = item.text.slice(2)
  const key = name.toLowerCase()
  const running = item.tool?.state === 'running'
  const icon = running && live !== null
    ? live.frame
    : (TOOL_ROW_ICONS[key] ?? '◇')
  const known = TOOL_ROW_TITLES[key]
  const width = Math.max(8, MESSAGE_TEXT_WIDTH(usable))
  const body = item.tool?.body
  const marker = body !== undefined && !store.isToolExpanded(item.key) ? '…' : ''
  const error = item.text.startsWith('✗ ')
  let detail: string | null = null
  if (item.tool?.argsRaw !== undefined) {
    try {
      const args: unknown = JSON.parse(item.tool.argsRaw)
      detail = args !== null && typeof args === 'object'
        ? toolDetail(key, args as Record<string, unknown>)
        : null
    } catch {
      // Malformed/truncated args: fall back to the plain label.
    }
  }
  // Known tool: `icon Title[ · detail]`. Unknown: web semantics — title is
  // "Tool call" and the real name (+detail) rides the summary. On ERROR rows
  // the web row's collapsed summary is the FAILURE's first line, which
  // replaces the args-derived detail.
  const head = known === undefined
    ? `${icon} Tool call · ${name}`
    : `${icon} ${known}`
  const errorFirst = error && body !== undefined && body.trim() !== '' ? firstLineOf(body) : null
  let label = detail === null ? head : `${head} · ${detail}`
  if (errorFirst !== null) label = `${head} · ${errorFirst}`
  const errSuffix = error ? ' ✗' : ''
  // The live elapsed tail rides the row END (like the marker/✗, it always
  // survives), so a narrow row truncates the detail first, never the seconds.
  const secondsSuffix = running && live !== null && live.seconds !== null ? ` · ${live.seconds}s` : ''
  const fixed = marker + errSuffix + secondsSuffix
  const budget = width - visualWidth(fixed)
  // Collapsed tool preview follows the END of the label so the newest part stays
  // visible and "scrolls" when the label exceeds the fixed one line (harness
  // data-follow-end), instead of pinning the head. ERROR rows instead keep the
  // head (icon/title + the failure's first line) — web ellipsis semantics.
  const capped = error ? capHead(label, Math.max(1, budget)) : capTail(label, Math.max(1, budget))
  return `${capped}${fixed}`
}

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

/** Index of the command whose palette row occupies screen row `row`, or -1. The
 *  palette is a bottom-anchored bordered box just above the composer; this
 *  mirrors the layout math so a mouse click/wheel can drive it. */
function commandPaletteIndexFromRow(row: number, tui: TuiService): number {
  const n = filteredCommands(tui).length
  if (n === 0) return -1
  const width = process.stdout.columns ?? 80
  const height = process.stdout.rows ?? 24
  const band = composerBand(width, height)
  // Palette box: bordered (2 rows) + n content rows, sitting just above the
  // composer card. Docked: the box bottom is ~cardTop−3 (message-column
  // paddingY + gap). Hero: the popup is centered on the card and lifted by
  // `paletteBottomMargin`, so it rests DIRECTLY on the card's top border.
  const contentFirst = store.hero ? band.top - n - 1 : band.top - n - 3
  const idx = row - contentFirst
  return (idx >= 0 && idx < n) ? idx : -1
}

/** Run the command at palette index `index`, taking the input's remainder as its
 *  args (same as pressing Enter with that row highlighted). */
function runCommandAt(index: number, tui: TuiService): void {
  const chosen = filteredCommands(tui)[index]
  if (chosen === undefined) return
  const input = store.input
  // Skip the leading '/' (input.length > name.length) so the remainder is the
  // args AFTER the command name (without this the last letter was included).
  const remainder = input.slice(chosen.name.length + 1).trim()
  store.setInput('')
  resetHistoryBrowse()
  store.scrollBottom()
  chosen.run(remainder)
}

// ── row measurement ─────────────────────────────────────────────────────────

const measuredHeights = new Map<string, number>()
let lastLayoutWidth = -1 // last width the row-height cache was computed for
/** Last {@link Store.assistantSettleEpoch} the layout has re-parsed for: a
 *  change forces the settled row's markdown height to be parsed exactly once. */
let lastSettleEpoch = -1
const lastMeasuredNotify = new Map<string, number>()

/** Minimum gap between measured-height writes for one row (ms). Kept short
 *  enough that the streaming tail's real height becomes authoritative within
 *  ~100 ms (the mdast estimate is deliberately debounced — 优化1 — so measured
 *  heights must lead the layout while a row grows), yet long enough that a
 *  per-delta notify storm never re-lays the whole transcript every frame. */
const MEASURE_THROTTLE_MS = 100

/** Record one painted row height and re-lay the transcript when it really
 *  changed.
 *
 *  The measured value is the TRUTH for the layout (the markdown estimate is
 *  only a placeholder for rows that were never painted), so any real change
 *  must be stored — including a change of exactly one row. The earlier rule
 *  ("ignore |Δ| ≤ 1") silently dropped the LAST row of growth of a long
 *  streamed answer: the cached height stayed one row short, `content` (hence
 *  `maxScroll`) stayed one row short, and with follow-tail the newest wrapped
 *  line fell below the viewport — the "answer's tail never shows up, End does
 *  not help" report (see dsh-tui-development §2.5.51).
 *
 *  Two safeguards replace that tolerance:
 *   · a reading more than one row BELOW the markdown estimate is the documented
 *     diff-render collapse (a row measuring 1 instead of 3), never a real
 *     height → ignored, so it can neither poison the cache nor shrink the view;
 *   · `force` marks a measurement taken while the row's text has been stable
 *     (the effect's 400/900 ms samples): those are authoritative and bypass the
 *     ±1 noise tolerance that still applies to a mid-commit reading.
 * @param key - transcript row key.
 * @param rows - measured painted height (content rows, margins excluded).
 * @param est - the row's markdown estimate (sanity floor for the reading).
 * @param opts.force - text-stable (authoritative) measurement.
 * @param opts.throttled - apply {@link MEASURE_THROTTLE_MS} (immediate path). */
function setMeasuredHeight(
  key: string,
  rows: number,
  est: number,
  opts: { force?: boolean; throttled?: boolean } = {},
): void {
  const prev = measuredHeights.get(key)
  if (!shouldStoreMeasured(rows, prev, est, opts.force === true)) return
  if (opts.throttled === true) {
    const now = Date.now()
    const last = lastMeasuredNotify.get(key)
    if (last !== undefined && now - last < MEASURE_THROTTLE_MS) return
    lastMeasuredNotify.set(key, now)
  }
  measuredHeights.set(key, rows)
  if (debugTail) {
    logErrorFileOnly('tail',
      `measure key=${key} rows=${rows} prev=${prev ?? -1} est=${est} force=${opts.force === true}`)
  }
  // Row heights changed: the layout memo must recompute. The dedicated epoch
  // (not the generic render `version`) is what invalidates it, so typing and
  // phase/hover churn never re-lay the whole transcript.
  store.bumpMeasure()
  store.touch()
}

/** Whether a fresh reading replaces the stored row height (exported for the
 *  regression test; the rules are the whole point of §2.5.51):
 *   · a reading more than one row BELOW the estimate is a diff-render collapse
 *     (a row momentarily measuring 1 instead of 3) — never a real height;
 *   · an unchanged reading is a no-op;
 *   · anything else is real growth/shrink and MUST be stored, even by one row:
 *     dropping it leaves the transcript's predicted content one row short, and
 *     with follow-tail the newest wrapped line lands below the viewport.
 *     Only a non-authoritative (`force === false`) mid-commit reading keeps the
 *     ±1 tolerance that suppresses diff-render noise.
 *  @param rows - the fresh measured height.
 *  @param stored - the height already cached for this row (undefined if none).
 *  @param est - the row's markdown height estimate.
 *  @param force - the row's text was stable when this reading was taken. */
export function shouldStoreMeasured(
  rows: number,
  stored: number | undefined,
  est: number,
  force: boolean,
): boolean {
  if (rows + 1 < est) return false
  if (stored === rows) return false
  if (!force && stored !== undefined && Math.abs(stored - rows) <= 1) return false
  return true
}

function rowHeight(key: string, fallback: number): number {
  return Math.max(fallback, measuredHeights.get(key) ?? 0)
}

// ── transcript rendering helpers ────────────────────────────────────────────

type Row =
  | { type: 'item'; item: TranscriptItem; top: number; bottom: number }
  | { type: 'steps'; top: number; bottom: number }

function itemContent(item: TranscriptItem, expandReasoning: boolean, toolExpanded: boolean, compactionExpanded: boolean, hovered: boolean, usable: number, toolLive: boolean, reasoningLive: boolean): React.ReactNode {
  // Terminal-injection guard: strip control bytes from every untrusted text
  // surface before it enters the render tree (dsh-tui-security.md). The store
  // keeps the original text; only the display is sanitized.
  const text = stripTerminalControls(item.text)
  if (item.kind === 'assistant') {
    // Assistant: indent the markdown to the shared content column.
    return <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS}><MarkdownText text={text} usable={MESSAGE_TEXT_WIDTH(usable)} /></Box>
  }
  if (item.kind === 'plan') {
    // A plan submitted for review (harness `exit_plan_mode`): a labelled block
    // whose markdown body is ALWAYS fully unfolded (harness-web decision-card
    // parity). Not collapsible — the plan is the review subject and must read
    // in the message area while the dock below only asks 确认执行/继续规划.
    // The label is a tag chip so the block reads as a document, not a message.
    return (
      <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS} flexDirection="column">
        <Text color={theme.bg} backgroundColor={theme.accent}>{' Plan '}</Text>
        <MarkdownText text={text} usable={MESSAGE_TEXT_WIDTH(usable)} />
      </Box>
    )
  }
  if (item.kind === 'reasoning') {
    // Web-parity Think disclosure (harness ReasoningRow): the label row is
    // ALWAYS shown and the summary under it is ONE line. While this row is the
    // LIVE streaming tail the preview follows the newest line (thinkLiveLine);
    // once settled it shows the FIRST line, head-capped — exactly web's
    // `running ? latestLine : firstLine`. Row height is a constant 2 (label +
    // summary) whether streaming or settled; clicking the header (or /think)
    // expands the full body. Hover highlights the header so it reads as
    // clickable.
    return (
      <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS} flexDirection="column">
        <Text inverse={hovered || undefined} color={mutedReadable()}>{expandReasoning ? '-' : '+'} Think</Text>
        {expandReasoning
          ? <Text color={mutedReadable()} wrap="wrap">{text}</Text>
          : <Text color={mutedReadable()} wrap="wrap">{thinkPreviewLine(text, reasoningLive, usable)}</Text>}
      </Box>
    )
  }
  if (item.kind === 'compaction') {
    // Compaction-checkpoint row (web parity: `CompactionItem`): ONE line naming
    // the compaction and how much history it replaced, expandable (click /
    // /think) to the summary the model wrote. The header text comes from the
    // shared `compactionRowHeader`, i.e. exactly what the scroll/selection
    // mirror in `buildTranscriptRows` emits — the two can never disagree.
    const facts = item.compaction ?? {}
    const summary = facts.summary === undefined ? undefined : stripTerminalControls(facts.summary)
    const expanded = summary !== undefined && compactionExpanded
    return (
      <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS} flexDirection="column">
        <Text inverse={hovered || undefined} color={mutedReadable()} wrap="truncate">
          {compactionRowHeader(facts, expanded)}
        </Text>
        {expanded
          ? <MarkdownText text={summary} usable={MESSAGE_TEXT_WIDTH(usable)} />
          : null}
      </Box>
    )
  }
  if (item.kind === 'tool') {
    // Tool rows (web-parity collapsed card): running = live single line,
    // settled = `✓ / ✗ <summary>` with the result/error body HIDDEN until
    // expanded (mouse click on the row). The summary is ONE line; when the
    // label exceeds it the summary windows the END (capTail) so the newest
    // part stays visible — harness `data-follow-end`.
    // A RUNNING row does not sit still: while the agent is running (not
    // paused) the static glyph swaps for a clock-driven spinner frame and the
    // line gains a live `· Ns` elapsed tail (ToolLiveHeader, own 100 ms
    // timer) — the terminal stand-in for the harness web running sweep, so a
    // long Bash/Read/Write call never reads as a frozen row. Only rows opened
    // by THIS run animate (startedAt >= run start), never stale replay
    // leftovers. `toolExpanded`/`hovered`/`toolLive` arrive as PROPS so the
    // memoized row re-renders on a click or a run start/stop (a store read
    // inside this component would be invisible to the memo — that was why
    // Think toggled but tool rows did not).
    const isError = text.startsWith('✗ ')
    // Tool body (result/error output) is untrusted content: strip control
    // bytes before it can reach the terminal via the expanded row.
    const rawBody = item.tool?.body
    const body = rawBody === undefined ? undefined : stripTerminalControls(rawBody)
    const expanded = body !== undefined && toolExpanded
    const startedAt = item.tool?.startedAt
    const runningLive = toolLive
      && item.tool?.state === 'running'
      && startedAt !== undefined
      && startedAt >= store.busySince
    return (
      <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS} flexDirection="column">
        {runningLive
          ? <ToolLiveHeader item={item} usable={usable} />
          : <Text inverse={hovered || undefined} color={mutedReadable()} wrap="wrap">{stripTerminalControls(toolRowHeader(item, usable))}</Text>}
        {body !== undefined && expanded && (
          <Text color={isError ? theme.error : mutedReadable()} wrap="wrap">{body}</Text>
        )}
      </Box>
    )
  }
  if (item.kind === 'user') {
    // User block: a primary left border (┃) with the text on a
    // panel background. Ink's Box has no background, so each wrapped line is its
    // own pair of <Text> spans — a ┃ rail span plus the text span — padded to
    // the content width so the panel block spans from the content column to the
    // right margin.
    // The blank rows above/below the block are LAYOUT MARGINS on the row's
    // wrapper (see buildRows), not painted rows: painted blanks collapse in
    // scroll re-layouts (the PgUp gap bug); margins always survive.
    const w = MESSAGE_TEXT_WIDTH(usable)
    const lines = wrapRows(text, w)
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
  if (item.kind === 'error') {
    // Run-failure row (billing/quota, transport after retries, credentials…):
    // web turn-error parity — visibly an error, not a silent stop.
    return (
      <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS}>
        <Text color={theme.error} wrap="wrap">⚠ {text}</Text>
      </Box>
    )
  }
  return (
    <Box width="100%" paddingLeft={MESSAGE_LEFT_COLS} paddingRight={MESSAGE_RIGHT_COLS}>
      <Text color={mutedReadable()} wrap="wrap">
        {text}
      </Text>
    </Box>
  )
}

/** Self-ticking one-line header for a RUNNING tool row: re-renders every
 *  100 ms and derives the spinner frame + elapsed seconds from the wall clock
 *  (same liveness model as the status bar), so the row keeps moving even
 *  though the memoized transcript row above it has stable props. The interval
 *  dies with the component (run end / tool settle / toolLive drop), and the
 *  frame is a pure function of Date.now(), so a missed tick can never freeze
 *  the glyph. */
function ToolLiveHeader(props: { item: TranscriptItem; usable: number }): React.JSX.Element {
  const [, setTick] = React.useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 100)
    return () => clearInterval(timer)
  }, [])
  const now = Date.now()
  const frame = SPINNER_FRAMES[Math.floor(now / 100) % SPINNER_FRAMES.length]
  const started = props.item.tool?.startedAt
  const seconds = started === undefined ? null : Math.max(0, Math.floor((now - started) / 1000))
  return (
    <Text color={mutedReadable()} wrap="wrap">
      {stripTerminalControls(toolRowHeader(props.item, props.usable, { frame, seconds }))}
    </Text>
  )
}

/** Memoized transcript row: unchanged item objects (stable references, only
 *  the streaming tail is replaced) skip re-render/parse on typing, scroll and
 *  other notify cycles. */
const MemoTranscriptItemView = React.memo(function TranscriptItemView(props: {
  item: TranscriptItem
  expandReasoning: boolean
  toolExpanded: boolean
  /** Disclosure state of THIS row when it is a compaction checkpoint (same
   *  per-row override map as tool rows: click toggles it, /think flips all). */
  compactionExpanded: boolean
  hovered: boolean
  themeEpoch: number
  usable: number
  /** Whether the agent is live (running && !paused): running TOOL rows animate
   *  (spinner + elapsed tail) only while this is true — see ToolLiveHeader. */
  toolLive: boolean
  /** Whether THIS reasoning row is the live streaming tail: its collapsed
   *  preview then follows the newest line; settled rows show the first line
   *  (harness ReasoningRow running ? latestLine : firstLine). */
  reasoningLive: boolean
}): React.JSX.Element {
  const ref = React.useRef<DOMElement>(null)
  React.useEffect(() => {
    const key = String(props.item.key)
    // The row's markdown estimate is the sanity floor for every reading below
    // (a diff-rendered row measures a collapsed height — see setMeasuredHeight).
    const est = estItemLines(props.item, props.usable, props.expandReasoning)
    // Measure immediately (throttled, so a per-delta notify storm is avoided)
    // so the very next frame lays out with the current height and no content
    // overlaps. Ink can finish laying out a frame AFTER React commits, so also
    // re-measure at 60/400/900 ms: those samples are authoritative (`force`,
    // un-throttled) because this effect re-runs on every text change and clears
    // its timers — a timer that fires therefore proves the text has been stable
    // for that long. Without the forced final sample a last one-row growth was
    // dropped, leaving the cached height one row short and clipping the tail of
    // the answer below the transcript viewport (dsh-tui-development §2.5.51).
    if (ref.current) {
      setMeasuredHeight(key, measureElement(ref.current).height, est, { force: true, throttled: true })
    }
    const sample = (force: boolean) => (): void => {
      if (!ref.current) return
      setMeasuredHeight(key, measureElement(ref.current).height, est, { force })
    }
    const timers = [
      setTimeout(sample(false), 60),
      setTimeout(sample(true), 400),
      setTimeout(sample(true), 900),
    ]
    return () => { for (const t of timers) clearTimeout(t) }
    // Re-measure when an expansion toggle changes this row's rendered height
    // (the item text itself is unchanged, so [props.item.text] alone would
    // skip it and leave the measured cache stale), and when the wrap width
    // changes: the layout drops every cached height on a width change, and
    // without this dep the mounted rows would never be re-measured — they would
    // keep whatever stale estimate the layout filled in (measured: 97 vs the
    // real 115 rows, clipping 17 lines off the answer's tail).
  }, [props.item.text, props.usable, props.expandReasoning, props.toolExpanded, props.compactionExpanded])
  return (
    <Box ref={ref} flexDirection="column">
      {itemContent(props.item, props.expandReasoning, props.toolExpanded, props.compactionExpanded, props.hovered, props.usable, props.toolLive, props.reasoningLive)}
    </Box>
  )
})

/** Per-row error isolation: one transcript row whose content throws during
 *  render (e.g. an exotic tool result the markdown/plain renderer chokes on) is
 *  dropped to a one-line warning instead of taking the whole conversation
 *  surface down through the app-level boundary — the classic way a screen
 *  "freezes" while the agent keeps running underneath. Logged for diagnosis. */
class RowErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  componentDidCatch(error: Error): void {
    try {
      logError('row', error)
    } catch {
      // best-effort: never throw from the error boundary
    }
  }
  render(): React.ReactNode {
    if (this.state.error !== null) {
      return (
        <Text color={theme.error} wrap="truncate">⚠ row dropped: {this.state.error.message}</Text>
      )
    }
    return this.props.children
  }
}

function StepsRow(props: { steps: readonly StepItem[] }): React.JSX.Element {
  const ref = React.useRef<DOMElement>(null)
  React.useEffect(() => {
    // Rare row (one per plan write), so no throttle: the authoritative height
    // must land on the very pass that follows a steps change.
    if (ref.current) {
      setMeasuredHeight('steps', measureElement(ref.current).height, stepsBlockHeight(props.steps.length), { force: true })
    }
  }, [props.steps])
  return <Box ref={ref} flexDirection="column"><StepsBlock steps={props.steps} /></Box>
}

/** Phase word for the status-bar liveness text (kept short: it shares the
 *  single-line status bar with the session-stats group on the right). */
const RUN_PHASE_WORD: Record<Store['runPhase'], string> = {
  working: 'working',
  thinking: 'thinking',
  answering: 'answering',
  tool: 'tool',
}

/** The liveness text beside the spinner: the run phase, plus the currently
 *  open tool (parallel calls collapse to `name ×n`). */
function runPhaseLabel(store: Store): string {
  if (store.runPhase === 'tool') {
    const tool = store.currentTool
    if (tool === null) return RUN_PHASE_WORD.tool
    const name = tool.length > 16 ? `${tool.slice(0, 15)}…` : tool
    return store.toolOpenCount > 1 ? `${name} ×${store.toolOpenCount}` : name
  }
  return RUN_PHASE_WORD[store.runPhase]
}

function BusyIndicator(props: { animate: boolean; paused: boolean }): React.JSX.Element | null {
  // PULSE only: the timer exists to keep this leaf re-rendering while running.
  // The glyph itself is derived from the WALL CLOCK at render time (below), so
  // ANY render — this pulse OR a store-event parent render — paints the frame
  // the clock currently says. Under a tool-event storm the 100 ms timer can be
  // starved for a while while parent renders (driven by store events) continue
  // and the seconds text keeps moving; with a state-counter glyph that left the
  // icon frozen next to live text, with a clock-derived glyph it cannot: the
  // icon and the text are both functions of Date.now().
  const [, setPulse] = React.useState(0)
  React.useEffect(() => {
    if (!props.animate) return
    const timer = setInterval(() => setPulse((p) => p + 1), 100)
    return () => clearInterval(timer)
  }, [props.animate])
  if (props.paused) return <Text color={theme.warning}>⏸ Paused</Text>
  // Idle: a STATIC marker (⠿, not an animated spinner frame) + "Idle".
  if (!props.animate) return <Text color={theme.text}>⠿ Idle</Text>
  const armed = Date.now() - store.lastEscTime < 800
  // Liveness text: the second counters re-read Date.now() on every render, so
  // the line keeps changing even across a long silent stretch (model thinking,
  // a slow tool) — the status bar can never LOOK frozen while the run is
  // healthy. The "Ns since last event" suffix appears only once the gap is
  // noticeable (> 3 s), so a fast tool loop stays compact.
  const now = Date.now()
  // Glyph = the spinner phase the wall clock says (8 frames × 100 ms → 800 ms
  // loop): deterministic per instant, immune to timer starvation/coalescing.
  const glyph = SPINNER_FRAMES[Math.floor(now / 100) % SPINNER_FRAMES.length]
  const sinceTurn = Math.max(0, Math.floor((now - store.busySince) / 1000))
  const sinceLast = Math.max(0, Math.floor((now - store.lastActivityAt) / 1000))
  const quiet = sinceLast >= 4 ? ` · ${sinceLast}s since last event` : ''
  return (
    <Text color={theme.info}>
      {glyph}
      <Text color={theme.text}> {runPhaseLabel(store)} · {sinceTurn}s{quiet} · </Text>
      {/* Pause hint takes the permission-chip color so it reads as an ACTION
          affordance (same color as the composer's "(Tab)" hint), not as part
          of the plain liveness text. */}
      <Text color={store.permissionColor}>{armed ? 'Esc again to pause' : 'Esc to pause'}</Text>
    </Text>
  )
}

/** The reasoning ("Think") leading glyph — a tree-style expand indicator:
 *  `+` while the row is collapsed, `-` while expanded. The animated spinner
 *  previously used here moved to the status-bar liveness indicator; streaming
 *  activity is still visible in the rolling one-line preview. */
function buildRows(items: readonly TranscriptItem[], steps: readonly StepItem[]): Row[] {
  const base: ({ type: 'item'; item: TranscriptItem } | { type: 'steps' })[] = []
  let inserted = false
  for (const it of items) {
    base.push({ type: 'item', item: it })
    if (steps.length > 0 && !inserted && it.kind === 'user') { base.push({ type: 'steps' }); inserted = true }
  }
  if (steps.length > 0 && !inserted) base.push({ type: 'steps' })
  // Spacing is LAYOUT MARGINS on the rows, never
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
          {STEP_ICON[step.status]} {stripTerminalControls(step.content)}
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

/** `DSH_TUI_HERO_ART` override, read once at module load (auto by default). */
const HERO_ART_MODE = heroArtMode(process.env.DSH_TUI_HERO_ART)

/** The generated brand art, packed into colored half-block cells once. */
const HERO_ART_ROWS_CELLS = heroArtCells()

/**
 * Brand mark the hero draws at this size: the generated pixel-art wordmark when
 * it fits AND the terminal really advances `▀` one column (it is
 * East-Asian-Ambiguous — see the charwidth calibration), else the plain-`#`
 * ASCII fallback, else nothing. The renderer and every geometry mirror call
 * this, so routing cannot disagree with what is painted.
 */
function heroMarkFor(rows: number, width: number): HeroMarkKind {
  return heroArtMarkKind({
    rows,
    width,
    blockWidth: visualWidth(HERO_ART_CELL_GLYPH),
    mode: HERO_ART_MODE,
  })
}

/** Whether the Steps sidebar is drawn at `width`: the manual store override
 *  (`on`/`off`) wins; `auto` follows the width threshold. Every geometry helper
 *  consults this so the transcript/composer widths always match the sidebar
 *  that is actually drawn (including after a user hide/show). */
function sidebarVisibleFor(width: number): boolean {
  // The blank-session HERO is chrome-free (web parity): no Steps sidebar and a
  // full-width composer while the hero is up. Every consumer of this helper
  // (composer width, regions, painting) follows the same switch.
  if (store.hero) return false
  const mode = store.sidebarMode ?? 'auto'
  if (mode === 'off') return false
  if (mode === 'on') return true
  return width >= SIDEBAR_MIN_WIDTH
}

/** The numeric right Steps sidebar width, when the sidebar is visible. Mirrors
 *  the renderer's `sidebarWidth` so composer geometry can never drift from the
 *  drawn sidebar. */
function sidebarWidthFor(width: number): number {
  return sidebarVisibleFor(width) ? Math.max(20, Math.round(width * 0.3)) : 0
}

/** The composer's outer width: the full terminal width, or — when the Steps
 *  sidebar is visible — exactly the message column width, so the composer's
 *  right border sits flush against the sidebar's left edge and input text
 *  never extends beneath/right of the sidebar. While the HERO is up the card is
 *  the narrower CENTERED web-like column instead (`heroComposerWidth`), so
 *  every width-dependent composer computation (wrap, height, caret rows) uses
 *  the same number the render centers on. */
function composerOuterWidth(width: number): number {
  if (store.hero) return heroComposerWidth(width)
  return Math.max(1, width - sidebarWidthFor(width))
}

/** The composer text wrap width: outer width minus round border (2) and
 *  paddingX (2). */
function composerUsable(width: number): number {
  return Math.max(10, composerOuterWidth(width) - 4)
}

/** Wrap composer text exactly like Ink's `<Text wrap="wrap">`: the same
 *  wrap-ansi call Ink's wrap-text.js makes (`trim: false, hard: true`), so
 *  composer height/caret math can never drift from the rendered rows. Words
 *  longer than the column break anywhere; shorter words stay whole. */
function composerWrap(text: string, usable: number): string[] {
  if (text === '') return ['']
  return wrapAnsi(text, usable, { trim: false, hard: true }).split('\n')
}

/** Per-VISUAL-row character offsets of the whole input: wrap every logical line
 *  with Ink's rule and walk each wrapped row's character length, so a row's
 *  `start` is the input index where that visual row begins (rows are bijective
 *  with the text because wrap keeps every character with `trim: false`). */
function composerVisualRows(input: string, usable: number): Array<{ start: number; text: string }> {
  const rows: Array<{ start: number; text: string }> = []
  let offset = 0
  for (const seg of input.split('\n')) {
    let at = 0
    for (const text of composerWrap(seg, usable)) {
      rows.push({ start: offset + at, text })
      at += text.length
    }
    offset += seg.length + 1
  }
  return rows
}

/** Which visual rows are visible in the composer's text area, given the caret's
 *  global row: a window of `textArea` rows that keeps the caret row visible
 *  (tail when typing at the end). Returns the first visible row and the exact
 *  `[start, end)` character range of those rows, so the caller can render ONLY
 *  that window — the box never overflows, and the caret row stays inside it. */
function composerWindow(input: string, usable: number, caretRow: number, textArea: number): { rows: Array<{ start: number; text: string }>; first: number; start: number; end: number } {
  const rows = composerVisualRows(input, usable)
  const total = rows.length
  const area = Math.max(1, textArea)
  const first = total <= area ? 0 : Math.max(0, Math.min(caretRow - (area - 1), total - area))
  const lastRow = rows[Math.min(total - 1, first + area - 1)]!
  return { rows, first, start: rows[first]!.start, end: lastRow.start + lastRow.text.length }
}

function composerHeight(width: number, input: string, min: number): number {
  const usable = composerUsable(width)
  const wrapped = input.split('\n').reduce((sum, seg) => sum + composerWrap(seg, usable).length, 0)
  // The composer grows with the draft (pushing the message area upward) up to
  // a height cap tied to the TERMINAL HEIGHT: cap = rows − 8 (never more than
  // min when the terminal is tiny). Its text window is composerH − 4, so the
  // draft's max VISIBLE rows scale with the screen (rows − 12 on normal
  // terminals): a short draft is fully shown, and once the draft wraps past
  // that the composer stops growing and scrolls INSIDE a caret-following
  // window (see the render + caret math) instead of overflowing its box over
  // the footer/status rows. The rows−8 floor guard also keeps a ≥3-row
  // message viewport on small terminals.
  const cap = Math.max(min, store.rows - 8)
  return Math.min(min + wrapped - 1, cap)
}

/** Where the composer card actually sits: its FIRST painted row, its leftmost
 *  column and its full box height (image chip included). Docked = bottom of the
 *  message column; HERO = centered inside the hero stack, and narrower
 *  (`heroComposerWidth`). The card is BORDERLESS: `top` is its first painted row
 *  — the ▄ half-row edge — so the first CONTENT row is `top + 1` (then the image
 *  row, when an image is attached, then the draft rows).
 *  ONE source for the hardware caret cell, the mouse→input-index mapping, the
 *  selection bounds and the command-palette rows — so none of them can drift
 *  from what the render paints (the hero caret used to be placed with the
 *  docked bottom-anchored formula, which parked the terminal cursor at the
 *  bottom of the screen instead of in the card). */
function composerBand(width: number, rows: number): { top: number; left: number; height: number } {
  const height = composerHeight(width, store.input, composerMinHeight())
    + (store.composerImage !== null ? 1 : 0)
  if (store.hero) {
    const hero = heroLayout({
      rows,
      boxH: height,
      brandLines: heroMarkRows(heroMarkFor(rows, width)) + 1,
      // No hint line (removed on user call); the row is reused by the
      // older-history progress line while a resumed session folds.
      hintLines: store.olderLoading ? 1 : 0,
    })
    return { top: hero.composerTopRow, left: heroComposerLeft(width), height }
  }
  return { top: rows - STATUS_BAR_HEIGHT - height + 1, left: 1, height }
}

/** Plan-B A/B switch (diagnosis only): `DSH_TUI_LEGACY_EST=1` re-parses the
 *  markdown height estimate on every item change instead of using the
 *  growth-debounced estimate (优化1). 优化2/3/4 (notify batching, idle resume
 *  fold, windowed older history) stay active either way. The incremental
 *  layout reuse (original 优化5) was REMOVED — real-terminal A/B showed it
 *  garbles streaming messages — so the layout is always a full walk now. */
const legacyEstimate = /^(1|true|yes|on)$/i.test(process.env.DSH_TUI_LEGACY_EST ?? '')

/** Per-item row-height estimates, memoized by (item, usable, reasoning flags,
 *  tool-expansion). History rows keep the same item object across renders, so
 *  once an estimate is computed a layout pass only walks the cache — the
 *  Markdown(mdast) parse per assistant row happens ONCE per item, not on every
 *  event/keystroke (measured: 40 assistant rows ≈ 36 ms per pass without this
 *  cache, <1 ms with it). The streaming tail replaces its item each delta, so
 *  the per-item cache alone would re-parse the markdown on EVERY delta while a
 *  long answer grows — {@link estimateMarkdownHeightDebounced} bounds that by
 *  row key instead. */
const estCache = new WeakMap<TranscriptItem, Map<string, number>>()

/** S0 diagnostic (`DSH_TUI_DEBUG_EST=1`, `session/optimization-plan.md` §3):
 *  per-layout-pass height-estimate accounting, so "0.66 s per pass" can be
 *  attributed to cache misses/parses instead of guessed at. Logging only. */
const debugEst = /^(1|true|yes|on)$/i.test(process.env.DSH_TUI_DEBUG_EST ?? '')
let estHits = 0
let estParses = 0
let estParseMs = 0
/** Coarse (O(1)) placeholders handed out this pass: the S1b accounting split,
 *  so `[est] pass` shows exactly-estimated rows and placeholder rows apart
 *  (`session/optimization-plan.md` §3). */
let estCheap = 0
/** Last `store.loadGeneration` the layout saw: a change drops the debounced
 *  markdown cache inside {@link estimateMarkdownHeightDebounced} (full
 *  re-parse of every markdown row). Logged, never acted on. */
let estLastLoadGen = -1

/** Invalidates every entry of {@link estCache} at once. The per-item map is
 *  keyed by wrap width, so an entry computed for an older wrap width would be
 *  reused verbatim when the width comes back (a resize round trip) — measured:
 *  the layout fell back to the stale 97-row estimate of a 115-row answer and
 *  clipped 17 lines off its tail. Bumped on a wrap-width change and on every
 *  assistant settlement (the settled text must be parsed exactly, not debounced).
 *  WeakMap entries cannot be cleared, so the generation rides in the cache key
 *  instead and old entries simply stop matching. */
let estGeneration = 0

/** How many characters a streaming row may grow past its last markdown-height
 *  parse before the estimate is recomputed. Between parses the painted
 *  measured height (updated at ~100 ms cadence + 60/400/900 ms resamples,
 *  and authoritative for the layout via measureEpoch) keeps the live row
 *  correct, and settlement (assistant/message) replaces the row with
 *  authoritative text — growth past the threshold then re-parses once. The
 *  threshold is small so stale estimates never under-count by much even in
 *  the brief window before the next measured write. */
const MARKDOWN_REPARSE_GROWTH = 512

interface MarkdownHeightEstimate {
  /** Item text length at the last mdast parse. */
  parsedLength: number
  lines: number
}

/** Row-keyed markdown-height cache with a generation guard: numeric item keys
 *  are reused across loads (loadHistory/beginHistory re-key from 0), so the
 *  cache drops whenever the store's {@link loadGeneration} moves; a width
 *  change clears it explicitly (wrap counts differ per width). */
let markdownHeightGeneration = -1
const markdownHeightsByKey = new Map<number, MarkdownHeightEstimate>()

/** Clear the debounced markdown-height cache (called when the wrap width
 *  changes; transcript loads clear implicitly via the generation guard). */
export function clearMarkdownHeightCache(): void {
  markdownHeightsByKey.clear()
}

/** Drop the debounced markdown estimate for ONE row key. Called on settlement:
 *  the settled row is a NEW item object (so its per-item estimate cache is empty
 *  anyway) and the debounce is keyed by row key, so busting that single key is
 *  enough — the settled text gets an exact parse while every other row keeps its
 *  cached estimate (a global clear re-parsed ~5.1k rows, 0.72 s per settle). */
export function bustMarkdownHeight(key: number): void {
  markdownHeightsByKey.delete(key)
}

/** Row-height estimate for markdown text (assistant/plan rows), debounced by
 *  streamed growth: reuse the last mdast parse until the text grew past
 *  {@link MARKDOWN_REPARSE_GROWTH} since it, so a fast long stream does not
 *  re-run the parse per delta (measured painted heights cover the gap, and
 *  settlement re-parses once). No parse for identical text either.
 *  @param key - stable transcript row key (survives streamed replacements).
 *  @param text - current row text (markdown source).
 *  @param width - wrapped content width in columns.
 *  @param generation - cache generation (store.loadGeneration). */
export function estimateMarkdownHeightDebounced(key: number, text: string, width: number, generation: number): number {
  if (generation !== markdownHeightGeneration) {
    markdownHeightsByKey.clear()
    markdownHeightGeneration = generation
  }
  const hit = markdownHeightsByKey.get(key)
  if (hit !== undefined && text.length - hit.parsedLength < MARKDOWN_REPARSE_GROWTH) return hit.lines
  const lines = estimateMarkdownHeight(text, width)
  markdownHeightsByKey.set(key, { parsedLength: text.length, lines })
  return lines
}

/** Whether a row-keyed markdown estimate must re-run its parse: no cache
 *  entry, or the text has grown at least {@link MARKDOWN_REPARSE_GROWTH}
 *  characters past the last parse. Exported for tests. */
export function markdownHeightReparseDue(parsedLength: number | undefined, textLength: number): boolean {
  return parsedLength === undefined || textLength - parsedLength >= MARKDOWN_REPARSE_GROWTH
}

/** Decide the row height the layout uses: trust the measured painted height
 *  unless it is implausibly SMALL. The measured value is the truth for any row
 *  that has actually been painted (the streaming tail always is), while the
 *  estimate is only a fill-in for a not-yet-painted row or a bad reading.
 *
 *  The estimate undercounts word-wrapped prose — {@link countWrappedLines} is a
 *  *character* ceil, not a word-wrap, so Ink's `wrap="wrap"` (greedy word
 *  break) needs MORE rows than ceil(width/usable), and the gap grows with the
 *  text length. A measured height LARGER than the estimate is therefore real,
 *  not a scroll artifact, and MUST be kept: discarding it makes `layout.content`
 *  (hence `maxScroll`) too small, so the streaming tail is cut off and the
 *  newest lines sit below the viewport (the "doesn't auto-scroll; PgDn reveals
 *  it" report). Only a reading that is more than one row BELOW the estimate is
 *  treated as the documented diff-render collapse (e.g. 1 instead of 3).
 * @param est - the deterministic wrapped-line estimate for the row.
 * @param measured - the measured painted height (undefined before first paint).
 * @returns the row height to lay out. */
export function resolveRowHeight(est: number, measured: number | undefined): number {
  if (measured !== undefined && measured + 1 >= est) return measured
  return est
}

/** Rows above/below the viewport that pass B still parses precisely: about two
 *  screens of scroll slack, so a scroll step, a wheel notch or the tail growing
 *  by a wrapped line stays inside precisely-measured rows. */
const OVERSCAN_ROWS = 48
/** Pass B stops parsing once this much mdast time is spent. The visible rows are
 *  refined first (see {@link windowRefineOrder}), so the budget can only starve
 *  overscan rows — never the frame the user is looking at. 35 ms keeps the whole
 *  first layout after a load under ~60 ms while still parsing ~2.5 screens. */
const MD_PARSE_BUDGET_MS = 35

/** Row indices pass B refines, most-visible first: the viewport rows, then the
 *  overscan rows from the bottom up (the tail is what follow-mode shows) and the
 *  top down. Deterministic and duplicate-free, so a starved budget is a stable
 *  prefix of this order rather than a random subset. */
export function windowRefineOrder(winFirst: number, winLast: number, rowCount: number): number[] {
  const out: number[] = []
  if (rowCount <= 0) return out
  const lo = Math.max(0, winFirst)
  const hi = Math.min(rowCount - 1, winLast)
  for (let i = lo; i <= hi; i++) out.push(i)
  for (let k = 1; k <= OVERSCAN_ROWS; k++) {
    if (hi + k < rowCount) out.push(hi + k)
    if (lo - k >= 0) out.push(lo - k)
  }
  return out
}

/** Whether a row's height needs a mdast parse (assistant/plan bodies, and a
 *  compaction summary only while expanded — the same branches
 *  {@link estItemLines} takes the markdown path for). Everything else is a
 *  wrapped-line count either way, so pass B skips it. */
function isMarkdownKind(item: TranscriptItem): boolean {
  if (item.kind === 'assistant' || item.kind === 'plan') return true
  return item.kind === 'compaction' && item.compaction?.summary !== undefined && store.isToolExpanded(item.key)
}

/** Cache key of {@link estItemLines}'s per-item estimate. The disclosure flags
 *  are part of it: an EXPANDED compaction row is header + whole summary, so
 *  serving the collapsed entry would clip its body away after a click. */
function estItemCacheKey(item: TranscriptItem, usable: number, expandReasoning: boolean): string {
  const toolExpanded = item.kind === 'tool' && item.tool?.body !== undefined && store.isToolExpanded(item.key)
  const compactionExpanded = item.kind === 'compaction' && item.compaction?.summary !== undefined
    && store.isToolExpanded(item.key)
  return `${estGeneration}|${usable}|${expandReasoning ? 1 : 0}|${toolExpanded ? 1 : 0}`
    + `|${compactionExpanded ? 1 : 0}`
}

/** Pass-A height: the already-computed exact estimate when this row has one,
 *  otherwise an O(1) coarse placeholder. Pass A must never compute a real
 *  estimate — its job is to produce the offsets that locate the viewport (see
 *  the layout memo), and only the window pass B refines needs exact heights.
 *  Measured (painted) heights override both in the memo. */
function estItemLinesCachedOrCoarse(item: TranscriptItem, usable: number, expandReasoning: boolean): number {
  const key = estItemCacheKey(item, usable, expandReasoning)
  const cached = estCache.get(item)?.get(key)
  if (cached !== undefined) {
    if (debugEst) estHits += 1
    return cached
  }
  if (debugEst) estCheap += 1
  return coarseItemLines(item, usable)
}

/** O(1), allocation-free placeholder for a row OUTSIDE the parse window: source
 *  length ÷ wrap width, with 1.5 cells per character (source is mostly ASCII but
 *  CJK counts 2, so neither 1 nor 2 is right and the exact per-char scan is
 *  exactly the cost this avoids). It only ever stands in for a row the viewport
 *  cannot show: painting a row stores its MEASURED height, which wins over any
 *  estimate (see {@link resolveRowHeight}), so an off-window placeholder can
 *  never clip the visible frame — including the tail, which is always in-window
 *  and therefore exact. */
function coarseWrapped(text: string, width: number): number {
  return Math.max(1, Math.ceil((text.length * 1.5) / Math.max(1, width)))
}

function coarseItemLines(item: TranscriptItem, usable: number): number {
  const w = MESSAGE_TEXT_WIDTH(usable)
  switch (item.kind) {
    // Collapsed reasoning is a FIXED 2 rows (label + one-line summary), so the
    // placeholder is exact there; only the expanded body depends on the text.
    case 'reasoning': return 2
    case 'plan': return 1 + coarseWrapped(item.text, w)
    case 'assistant':
    case 'user': return coarseWrapped(item.text, w)
    case 'compaction': {
      const summary = item.compaction?.summary
      const expanded = summary !== undefined && store.isToolExpanded(item.key)
      return 1 + (expanded ? coarseWrapped(summary, w) : 0)
    }
    case 'tool': {
      const body = item.tool?.body
      const expanded = body !== undefined && store.isToolExpanded(item.key)
      // The header is one or two rows; the body is what can be huge.
      return 1 + (expanded ? coarseWrapped(body, w) : 0)
    }
    default: return coarseWrapped(item.text, w)
  }
}

function estItemLines(item: TranscriptItem, usable: number, expandReasoning: boolean): number {
  // The disclosure flags are part of the key — see {@link estItemCacheKey}.
  const cacheKey = estItemCacheKey(item, usable, expandReasoning)
  let byItem = estCache.get(item)
  if (byItem === undefined) {
    byItem = new Map()
    estCache.set(item, byItem)
  }
  const hit = byItem.get(cacheKey)
  if (hit !== undefined) {
    if (debugEst) estHits += 1
    return hit
  }
  const tParse = debugEst ? Date.now() : 0

  const w = MESSAGE_TEXT_WIDTH(usable)
  let lines: number
  if (item.kind === 'reasoning') {
    // Web parity: collapsed is ALWAYS label(1) + one-line summary(1) — fixed
    // 2 rows whether streaming or settled — so the layout never moves; only
    // the expanded (clicked /think) body adds wrapped text rows.
    if (expandReasoning) lines = 1 + countWrappedLines(item.text, w)
    else lines = 2
  } else if (item.kind === 'assistant') {
    lines = legacyEstimate
      ? estimateMarkdownHeight(item.text, w)
      : estimateMarkdownHeightDebounced(item.key, item.text, w, store.loadGeneration)
  } else if (item.kind === 'plan') {
    // Label tag row + the FULLY unfolded markdown body (never collapsed).
    lines = 1 + (legacyEstimate
      ? estimateMarkdownHeight(item.text, w)
      : estimateMarkdownHeightDebounced(item.key, item.text, w, store.loadGeneration))
  } else if (item.kind === 'user') {
    lines = countWrappedLines(item.text, w)
  } else if (item.kind === 'compaction') {
    // Header line + the summary markdown ONLY while expanded: the same mirror
    // rule the tool rows use, so a click never desyncs scroll/selection. The
    // markdown estimate is the shared debounced one (assistant/plan rows).
    const summary = item.compaction?.summary
    const expanded = summary !== undefined && store.isToolExpanded(item.key)
    lines = countWrappedLines(compactionRowHeader(item.compaction ?? {}, expanded), w)
      + (expanded
        ? (legacyEstimate
          ? estimateMarkdownHeight(summary, w)
          : estimateMarkdownHeightDebounced(item.key, summary, w, store.loadGeneration))
        : 0)
  } else if (item.kind === 'tool') {
    // Header (summary) lines + the result/error body ONLY while expanded —
    // mirror of the rendered row, so scroll stays aligned on toggle.
    const body = item.tool?.body
    const toolExpanded = body !== undefined && store.isToolExpanded(item.key)
    lines = countWrappedLines(toolRowHeader(item, usable), w)
      + (body !== undefined && toolExpanded ? countWrappedLines(body, w) : 0)
  } else {
    lines = countWrappedLines(item.text, w)
  }
  if (debugEst) { estParses += 1; estParseMs += Date.now() - tParse }
  byItem.set(cacheKey, lines)
  return lines
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

/** Attribution mode for the layout pass (`DSH_TUI_DEBUG_LAYOUT=1`): times every
 *  item and reports the slowest one, so a multi-second wedge can be blamed on a
 *  specific pathological row (a giant tool body) instead of guessed at. Off by
 *  default: the per-item `Date.now()` pairs are only paid when debugging. */
const debugLayout = /^(1|true|yes|on)$/i.test(process.env.DSH_TUI_DEBUG_LAYOUT ?? '')
/** Threshold (ms) above which a layout pass is logged. 200 keeps the log quiet
 *  in normal runs; `DSH_TUI_DEBUG_LAYOUT_MS=0` logs EVERY pass, which is what
 *  measuring the steady-state cost needs — after the S1a fix the warm passes
 *  are far below 200 ms, so "no line" says nothing about how far below.
 *  Diagnosis only (`session/optimization-plan.md` §3 S1b). */
const debugLayoutMs = (() => {
  const n = Number(process.env.DSH_TUI_DEBUG_LAYOUT_MS ?? Number.NaN)
  return Number.isFinite(n) && n >= 0 ? n : 200
})()
/** Tail-geometry probe (`DSH_TUI_DEBUG_TAIL=1`, diagnosis only): one line per
 *  render pass with the window geometry and the TAIL row's estimate/measured
 *  height, so "the answer's last line never shows up" can be told apart from a
 *  stale frame. Off by default. */
const debugTail = /^(1|true|yes|on)$/i.test(process.env.DSH_TUI_DEBUG_TAIL ?? '')
/** Tail row's measured-height cache entry as seen at the START of the last
 *  layout pass: lets the probe contrast "what the layout trusted" with the
 *  estimate it used (-1 = no measurement, estimate only). See {@link debugTail}. */
let preTailMeas = -1

/** Aggregate frame-cost meter (gated by the same switch): the per-item probe
 *  only fires on a >200 ms wedge, which never happens on a big session — so a
 *  window-size A/B needs totals. Reports frames, both row builders and heap
 *  every 2 s. No behaviour change; off unless `DSH_TUI_DEBUG_LAYOUT=1`. */
const perf = { frames: 0, rowsMs: 0, rowsMax: 0, itemsMs: 0, itemsMax: 0, at: 0, items: 0, heapMb: 0 }

/** WHOLE-FRAME gap probe (`DSH_TUI_DEBUG_LAYOUT=1`): the two row builders are
 *  cheap (<1 ms), so a multi-second freeze has to be found elsewhere — between
 *  consecutive panel renders. Measures the gap between render bodies, which
 *  covers React commit, Ink layout and every synchronous block in between. */
let lastFrameAt = 0
let lastHeapMb = 0
function frameGapProbe(items: number, scroll: number, followTail: boolean): void {
  if (!debugLayout) return
  const now = Date.now()
  const memoGap = lastFrameAt === 0 ? 0 : now - lastFrameAt
  // The frame writer stamps `__dshTuiLastFlushAt` on every ACTUAL write (the
  // calibration flush included), so that stamp — not the memo interval — is the
  // evidence a paint happened. `lastFrameAt` only moves when the rows/items
  // memos recompute, and an idle app neither recomputes nor paints: measured
  // right after the first frame, keystroke→repaint was 51 ms while this probe
  // claimed 1030 ms (`activity=idle`), and the same false positive showed 39 s
  // on a session left alone (session/optimization-plan.md §8.8). Use the timer
  // beat (`[stall]`, DSH_TUI_STALL_MS) for genuine main-thread wedges.
  const frameGlobals = globalThis as unknown as { __dshTuiLastFlushAt?: number }
  const paintedAt = typeof frameGlobals.__dshTuiLastFlushAt === 'number' ? frameGlobals.__dshTuiLastFlushAt : 0
  const gap = paintedAt > 0 ? now - paintedAt : memoGap
  const base = paintedAt > 0 ? paintedAt : lastFrameAt
  // A gap only means a screen that failed to update when a mutation was waiting
  // for a frame and there was something to paint: an idle app deliberately
  // paints nothing (Ink writes only on change), and state changes that render
  // identically also leave `lastMutationAt` behind the last paint. `idle=1`
  // marks exactly those cases — the field that a reader (and a previous
  // investigation) mistook for a freeze: measured right after the first frame,
  // keystroke→repaint was 51 ms while this line said 1030 ms with activity=idle
  // (session/optimization-plan.md §8.8). It is NOT dropped when idle, because a
  // real failure to paint can also happen while no agent is running (output
  // backpressure, a blocked writer) — use `[stall]`/`DSH_TUI_STALL_MS` for
  // main-thread wedges.
  const pendingSince = store.lastMutationAt
  const activity = describeActivity()
  const idle = activity === 'idle'
  const stalled = gap > 1000 && pendingSince > base - 1 && pendingSince !== 0
  lastFrameAt = now
  if (stalled) {
    // `heap` before/after a gap is the cheap GC discriminator: a major GC pause
    // shows up as a large DROP across the freeze, harness recomputation does not.
    const heap = Math.round(process.memoryUsage().heapUsed / 1048576)
    const drop = lastHeapMb === 0 ? 0 : lastHeapMb - heap
    logErrorFileOnly('frame',
      `paint gap=${gap}ms memoGap=${memoGap}ms idle=${idle ? 1 : 0} items=${items} scroll=${scroll} `
      + `followTail=${followTail} heap=${heap}MB heapDrop=${drop}MB activity=${activity}`)
    lastHeapMb = heap
  } else {
    lastHeapMb = Math.round(process.memoryUsage().heapUsed / 1048576)
  }
}
/** Which LEFT-SLOT branch the status bar takes (`DSH_TUI_DEBUG_STATUS=1`),
 *  logged once per change. The slot is a priority chain (load > compaction >
 *  preparing > older-history > flash > error > busy indicator); when something
 *  higher up never clears, the run-phase indicator silently disappears — the
 *  symptom is visible on screen but the branch that caused it is not, so the
 *  chain reports itself. */
const debugStatus = /^(1|true|yes|on)$/i.test(process.env.DSH_TUI_DEBUG_STATUS ?? '')
let lastStatusBranch = ''
function noteStatusBranch(store: Store): null {
  if (!debugStatus) return null
  const branch = store.sessionLoading !== null
    ? `loading(${store.sessionLoading.steps[store.sessionLoading.steps.length - 1]?.phase ?? '-'})`
    : store.compaction !== null
      ? 'compaction'
      : store.preparingRequest
        ? 'preparing'
        : store.historyLoadingVisible
          ? 'history'
          : store.statusFlash !== null
            ? `flash(${store.statusFlash.text.slice(0, 24)})`
            : store.loadError !== null
              ? 'error'
              : `busy(running=${store.running},paused=${store.paused})`
  if (branch !== lastStatusBranch) {
    lastStatusBranch = branch
    logErrorFileOnly('status', `left slot -> ${branch} hero=${store.hero} session=${store.session === undefined ? '-' : String(store.session.id).slice(0, 12)}`)
  }
  return null
}

function perfTick(which: 'rows' | 'items', ms: number, items: number, heapMb: number): void {
  if (!debugLayout) return
  eventRateTick()
  perf.frames += 1
  if (which === 'items') { perf.itemsMs += ms; perf.itemsMax = Math.max(perf.itemsMax, ms) } else { perf.rowsMs += ms; perf.rowsMax = Math.max(perf.rowsMax, ms) }
  perf.items = items
  perf.heapMb = heapMb
  const now = Date.now()
  if (perf.at === 0) { perf.at = now; return }
  if (now - perf.at < 2000) return
  logErrorFileOnly('perf',
    `window=${Math.round((now - perf.at) / 1000)}s frames=${perf.frames} `
    + `tuiRows avg=${(perf.rowsMs / Math.max(1, perf.frames)).toFixed(1)}ms max=${perf.rowsMax}ms `
    + `itemRows avg=${(perf.itemsMs / Math.max(1, perf.frames)).toFixed(1)}ms max=${perf.itemsMax}ms `
    + `items=${items} heap=${heapMb}MB`)
  perf.frames = 0; perf.rowsMs = 0; perf.rowsMax = 0; perf.itemsMs = 0; perf.itemsMax = 0; perf.at = now
}

function buildTranscriptRows(items: readonly TranscriptItem[], usable: number): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const startedAt = debugLayout ? Date.now() : 0
  let slowest = { kind: '', chars: 0, ms: 0, index: -1 }
  items.forEach((item, i) => {
    const itemT0 = debugLayout ? Date.now() : 0
    if (i > 0) rows.push({ text: '', itemIndex: i - 1 })
    const w = MESSAGE_TEXT_WIDTH(usable)
    if (item.kind === 'compaction') {
      // Compaction row mirror: the shared header line, plus the summary body
      // (as plain markdown text) ONLY while expanded — selection/copy offsets
      // and hit-testing stay aligned with the painted row.
      const summary = item.compaction?.summary
      const expanded = summary !== undefined && store.isToolExpanded(item.key)
      for (const line of wrapRows(compactionRowHeader(item.compaction ?? {}, expanded), w)) rows.push({ text: line, itemIndex: i })
      if (expanded) {
        const plain = summary.length <= 8000 ? markdownPlain(summary) : summary
        for (const line of wrapRows(plain, w)) rows.push({ text: line, itemIndex: i })
      }
      return
    }
    if (item.kind === 'tool') {
      // Tool rows mirror the rendered summary header (+ result/error body only
      // while expanded), so selection/copy offsets stay aligned.
      for (const line of wrapRows(toolRowHeader(item, usable), w)) rows.push({ text: line, itemIndex: i })
      const body = item.tool?.body
      if (body !== undefined && store.isToolExpanded(item.key)) {
        for (const line of wrapRows(body, w)) rows.push({ text: line, itemIndex: i })
      }
      return
    }
    if (item.kind === 'reasoning') {
      // Mirror the rendered rows: the label line + the content under it
      // (full text when THIS row is expanded, the live/preview line when
      // collapsed), so selection/copy offsets stay aligned.
      if (store.reasoningExpanded(item.key)) {
        for (const line of wrapRows('◇ Think', w)) rows.push({ text: line, itemIndex: i })
        for (const line of wrapRows(item.text, w)) rows.push({ text: line, itemIndex: i })
      } else {
        // Two visible rows: the label + the one-line preview mirroring the
        // rendered row: newest line while this row is the LIVE streaming tail,
        // else the FIRST line (harness-web running ? latestLine : firstLine).
        for (const line of wrapRows('◇ Think', w)) rows.push({ text: line, itemIndex: i })
        const liveTail = store.running && !store.paused && items.length > 0 && items[items.length - 1] === item
        const summary = thinkPreviewLine(item.text, liveTail, usable)
        for (const line of wrapRows(summary === '' ? '\u00a0' : summary, w)) rows.push({ text: line, itemIndex: i })
      }
      return
    }
    if (item.kind === 'plan') {
      // Mirror the rendered rows: the label chip line + the fully unfolded
      // markdown body under it (copy/selection offsets stay aligned).
      for (const line of wrapRows(' Plan ', w)) rows.push({ text: line, itemIndex: i })
      const plain = item.text.length <= 8000 ? markdownPlain(item.text) : item.text
      for (const line of wrapRows(plain, w)) rows.push({ text: line, itemIndex: i })
      return
    }
    const plain = item.kind === 'assistant' && item.text.length <= 8000 ? markdownPlain(item.text) : item.text
    // Wrap breadth mirrors the rendered layout (one shared content column).
    for (const line of wrapRows(plain, w)) rows.push({ text: line, itemIndex: i })
    if (debugLayout) {
      const ms = Date.now() - itemT0
      if (ms > slowest.ms) slowest = { kind: item.kind, chars: item.text.length, ms, index: i }
    }
  })
  if (debugLayout) {
    const total = Date.now() - startedAt
    // Only ACTUAL wedges are reported: the pass runs every frame, so logging
    // each one would drown the log (and cost more than the pass itself).
    if (total > 200) {
      logErrorFileOnly('layout',
        `pass rows=${rows.length} items=${items.length} ms=${total} heap=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB `
        + `slowestItem=#${slowest.index} kind=${slowest.kind} chars=${slowest.chars} ms=${slowest.ms}`)
    }
  }
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

/** The caret's GLOBAL visual row (0-based over ALL wrapped input rows). */
function composerCaretGlobalRow(input: string, cursor: number, usable: number): number {
  const caret = Math.max(0, Math.min(cursor, input.length))
  return Math.max(0, composerWrap(input.slice(0, caret), usable).length - 1)
}

/** Pure main-surface geometry: where the message column, the composer box and
 *  the status bar sit on screen, so pointer routing (wheel/click per hovered
 *  region) can classify a cell WITHOUT touching the DOM. All numbers mirror
 *  the layout the render below actually draws (same composerHeight/usable/
 *  STATUS_BAR_HEIGHT), so routing can never disagree with what is painted.
 *  The composer box (borders incl.) occupies rows [composerTop, composerTop +
 *  boxH − 1] where boxH = composerHeight + (image chip ? 1 : 0); the status
 *  bar is the bottom STATUS_BAR_HEIGHT rows. */
function mainSurfaceGeometry(): SurfaceGeometry {
  const width = store.width
  const rows = store.rows
  const showSidebar = sidebarVisibleFor(width)
  const messageRight = showSidebar ? width - sidebarWidthFor(width) : width
  const composerH = composerHeight(width, store.input, composerMinHeight())
  const boxH = composerH + (store.composerImage !== null ? 1 : 0)
  // Hero phase: the SAME composer card is CENTERED inside the padded hero area
  // (web parity) and is NARROWER than the window, so routing must take both its
  // row band (shared hero layout) and its column band (heroComposerWidth) from
  // the same numbers the render uses — never from the bottom-docked formula.
  if (store.hero) {
    const hero = heroLayout({
      rows,
      boxH,
      brandLines: heroMarkRows(heroMarkFor(rows, width)) + 1,
      hintLines: 0, // the hero draws no hint line (removed on user call)
    })
    return {
      messageRight,
      composerTop: hero.composerTopRow,
      composerBottom: hero.composerBottomRow,
      composerLeft: heroComposerLeft(width),
      composerRight: heroComposerLeft(width) + heroComposerWidth(width) - 1,
      // No status bar in hero → no status region at all (rows + 1 is off-screen,
      // so `surfaceRegion` can never classify a hero row as `status`).
      statusTop: rows + 1,
    }
  }
  return {
    messageRight,
    composerTop: rows - STATUS_BAR_HEIGHT - boxH + 1,
    composerBottom: rows - STATUS_BAR_HEIGHT,
    statusTop: rows - STATUS_BAR_HEIGHT + 1,
  }
}

/** The composer draft's visible text area (rows) — the caret-following window
 *  height the render uses. Mirrors `Math.max(1, composerH − 4)` at render. */
function composerTextArea(): number {
  // Painted card = 2 half-row edges + text area + 1 gap row + 1 status row.
  return Math.max(1, composerHeight(store.width, store.input, composerMinHeight()) - 4)
}

/** New caret index after moving the composer caret by `dirRows` VISUAL lines
 *  (whole wrapped rows), keeping the same cell column when possible. Used by
 *  the wheel over the composer: when the draft is taller than its box the
 *  wheel scrolls the DRAFT (visual-line caret moves = what ↑/↓ do), not the
 *  transcript. Pure for tests; mirrors conversation's composer row model
 *  (composerVisualRows, so word-wrap row boundaries are exact). */
export function composerCaretMoveVisual(input: string, caret: number, usable: number, dirRows: -1 | 1): number {
  const rows = composerVisualRows(input, usable)
  if (rows.length <= 1) return caret
  const from = composerCaretGlobalRow(input, caret, usable)
  const target = Math.max(0, Math.min(rows.length - 1, from + dirRows))
  if (target === from) return caret
  const src = rows[from]!
  // Column (cells) of the caret inside its source visual row.
  const srcCol = src.text.slice(0, caret - src.start).split('').reduce((acc, ch) => acc + visualWidth(ch), 0)
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


function composerInputIndex(row: number, col: number): number | null {
  const width = process.stdout.columns ?? 80
  const height = process.stdout.rows ?? 24
  const band = composerBand(width, height)
  const usable = composerUsable(width)
  const lead = store.composerImage !== null ? 1 : 0
  const textArea = Math.max(1, band.height - 4)
  const caretRow = composerCaretGlobalRow(store.input, store.cursor, usable)
  const win = composerWindow(store.input, usable, caretRow, textArea)
  const clickRow = win.first + (row - (band.top + 1 + lead))
  if (clickRow < 0 || clickRow >= win.rows.length) return null
  const target = win.rows[clickRow]!
  // Card content starts after the round border + paddingX (2 cells) of `left`.
  return target.start + colToChar(target.text, Math.max(0, col - (band.left + 2)))
}

function positionCursorByMouse(row: number, col: number): void {
  const index = composerInputIndex(row, col)
  if (index !== null) store.setCursor(index)
}

function composerCaretCell(): { row: number; col: number } | null {
  const width = process.stdout.columns ?? 80
  const height = process.stdout.rows ?? 24
  // Hero-aware placement (docked: bottom of the message column; hero: the
  // centered narrow card) — without this the hardware cursor was parked at the
  // docked position while the card sat mid-screen.
  const band = composerBand(width, height)
  const usable = composerUsable(width)
  const lead = store.composerImage !== null ? 1 : 0
  const caret = Math.max(0, Math.min(store.cursor, store.input.length))
  // The caret cell is the end of the wrapped PREFIX (input[0..caret)): the
  // suffix that follows the caret starts at that same cell, so wrapping the
  // prefix with Ink's own rule yields the exact rendered caret position.
  const lines = composerWrap(store.input.slice(0, caret), usable)
  const lastLine = lines[lines.length - 1] ?? ''
  const caretRow = Math.max(0, lines.length - 1)
  const textArea = Math.max(1, band.height - 4)
  const win = composerWindow(store.input, usable, caretRow, textArea)
  const visRow = Math.max(0, caretRow - win.first)
  // band.top is the card's ▄ edge row; the content starts one row below it,
  // two columns in (the two pad columns this borderless card paints itself).
  return { row: band.top + 1 + lead + visRow, col: band.left + 2 + visualWidth(lastLine) }
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
  const band = composerBand(width, height)
  const usable = convUsableWidth(width, sidebarVisibleFor(width))
  const flatItems = store.getItems()
  const tRows = debugLayout ? Date.now() : 0
  const rows = buildTranscriptRows(flatItems, usable)
  if (debugLayout) perfTick('rows', Date.now() - tRows, flatItems.length, Math.round(process.memoryUsage().heapUsed / 1048576))
  const joined = rows.map((r) => r.text).join('\n')
  const inputStart = joined.length + 1
  const rowPrefix: number[] = []
  {
    let acc = 0
    for (const r of rows) { rowPrefix.push(acc); acc += r.text.length + 1 }
  }
  const composerLastContent = band.top + band.height - 2
  const cellIndex = (row: number, col: number): number | null => {
    if (row > band.top && row <= composerLastContent) {
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

export function writeClipboard(text: string): void {
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
  // Wayland tool and the two X11 tools in order
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
 *  the Ctrl+Y keyboard fallback.
 *
 *  The frame-buffer `copiedText` is the reliable source (it reproduces the exact
 *  highlighted cells, no drift across item margins); the flat-model
 *  `selectionText` is only a last-resort fallback (its screen→row mapping drifts
 *  across margins and can resolve to '' or the wrong line). No-op unless the
 *  selection spans a real drag. */
function copyCurrentSelection(): void {
  const sel = store.selection
  if (sel === null || (Math.abs(sel.aRow - sel.cRow) + Math.abs(sel.aCol - sel.cCol)) <= 2) return
  const fc = (globalThis as unknown as { __dshFrameController?: { copiedText?: string } }).__dshFrameController
  const rect = fc && fc.copiedText ? fc.copiedText : ''
  const text = rect || selectionText(sel.aRow, sel.aCol, sel.cRow, sel.cCol)
  const trimmed = text.trim()
  if (trimmed !== '') {
    writeClipboard(trimmed)
    const long = trimmed.length > 40
    const preview = long ? trimmed.slice(0, 40) + '…' : trimmed
    // Show the feedback in the bottom STATUS BAR (transient, not a transcript
    // item): a `status` transcript row would re-layout / follow-tail auto-scroll
    // the transcript and slide the screen-coordinate highlight onto the next
    // block below (the user saw this as the highlight jumping to下文). For a
    // large selection the status shows the char count, so the FULL copy (which
    // goes to the clipboard, never truncated) can be trusted.
    store.flashStatus(long ? `Copied: ${preview} (${trimmed.length} chars)` : `Copied: ${preview}`)
  }
}

// ── the conversation key handler ────────────────────────────────────────────

/** Region where the CURRENT mouse-gesture anchor (store.selection, where the
 *  press started) sits on the main surface, or null when no selection is live.
 *  Used to route drags/releases by their START region — a drag that began on
 *  the message column keeps selecting as the pointer crosses other regions,
 *  while a drag anchored on the sidebar selects sidebar text only. */
function anchorSurfaceRegion(): SurfaceRegion | null {
  const s = store.selection
  if (s === null) return null
  return surfaceRegion(s.aRow, s.aCol, mainSurfaceGeometry())
}

function conversationKey(k: RawKey, tui: TuiService): void {
  const input = store.input
  const char = k.char ?? ''
  if (char === '\n' || k.altEnter) { resetHistoryBrowse(); store.insertAtCursor('\n'); return }
  // Bracketed paste: if it is a local image path, attach it;
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
  // (wrapping at the ends); a no-op for models without one.
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
      // S2-2b: while the harness attach is still pending, a command that needs
      // the live agent is deferred rather than run against a session that does
      // not exist yet. The hook queues the full input and returns false.
      if (store.beforeCommand?.(chosen.name, text) !== false) chosen.run(remainder)
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
    // Empty input: ONE ↑ recalls the most recent message (shell habit).
    if (input === '') { browseOlder(); return }
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
    // Empty input (cursor already at 0): ↓ returns to the draft / does nothing.
    if (input === '') return
    if (input.includes('\n')) { store.moveCursorDown(); return }
    if (store.cursor < input.length) { store.setCursor(input.length); return }
    browseNewer()
    return
  }
  if (k.leftArrow) { store.moveCursorLeft(); return }
  if (k.rightArrow) { store.moveCursorRight(); return }
  if (k.pageUp) { store.scrollPage(-1); return }
  if (k.pageDown) { store.scrollPage(1); return }
  // Home/End edit the composer: the caret jumps to the start/end of the current
  // (logical) line — a single-line input therefore goes to the start/end of the
  // whole text. Transcript scrolling stays on PgUp/PgDn + the mouse wheel.
  if (k.home) { store.moveCursorToLineStart(); return }
  if (k.end) { store.moveCursorToLineEnd(); return }
  // A left-click on the Steps sidebar's TITLE band toggles the sidebar
  // (auto → on → off → auto). Only reachable while the sidebar is drawn.
  if (k.mousePress && sidebarVisibleFor(store.width) && k.mousePress.row <= 4
      && k.mousePress.col > store.width - sidebarWidthFor(store.width)) {
    const mode = store.cycleSidebarMode()
    store.flashStatus(mode === 'auto' ? 'Steps: auto (follows width)' : mode === 'on' ? 'Steps: shown' : 'Steps: hidden')
    return
  }
  // While the slash command palette is open, the mouse drives it: the wheel
  // moves the highlighted command (like ↑/↓) and a left-click on a row runs it
  // (like Enter). Otherwise the wheel scrolls the transcript and clicks are the
  // in-place selection/copy.
  const paletteOpen = input.startsWith('/') && filteredCommands(tui).length > 0
  // ── MAIN SURFACE region routing: the mouse only acts on the region it is
  //    hovering (message column / composer / sidebar / status bar). The '/'
  //    palette is a bottom-anchored overlay that owns the mouse while open, so
  //    region routing applies only when it is closed. Region-agnostic key
  //    handling (typing, arrows, …) below is untouched.
  //
  //    Drags/releases are classified by the ANCHOR cell (where the press
  //    started — store.selection), not the current pointer cell, so a drag
  //    that started on the message column keeps selecting as the pointer
  //    passes over other regions, while a drag that STARTED on the sidebar /
  //    status bar (which never anchors there: press is consumed) can never
  //    leak a transcript selection.
  if (!paletteOpen) {
    const g = mainSurfaceGeometry()
    const ptrRow = k.mousePress?.row ?? k.mouseMove?.row ?? k.mouseDrag?.row ?? k.mouseRelease?.row ?? k.wheelUp?.row ?? k.wheelDown?.row
    const ptrCol = k.mousePress?.col ?? k.mouseMove?.col ?? k.mouseDrag?.col ?? k.mouseRelease?.col ?? k.wheelUp?.col ?? k.wheelDown?.col
    if (ptrRow !== undefined && ptrCol !== undefined) {
      const region = surfaceRegion(ptrRow, ptrCol, g)
      if (region === 'status') {
        // Bottom status bar / blank rows: inert (no transcript interaction, no
        // selection anchor). A drag/release that ANCHORED on the message column
        // keeps working — the pointer may pass over this region while selecting
        // transcript text — so only those fall through below.
        if (k.wheelUp !== undefined || k.wheelDown !== undefined) return
        if (k.mouseMove !== undefined) { store.setHoverTool(null); return }
        if (k.mousePress !== undefined) return
        const a = anchorSurfaceRegion()
        if (a !== 'message' && a !== 'composer' && a !== 'sidebar') return
      }
      if (region === 'sidebar') {
        // Steps column: a click on its TITLE band toggles the sidebar (handled
        // above); a PRESS elsewhere anchors a SIDEBAR text selection (drag
        // highlights + copies sidebar rows only — the frame controller's flow
        // copy is bounded by the sidebar column band, see the selection guard).
        // Hover never highlights a transcript row (pointer is outside the
        // message column). The wheel is inert here (the sidebar's own scroll
        // comes in a later increment).
        if (k.wheelUp !== undefined || k.wheelDown !== undefined) return
        if (k.mouseMove !== undefined) { store.setHoverTool(null); return }
        if (k.mousePress !== undefined) {
          store.mousePress(k.mousePress.row, k.mousePress.col)
          return
        }
        // Drag/release over the sidebar: let a gesture that ANCHORED on the
        // sidebar/message/composer continue to the generic handlers below (a
        // sidebar-anchored drag extends the SIDEBAR selection; a message-anchored
        // drag may pass over the sidebar while selecting transcript text — the
        // frame controller bounds each copy to its anchor's column band). Only an
        // anchorless / status-anchored gesture is consumed here.
        const a = anchorSurfaceRegion()
        if (a !== 'message' && a !== 'composer' && a !== 'sidebar') return
      }
      if (region === 'composer') {
        // Wheel over the composer: scrolls the DRAFT itself when it overflows
        // its box (visual-line caret moves — the caret-following window
        // follows), and is inert when the draft fits (nothing to scroll).
        if (k.wheelUp !== undefined || k.wheelDown !== undefined) {
          const usable = composerUsable(store.width)
          const allRows = composerVisualRows(store.input, usable).length
          if (allRows > composerTextArea()) {
            const dir: -1 | 1 = k.wheelUp !== undefined ? -1 : 1
            let caret = store.cursor
            for (let i = 0; i < WHEEL_STEP; i++) {
              const next = composerCaretMoveVisual(store.input, caret, usable, dir)
              if (next === caret) break
              caret = next
            }
            store.setCursor(caret)
          }
          return
        }
        // Press/drag/release/hover over the composer fall through to the
        // handlers below (they already edit the draft only: resolveRow maps
        // composer rows to null, mouse clicks place the caret, drags select the
        // draft). A hover over the composer must not highlight a transcript
        // tool row (resolveRow only maps transcript rows, so this is a no-op
        // guard for clarity).
        if (k.mouseMove !== undefined) { store.setHoverTool(null); return }
      }
      // region === 'message': fall through to the transcript handlers below.
    }
  }
  if (k.wheelUp) {
    if (paletteOpen) { const len = Math.max(1, filteredCommands(tui).length); store.setCommandIndex((store.commandIndex - 1 + len) % len); return }
    store.scrollLines(-WHEEL_STEP); return
  }
  if (k.wheelDown) {
    if (paletteOpen) { const len = Math.max(1, filteredCommands(tui).length); store.setCommandIndex((store.commandIndex + 1) % len); return }
    store.scrollLines(WHEEL_STEP); return
  }
  if (k.mousePress) {
    if (paletteOpen) { const idx = commandPaletteIndexFromRow(k.mousePress.row, tui); if (idx >= 0) { store.setCommandIndex(idx); return } }
    store.mousePress(k.mousePress.row, k.mousePress.col); return
  }
  if (k.mouseMove) {
    // HOVER: with ?1003 any-motion the terminal reports motion without a button.
    // While the '/' palette is open, highlight the command under the cursor
    // Elsewhere the hover feeds the tool-row affordance: a
    // settled tool row (expandable) highlights under the cursor on hover, like
    // a clickable header.
    if (paletteOpen) { const idx = commandPaletteIndexFromRow(k.mouseMove.row, tui); if (idx >= 0) store.setCommandIndex(idx); return }
    const hit = store.resolveRow(k.mouseMove.row)
    // Same rule as Think rows: any settled tool row (or any reasoning row) is
    // hover-highlighted / clickable — no extra "has body" requirement.
    const hoverable = hit !== null && (
      (hit.kind === 'tool' && hit.tool !== undefined && hit.tool.state !== 'running')
      || hit.kind === 'reasoning'
      || (hit.kind === 'compaction' && hit.compaction?.summary !== undefined)
    )
    store.setHoverTool(hoverable ? hit.key : null)
    return
  }
  if (k.mouseDrag) { store.mouseDrag(k.mouseDrag.row, k.mouseDrag.col); return }
  if (k.mouseRelease) {
    // The anchoring region has to be read BEFORE `mouseRelease`: a click CLEARS
    // the selection, and `anchorSurfaceRegion()` reads the selection's anchor —
    // so reading it afterwards always returned null and every disclosure click
    // (tool rows, Think rows, compaction rows) fell through to caret placement.
    const anchorRegion = anchorSurfaceRegion()
    const kind = store.mouseRelease(k.mouseRelease.row, k.mouseRelease.col)
    if (paletteOpen) {
      // Left-click on a palette row = Enter (run that command). A click on a row
      // that is NOT the first-visible one first moves the highlight; releasing on
      // the (now) highlighted row runs it.
      const idx = commandPaletteIndexFromRow(k.mouseRelease.row, tui)
      if (idx >= 0 && kind === 'click') { runCommandAt(idx, tui); return }
    }
    if (kind === 'click') {
      // Click on a SETTLED tool row toggles it exactly like a Think row (no
      // "must have a body" gate); a click on a Think header toggles that
      // reasoning row (cross-surface parity). Only a click that ANCHORED on the
      // MESSAGE column may toggle transcript rows — a click that started on the
      // sidebar / composer / status only clears its selection and, on the
      // composer, places the caret. Everything else falls through to the
      // composer caret placement.
      if (anchorRegion === 'message') {
        const hit = store.resolveRow(k.mouseRelease.row)
        if (hit !== null && hit.kind === 'tool' && hit.tool !== undefined && hit.tool.state !== 'running') {
          store.toggleToolExpanded(hit.key)
          return
        }
        if (hit !== null && hit.kind === 'reasoning') {
          store.toggleReasoningRow(hit.key)
          return
        }
        if (hit !== null && hit.kind === 'compaction' && hit.compaction?.summary !== undefined) {
          // Same per-row override map the tool rows use (and /think flips it).
          store.toggleToolExpanded(hit.key)
          return
        }
      }
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
    // This process owns the session, so it both enforces the new mode (bash
    // fence + fs row) and records the durable `sandbox/mode` event.
    // `cyclePermission` notifies through the shared store (importing a hook from
    // index.tsx would hit a second module copy).
    const session = store.session
    if (session !== undefined) {
      // The sandbox mode and the approval policy are INDEPENDENT (review F2:
      // dsh-tui-security.md). Cycling to danger-full-access raises the file
      // boundary alone — it must NOT silently flip the approval policy to
      // never, or one Tab press would disable both the sandbox and asking.
      // The policy stays whatever the user last chose (default ask); turning
      // approvals off stays an explicit human action (the dock's "Allow
      // always" per tool), never a side effect of a mode switch.
      try { setSandboxMode(session, next) } catch { /* best-effort */ }
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
    // Human self-heal: if the patched frame writer has stopped flushing (a
    // stalled render loop), ANY keypress revives the screen at both levels —
    // store.touch() feeds the normal React/Ink path and the writer's
    // __dshTuiRepaintLastFrame bypasses Ink entirely. Cheap no-op otherwise.
    const frameGlobals = globalThis as unknown as { __dshTuiLastFlushAt?: number; __dshTuiRepaintLastFrame?: () => void }
    const lastFlush = frameGlobals.__dshTuiLastFlushAt
    if (store.running && lastFlush !== undefined && Date.now() - lastFlush > 3000 && frameGlobals.__dshTuiRepaintLastFrame !== undefined) {
      store.touch()
      frameGlobals.__dshTuiRepaintLastFrame()
    }
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
  // Unmount (another fullscreen panel, session switch): drop the row resolver
  // the click handler reads.
  React.useEffect(() => () => store.setRowResolver(null), [])
  const version = store.getVersion()
  const themeEpoch = store.themeEpoch
  const items = store.getItems()
  frameGapProbe(items.length, store.layoutScroll, store.followTail)
  const steps = store.steps
  const stepsDone = store.stepsDone
  const stepsTotal = store.stepsTotal
  const input = store.input
  const commands = props.tui.commands.list()
  const filter = store.commandFilter
  const commandIndex = store.commandIndex
  const question = store.question
  const width = store.width
  // Per-row effective expansion: a Think row opens on its own when clicked
  // (per-row override), or follows the /think master switch by default.
  const reasoningExpandedFor = (item: TranscriptItem): boolean =>
    item.kind === 'reasoning' && store.reasoningExpanded(item.key)
  const permissionLabel = store.permissionLabel
  const permissionColor = store.permissionColor
  const modelLabel = store.modelLabel
  // Bottom-bar session stats as VALUE/LABEL segments (steps/turns · tokens;
  // LLM/Tool durations are folded but not displayed). Segments keep numbers
  // apart from their labels ("steps", "tok in", …) for two-tone rendering;
  // empty until the session has any activity.
  const statsParts = formatSessionStatsParts(store.stats)
  // The composer shows the model with its reasoning effort as a separate
  // warning-colored chip (an effort chip); the full label embeds the
  // effort as ` · <name>`, so the base part strips that suffix.
  const effortName = store.modelEffortName
  const modelBaseLabel = effortName === '' || !modelLabel.endsWith(` · ${effortName}`)
    ? modelLabel
    : modelLabel.slice(0, Math.max(0, modelLabel.length - effortName.length - 3))
  const showSidebar = sidebarVisibleFor(width)

  const heroActive = store.hero
  // Hero content box: the padded hero area starts at column 1 (0-based) and
  // keeps one column on the right, so the usable width is `width − 2` — using
  // `width − 4` made every centered line (art, title, hints, card, palette)
  // sit one column left of the true center on even widths.
  const heroUsable = Math.max(20, width - 2)
  const heroBoxH = composerHeight(width, input, composerMinHeight()) + (store.composerImage !== null ? 1 : 0)
  const heroMark = heroActive ? heroMarkFor(store.rows, width) : 'none'
  const heroBrandLines = heroMarkRows(heroMark) + 1
  // Brand art colors follow the theme (theme.text blended toward theme.bg), so
  // a colorscheme switch restyles the mark with the rest of the chrome.
  const heroArtInk = heroMark === 'blocks' ? heroArtInkColors(theme.text, theme.bg) : []
  const hero = heroActive
    ? heroLayout({ rows: store.rows, boxH: heroBoxH, brandLines: heroBrandLines, hintLines: store.olderLoading ? 1 : 0 })
    : null
  // Static web-parity placeholder while the hero composer is empty (no
  // rotation: web's `placeholder.hero` is one fixed sentence).
  const heroPlaceholderShown = heroActive && input === '' && store.composerImage === null
  const heroPlaceholderText = HERO_PLACEHOLDER
  /** Clip one dialog row to `w` VISUAL columns (never let a row wrap the box). */
  const clipTo = (text: string, w: number): string => {
    if (visualWidth(text) <= w) return text
    let out = ''
    let used = 0
    for (const ch of text) {
      const cw = visualWidth(ch)
      if (used + cw > w) break
      out += ch
      used += cw
    }
    return out
  }

  /** Center one hero line by VISUAL width (CJK counts 2 columns). */
  const centerInHero = (text: string): string =>
    ' '.repeat(Math.max(0, Math.floor((heroUsable - visualWidth(text)) / 2))) + text
  // The hero headline is the dsh-tui VERSION, verbatim (e.g. `0.3.1-beta`); the
  // "-beta" prerelease segment already marks a preview build, so no extra badge.
  const heroTitleLine = `${APP_VERSION}`

  const filtered = useMemo(
    () => filteredCommands(props.tui),
    [commands, filter, version],
  )

  const isSlash = input.startsWith('/')
  // Mirrors the palette's painted state for the frame suffix (caret hiding).
  commandPaletteOpen = isSlash && filtered.length > 0
  const [hoverIndex, setHoverIndex] = useState(commandIndex)
  React.useEffect(() => setHoverIndex(commandIndex), [commandIndex])
  const effectiveIndex = filtered.length === 0 ? -1 : (hoverIndex % filtered.length)

  const status = isRawModeSupported ? '' : '(raw input unsupported) '

  const composerH = composerHeight(width, input, composerMinHeight())
  // Scroll window: when the input's wrapped rows exceed the visible text area,
  // render only the caret-following window (keeps the caret row visible;
  // nothing overflows over the composer footer).
  const cUsable = composerUsable(width)
  const caretGlobalRow = Math.max(0, composerWrap(input.slice(0, store.cursor), cUsable).length - 1)
  const cTextArea = Math.max(1, composerH - 4)
  const cWin = composerWindow(input, cUsable, caretGlobalRow, cTextArea)
  // Approval dock height: fixed — border 2 + padding 2 + header 1 + gap 1 +
  // one truncated reason line 1 + gap 1 + choice row 1 + gap 1 + hint 1.
  const approvalH = store.approval === null ? 0 : 11
  // Question dock height — from the SAME pure layout function the question
  // panel renders from (question-layout.questionDockRows). The dock lives
  // IN-FLOW in the message column (see the render below), so the transcript
  // space reserved here must equal the rows the dock actually paints: typing
  // in the inline "Other" editor grows the dock (pushing the message history
  // up, one row per new visual input row) until its ≤5-row input window caps
  // the height; the measured store.questionRows corrects the first-frame
  // estimate so the reservation never drifts from the painted dock.
  const questionH = store.question === null ? 0 : (() => {
    const q = store.question
    // Plan-review presents its own Chinese question and drops the plan body
    // (the plan is the transcript block above) and the "Other…" row — the
    // SAME presentation function the question panel paints from, so the
    // reserved transcript space never drifts from the painted dock.
    const pres = questionPresentation(q.item)
    return questionDockRows(
      pres.question,
      pres.detail,
      pres.options,
      q.customMode,
      q.custom,
      dockInnerWidth(width, store.sidebarMode ?? 'auto'),
      store.rows,
      q.questions.length > 1, // multi-question ask: +1 tab-bar row
      pres.showOther,
    )
  })()
  // The approval dock and the QUESTION dock both live IN-FLOW inside the
  // message column (right under the transcript, above the composer): whichever
  // is open shrinks the transcript by its own height — answering pushes the
  // message history upward instead of floating over it.
  const modalH = store.panel === 'approval'
    ? approvalH
    : store.panel === 'question'
      ? Math.max(questionH, store.questionRows)
      : 0
  const usable = convUsableWidth(width, showSidebar)
  // Deterministic numeric sidebar width (same formula convUsableWidth uses for
  // the message wrap width). A percentage would let Ink round independently of
  // the layout math, flipping the wrap width by ±1 column and churning the
  // measured row heights (sidebar width jump / re-layout feedback).
  const sidebarWidth = showSidebar ? Math.max(20, Math.round(width * 0.3)) : 0
  const viewportLines = convViewportLines(composerH, 0, modalH)
  const rows = useMemo(() => {
    const t0 = debugLayout ? Date.now() : 0
    const built = buildRows(items, steps)
    if (debugLayout) perfTick('items', Date.now() - t0, items.length, Math.round(process.memoryUsage().heapUsed / 1048576))
    return built
  }, [items, steps])
  // The collapsed Think tool rows always follow the tail (see thinkLiveLine /
  // capTail), so the row heights are independent of whether the model is
  // actively streaming — the layout never jumps mid-think.
  const layout = useMemo(() => {
    const tLayout0 = debugLayout ? Date.now() : 0
    let mdMs = 0
    let mdCalls = 0
    if (debugEst) {
      estHits = 0
      estParses = 0
      estParseMs = 0
      estCheap = 0
      if (store.loadGeneration !== estLastLoadGen) {
        logErrorFileOnly('est',
          `loadGeneration ${estLastLoadGen} → ${store.loadGeneration}: debounced markdown cache dropped (all markdown rows re-parse once)`)
        estLastLoadGen = store.loadGeneration
      }
    }
    // A width change invalidates every cached row height (wrap counts differ);
    // drop the caches and bump the estimate generation so no entry computed for
    // the previous width can be served again (the mounted rows re-measure right
    // away: the measure effect depends on `usable`).
    if (usable !== lastLayoutWidth) {
      if (debugTail) {
        logErrorFileOnly('tail', `width change ${lastLayoutWidth} -> ${usable}: cleared ${measuredHeights.size} measured heights`)
      }
      measuredHeights.clear()
      clearMarkdownHeightCache()
      estGeneration += 1
      lastLayoutWidth = usable
    }
    // A settled assistant message replaces the streamed copy with authoritative
    // text: re-parse its markdown height exactly once (the streaming estimate is
    // deliberately debounced, so it can be several rows short — and a short
    // height is what clips the answer's last wrapped line off the viewport).
    if (store.assistantSettleEpoch !== lastSettleEpoch) {
      lastSettleEpoch = store.assistantSettleEpoch
      // Per-row bust (was: `clearMarkdownHeightCache()` + a global
      // `estGeneration += 1`, i.e. every markdown row re-parsed ≈0.72 s per
      // settle — the steady-state jank root cause, session/optimization-plan.md §8).
      bustMarkdownHeight(store.lastSettledKey)
      if (debugEst) {
        logErrorFileOnly('est', `settle bust row=${store.lastSettledKey} (per-row; estGen=${estGeneration} unchanged)`)
      }
    }
    if (debugTail) {
      // Snapshot the TAIL row's cache entry BEFORE this pass reads it, so the
      // true measurement and the estimate used by the window can be compared
      // for the same text.
      const tr = rows.length > 0 ? rows[rows.length - 1] : undefined
      preTailMeas = tr?.type === 'item' ? (measuredHeights.get(String(tr.item.key)) ?? -1) : -1
    }
    // Row heights come from the measured cache first; a row that has not been
    // painted yet (scrolled out / long history) is ESTIMATED and that estimate
    // stays in estCache — it is never written into the measured map, because a
    // cache entry there is treated as painted truth (and a stale estimate in
    // that slot is what leaves the window one row short of the real content).
    //
    // S1b — windowed estimation (session/optimization-plan.md §3): a mdast parse
    // costs ~0.55 ms, and the replayed giant session has 1240 markdown rows, so
    // parsing ALL of them on the first frame was 683 of the 752 ms cold layout.
    // Pass A walks every row with a cheap wrapped-line placeholder (or the
    // precise value when it is already cached); pass B re-parses only the rows
    // the viewport can actually show (± {@link OVERSCAN_ROWS}), visible rows
    // first. Heights outside that window are only used for `content`/offsets of
    // unpainted history: a row that gets painted is re-laid from its MEASURED
    // height (the truth, see {@link resolveRowHeight}), so scrolling into a
    // cheap-estimated region self-corrects without any guesswork, and the tail
    // (always in-window, hence precise) can never be clipped by a placeholder
    // that is too small.
    const contents = new Array<number>(rows.length)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!
      if (r.type === 'steps') {
        contents[i] = rowHeight('steps', stepsBlockHeight(steps.length))
        continue
      }
      // The estimate is a placeholder for a row that has not been painted
      // (or only returned a collapsed, implausible reading — see
      // resolveRowHeight); a real measurement always wins.
      const est = estItemLinesCachedOrCoarse(r.item, usable, reasoningExpandedFor(r.item))
      contents[i] = resolveRowHeight(est, measuredHeights.get(String(r.item.key)))
    }
    // Full layout walk every pass (optimization-5 incremental prefix reuse was
    // REMOVED: real-terminal A/B showed it garbled streaming messages — stale
    // prefix heights combined with the debounced estimate clipped the live
    // tail. A full walk over cached per-row heights is cheap (est/measured
    // maps), and notify batching (优化2) bounds it to ≤40fps.)
    const hts = new Array<number>(rows.length)
    for (let i = 0; i < rows.length; i++) hts[i] = contents[i]! + rows[i]!.top + rows[i]!.bottom
    const starts: number[] = []
    let s = 0
    for (let i = 0; i < hts.length; i++) { starts.push(s); s += hts[i]! }
    // Pass B: precise heights for the rows the viewport can show. The window is
    // derived from the pass-A offsets, so it needs no guess about where the view
    // is (follow-tail, a drag, PgUp — all of them already produced `effGuess`).
    const effGuess = store.followTail
      ? Math.max(0, s - viewportLines)
      : Math.max(0, Math.min(store.scroll, Math.max(0, s - viewportLines)))
    let winFirst = 0
    while (winFirst < rows.length && starts[winFirst]! + hts[winFirst]! <= effGuess) winFirst++
    if (winFirst >= rows.length) winFirst = Math.max(0, rows.length - 1)
    let winLast = rows.length - 1
    while (winLast >= 0 && starts[winLast]! >= effGuess + viewportLines) winLast--
    if (winFirst > winLast) winFirst = Math.max(0, winLast)
    let refined = 0
    let refineMs = 0
    let changed = false
    for (const i of windowRefineOrder(winFirst, winLast, rows.length)) {
      const r = rows[i]!
      if (r.type !== 'item') continue
      // Timed ALWAYS (not just under a debug flag): the budget below has to
      // hold in a normal run too, and it is two `Date.now()` calls per refined
      // row (a few dozen on a warm pass).
      const tParse = Date.now()
      const exact = estItemLines(r.item, usable, reasoningExpandedFor(r.item))
      const dt = Date.now() - tParse
      refineMs += dt
      refined += 1
      if (isMarkdownKind(r.item)) { mdCalls += 1; mdMs += dt }
      const c = resolveRowHeight(exact, measuredHeights.get(String(r.item.key)))
      if (c !== contents[i]) {
        contents[i] = c
        hts[i] = c + r.top + r.bottom
        changed = true
      }
      // Time budget: the visible rows were refined first, so stopping here only
      // leaves overscan rows on their placeholder (never the visible frame).
      // They get their exact height on a later pass, and are measured for real
      // as soon as they are painted.
      if (refineMs > MD_PARSE_BUDGET_MS) break
    }
    if (changed) {
      s = 0
      for (let i = 0; i < hts.length; i++) { starts[i] = s; s += hts[i]! }
    }
    if (debugLayout) {
      const ms = Date.now() - tLayout0
      if (ms > debugLayoutMs) {
        logErrorFileOnly('layout',
          `pass rows=${rows.length} ms=${ms} markdownRows=${mdCalls} markdownMs=${mdMs} `
          + `coarseRows=${estCheap} win=${winFirst}-${winLast} refined=${refined} refineMs=${refineMs} `
          + `items=${items.length} heap=${Math.round(process.memoryUsage().heapUsed / 1048576)}MB`)
      }
    }
    if (debugEst) {
      logErrorFileOnly('est',
        `pass rows=${rows.length} hits=${estHits} parses=${estParses} parseMs=${estParseMs} `
        + `coarse=${estCheap} win=${winFirst}-${winLast} refined=${refined} refineMs=${refineMs} `
        + `content=${s} estGen=${estGeneration} loadGen=${store.loadGeneration} usable=${usable} settled=${store.assistantSettleEpoch}`)
    }
    return { hts, starts, content: s }
  }, [rows, usable, steps, store.measureEpoch, store.expansionEpoch, store.loadGeneration, store.assistantSettleEpoch])
  const maxScroll = Math.max(0, layout.content - viewportLines)
  const effectiveScroll = store.followTail ? maxScroll : Math.max(0, Math.min(store.scroll, maxScroll))
  const topRow = 2
  store.setLayout(layout.content, viewportLines, effectiveScroll, topRow)
  // Tool/Think row expansion clicks/hover: TOLERANT mapping from a 1-based
  // terminal row to the nearest toggleable row — every TOOL row and every
  // reasoning (Think) row — matched on its HEADER line (first content line of
  // the item: cumulative start + its top margin). A ±TOOL_HIT_TOLERANCE band
  // absorbs small screen-offset errors (borders/padding), and body lines far
  // below a header are not clickable (no accidental collapse while reading an
  // expanded body). Nearest header within the band wins.
  const TOOL_HIT_TOLERANCE = 3
  const toggleHeaders: { item: TranscriptItem; header: number }[] = []
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j]!
    if (r.type === 'item' && (r.item.kind === 'tool' || r.item.kind === 'reasoning'
      || (r.item.kind === 'compaction' && r.item.compaction?.summary !== undefined))) {
      toggleHeaders.push({ item: r.item, header: layout.starts[j]! + r.top })
    }
  }
  store.setRowResolver((row) => {
    const line = row - topRow + effectiveScroll
    let best: TranscriptItem | null = null
    let bestDist = Infinity
    for (const t of toggleHeaders) {
      const dist = Math.abs(line - t.header)
      if (dist <= TOOL_HIT_TOLERANCE && dist < bestDist) { best = t.item; bestDist = dist }
    }
    return best
  })
  let first = 0
  while (first < rows.length && layout.starts[first] + layout.hts[first] <= effectiveScroll) first++
  if (first >= rows.length) first = Math.max(0, rows.length - 1)
  let last = rows.length - 1
  while (last >= 0 && layout.starts[last] >= effectiveScroll + viewportLines) last--
  if (first > last) first = Math.max(0, last)
  const shift = first < rows.length ? effectiveScroll - layout.starts[first] : 0
  if (debugTail) {
    const tailRow = last >= 0 && last < rows.length ? rows[last] : undefined
    const tailItem = tailRow?.type === 'item' ? tailRow.item : undefined
    const tailKey = tailItem !== undefined ? String(tailItem.key) : ''
    logErrorFileOnly('tail',
      `usable=${usable} items=${items.length} rows=${rows.length} V=${viewportLines} content=${layout.content} `
      + `max=${maxScroll} eff=${effectiveScroll} follow=${store.followTail} first=${first} last=${last} shift=${shift} `
      + `tail=${tailItem?.kind ?? tailRow?.type ?? '-'} textLen=${tailItem?.text.length ?? 0} `
      + `est=${tailItem !== undefined ? estItemLines(tailItem, usable, reasoningExpandedFor(tailItem)) : -1} `
      + `preMeas=${preTailMeas} `
      + `meas=${tailItem !== undefined ? (measuredHeights.get(tailKey) ?? -1) : -1} `
      + `hts=${last >= 0 ? layout.hts[last] : -1} top=${tailRow !== undefined ? tailRow.top : -1} `
      + `bottom=${tailRow !== undefined ? tailRow.bottom : -1} gen=${estGeneration} `
      + `settle=${store.assistantSettleEpoch}`)
  }
  const sel = store.selection
  const selRange = sel !== null ? composerSelectionRange(sel) : null

  const renderRow = (r: Row): React.ReactNode =>
    r.type === 'steps'
      ? <Box key="steps" marginTop={r.top} marginBottom={r.bottom}><StepsRow steps={steps} /></Box>
      : (
        <RowErrorBoundary key={r.item.key}>
          <Box marginTop={r.top} marginBottom={r.bottom} flexShrink={0}>
            <MemoTranscriptItemView
              item={r.item}
              expandReasoning={reasoningExpandedFor(r.item)}
              toolExpanded={r.item.kind === 'tool' && r.item.tool?.body !== undefined && store.isToolExpanded(r.item.key)}
              compactionExpanded={r.item.kind === 'compaction' && store.isToolExpanded(r.item.key)}
              hovered={store.hoveredToolKey === r.item.key
                && (r.item.kind === 'reasoning'
                  || r.item.kind === 'compaction'
                  || (r.item.kind === 'tool' && r.item.tool !== undefined && r.item.tool.state !== 'running'))}
              themeEpoch={themeEpoch}
              usable={usable}
              toolLive={store.running && !store.paused}
              reasoningLive={r.item.kind === 'reasoning' && store.running && !store.paused
                && items.length > 0 && items[items.length - 1] === r.item}
            />
          </Box>
        </RowErrorBoundary>
      )

  /* Composer card chrome (web parity — `InputBar.module.css` `.card`):
   *  - FILL: web `--dsw-specific-input-major` = `--dsw-static-neutral-bluish-850`
   *    in the dark theme = #2c2c2e, which IS this palette's `element` (the
   *    nested-surface step; the light skin maps it to its own raised surface).
   *  - STROKE: web's `--dsw-alias-border-l2` hairline (rgba(255,255,255,.12))
   *    resolved over that fill ≈ #454547 → this palette's `borderActive`.
   *  The card is BORDERLESS (user call): a plain filled rectangle. Ink's Box
   *  border only carries a color and its cells keep the page background (Ink
   *  has no per-Box background), so a framed card either leaves the ring
   *  unfilled or squares off the fill at the corners — a borderless solid
   *  block sidesteps both. Every row is one bg-colored <Text> spanning the full
   *  card width, so the fill is edge-to-edge. */
  const cardFill = theme.element

  /** One full-width composer row of the BORDERLESS card: two pad columns, the
   *  body, the fill, two pad columns — the fill covers the entire rectangle, so
   *  the card reads as one solid block (the pad columns keep the text/caret
   *  exactly where the bordered variant had them: content starts 2 columns in
   *  from the card's left edge, so no geometry moved). */
  const composerRow = (
    key: string,
    text: string,
    body?: React.ReactNode,
  ): React.ReactNode => {
    const pad = Math.max(0, cUsable - visualWidth(text))
    return (
      <Text key={key} backgroundColor={cardFill} wrap="truncate">
        {'  '}
        {body ?? text}
        {' '.repeat(pad)}
        {'  '}
      </Text>
    )
  }

  /** Body of one text row, with the selection painted as an inverse span (the
   *  caret itself is the hardware cursor, positioned by composerCaretCell). */
  const composerRowBody = (text: string, startOffset: number): React.ReactNode => {
    const seg = (a: number, b: number, inv: boolean, k: string): React.ReactNode =>
      a < b ? <Text key={k} inverse={inv} backgroundColor={cardFill}>{text.slice(a, b)}</Text> : null
    if (selRange === null) return text
    const s = Math.max(0, selRange.start - startOffset)
    const e = Math.min(text.length, Math.max(0, selRange.end - startOffset))
    if (e <= s) return text
    return (
      <>
        {seg(0, s, false, 's0')}
        {seg(s, e, true, 's1')}
        {seg(e, text.length, false, 's2')}
      </>
    )
  }

  /** The text-area rows of the caret-following window: exactly the visible
   *  `textArea` rows (short drafts pad with empty filled rows, so the card's
   *  fill and height are identical on every frame). */
  const composerTextRows = (): React.ReactNode[] => {
    const visible = cWin.rows.slice(cWin.first, cWin.first + cTextArea)
    const out: React.ReactNode[] = []
    for (let i = 0; i < cTextArea; i++) {
      const row = visible[i]
      if (row === undefined) {
        out.push(composerRow(`cm-${i}`, ''))
        continue
      }
      if (i === 0 && heroPlaceholderShown) {
        out.push(composerRow(
          `cm-${i}`,
          status + heroPlaceholderText,
          <>
            {status}
            <Text color={mutedReadable()} backgroundColor={cardFill}>{heroPlaceholderText}</Text>
          </>,
        ))
        continue
      }
      // The raw-mode warning prefix rides the FIRST row (as it always did);
      // its length shifts the row's local indices, so the selection offset is
      // passed as `row.start - status.length` (local index of the prefix's
      // first cell) and the per-character mapping stays exact.
      const prefix = i === 0 ? status : ''
      const text = prefix + row.text
      const rowStart = i === 0 ? row.start - prefix.length : row.start
      out.push(composerRow(`cm-${i}`, text, composerRowBody(text, rowStart)))
    }
    return out
  }

  /** Status row of the card (permission chip + model), painted edge to edge
   *  with the same fill. */
  const composerStatusRow = (): React.ReactNode => {
    const chipIcon = store.permission === 'danger-full-access' ? '🔓' : '🔒'
    const left = `${chipIcon} ${permissionLabel} `
    const leftTab = '(Tab)'
    const modelText = modelLabel === '' ? '' : `Model: ${modelBaseLabel}`
    const effortText = effortName === '' ? '' : ` · ${effortName}`
    const used = visualWidth(left) + visualWidth(leftTab) + visualWidth(modelText) + visualWidth(effortText)
    const fill = Math.max(1, cUsable - used)
    return composerRow(
      'cm-status',
      left + leftTab + ' '.repeat(fill) + modelText + effortText,
      <>
        <Text color={theme.text} backgroundColor={cardFill}>{left}</Text>
        <Text color={permissionColor} backgroundColor={cardFill}>{leftTab}</Text>
        {' '.repeat(fill)}
        {modelText !== '' ? <Text color={theme.text} backgroundColor={cardFill}>{modelText}</Text> : null}
        {effortText !== '' ? <Text color={mutedReadable()} backgroundColor={cardFill}>{effortText}</Text> : null}
      </>,
    )
  }

  /** The composer card — ONE element shared by both phases: docked at the
   *  bottom of the message column, or centered inside the hero stack (web
   *  parity). Only its container changes, so caret/height/mouse math is
   *  identical in both. */
  const composerNode = (
    <Box flexShrink={0} flexDirection="column"
        height={composerHeight(width, input, composerMinHeight()) + (store.composerImage !== null ? 1 : 0)}>
        {/* Half-row edge: `▄` paints the card color in the LOWER half of the
            cell (page color above), `▀` the UPPER half at the bottom — the fill
            block therefore grows HALF A ROW on each side, which is the closest a
            terminal gets to "½ extra padding row above and below". */}
        <Text color={cardFill} backgroundColor={theme.bg} wrap="truncate">{'▄'.repeat(Math.max(1, cUsable + 4))}</Text>
        {/* Image chip row (fills the card). */}
        {store.composerImage !== null && composerRow(
          'cm-image',
          `[Image: ${store.composerImage.name}] · Esc to remove`,
          <>
            <Text color={theme.primary} backgroundColor={cardFill}>[Image: {store.composerImage.name}]</Text>
            <Text color={mutedReadable()} backgroundColor={cardFill}> · Esc to remove</Text>
          </>,
        )}
        {composerTextRows()}
        {/* One blank filled row between the draft and the status row (the same
            breathing space the docked card always had). */}
        {composerRow('cm-blank', '')}
        {composerStatusRow()}
        <Text color={cardFill} backgroundColor={theme.bg} wrap="truncate">{'▀'.repeat(Math.max(1, cUsable + 4))}</Text>
      </Box>
  )

  /** The command palette floats just ABOVE the composer card; `lift` is the
   *  number of hero rows below the card (0 when the composer is docked). While
   *  the hero is up the popup is centered at the CARD's width (the card is a
   *  narrow centered column there), so the two always share one column band. */
  // The hero card and its command palette must occupy the SAME column band.
  // Ink centers an absolute child in its own coordinate space (the popup is
  // positioned from the terminal's left edge), while the card is centered
  // in-flow inside the padded hero area — two rounding paths that disagreed by
  // 1–2 columns depending on the width. Both now use ONE explicit pad:
  // `heroCardPad` columns inside the hero content box (origin = the hero Box's
  // own paddingX, measured as column 2) for the card, and the same pad shifted
  // by that origin for the absolutely positioned popup.
  const heroCardPad = Math.max(0, Math.floor((heroUsable - heroComposerWidth(store.width)) / 2))
  const HERO_CONTENT_ORIGIN = 1
  const heroPaletteLeft = store.hero ? heroCardPad + HERO_CONTENT_ORIGIN : undefined

  const renderPalette = (lift: number): React.ReactNode =>
    isSlash && filtered.length > 0 ? (
    <Box position="absolute" width="100%" height="100%" flexDirection="column" justifyContent="flex-end" alignItems={store.hero ? 'flex-start' : undefined} paddingLeft={heroPaletteLeft} paddingBottom={lift}>
      <Box borderStyle="round" borderColor={theme.border} flexDirection="column" width={store.hero ? heroComposerWidth(store.width) : undefined}>
        {filtered.map((c, i) => {
          const line = `/${c.name} — ${c.hint}`
          // Ink Box has NO background, so a Box paddingX would leave the
          // transcript visible through the 2-char left/right margin. The
          // whole row is instead ONE bg-colored Text that paints its own
          // opaque 2-char margin on each side and fills the rest — the
          // popup completely hides what is behind it. The row spans exactly
          // the popup's INNER width (its own width minus the round border's 2
          // cols; it has no paddingX), so short rows never truncate to "…":
          //  - docked: the popup stretches inside the message column's padded
          //    overlay → inner = usable − 2;
          //  - HERO: the popup is the narrow centered CARD width (the overlay
          //    is the hero area), so its inner width follows heroComposerWidth
          //    — sizing rows by the message-column width there made every row
          //    overflow and Ink appended "…" to all of them.
          const contentW = Math.max(20, store.hero ? heroComposerWidth(store.width) - 2 : usable - 2)
          const lead = '  '
          const trail = '  '
          const fill = Math.max(1, contentW - visualWidth(line) - visualWidth(lead) - visualWidth(trail))
          return (
            <Text key={c.name} color={i === effectiveIndex ? theme.accent : undefined} inverse={i === effectiveIndex} backgroundColor={theme.bg} wrap="truncate">
              {lead}{line}{' '.repeat(fill)}{trail}
            </Text>
          )
        })}
      </Box>
    </Box>
  ) : null

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
      {/* Middle row: a left column (message area on top, composer pinned to its
          bottom) plus — when the Steps sidebar is visible — the sidebar as a
          full-height right sibling, so its bottom border lands on the SAME row
          as the composer's bottom border. */}
      <Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="row" width="100%">
        <Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column">
          {
        heroActive ? (
        <Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column" paddingX={1} paddingY={1}>
          <Box flexShrink={0} height={hero?.topSpacer ?? 0} />
          {heroMark === 'blocks' ? (
            <Box flexDirection="column" flexShrink={0}>
              {HERO_ART_ROWS_CELLS.map((line, i) => {
                // Center by MEASURED width: the art glyphs are
                // East-Asian-Ambiguous, so their column count comes from the
                // charwidth calibration rather than from a static table.
                const artWidth = line.reduce((sum, cell) => sum + visualWidth(cell.ch), 0)
                const pad = ' '.repeat(Math.max(0, Math.floor((heroUsable - artWidth) / 2)))
                return (
                  <Text key={`art-${i}`} wrap="truncate">
                    {pad}
                    {line.map((cell, c) => (
                      <Text
                        key={`art-${i}-${c}`}
                        color={cell.fg >= 0 ? heroArtInk[cell.fg] : undefined}
                        backgroundColor={cell.bg >= 0 ? heroArtInk[cell.bg] : undefined}
                      >{cell.ch}</Text>
                    ))}
                  </Text>
                )
              })}
            </Box>
          ) : null}
          {heroMark === 'ascii' ? (
            <Box flexDirection="column" flexShrink={0}>
              {HERO_WORDMARK.map((line, i) => (
                <Text key={`wm-${i}`} color={theme.accent} bold wrap="truncate">{centerInHero(line)}</Text>
              ))}
            </Box>
          ) : null}
          {/* Version caption: PLAIN (no accent color / no emphasis) — it reads as
              a neutral label under the brand art instead of competing with it. */}
          <Text wrap="truncate">{centerInHero(heroTitleLine)}</Text>
          <Box flexShrink={0} height={HERO_TITLE_CARD_GAP} />
          {/* The hero card is a CENTERED, NARROW column (web parity), not the
              full window: the wrapper centers it and pins the exact width the
              composer's own wrap/height/caret math already assumed
              (composerOuterWidth → heroComposerWidth while the hero is up). */}
          <Box flexDirection="row" flexShrink={0} width="100%" paddingLeft={heroCardPad}>
            <Box flexDirection="column" width={heroComposerWidth(width)}>{composerNode}</Box>
          </Box>
          {store.olderLoading ? <Box flexShrink={0} height={1} /> : null}
          {store.olderLoading
            ? <Text color={theme.accent} wrap="truncate">{centerInHero(store.historyProgressText)}</Text>
            : null}
          <Box flexShrink={0} height={hero?.bottomSpacer ?? 0} />
          {renderPalette(hero?.paletteBottomMargin ?? 0)}
        </Box>
        ) : (
          <>
<Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          {items.length === 0
            ? <Text color={mutedReadable()}>Start typing to begin a session. Type <Text color={theme.primary}>/</Text> for commands.</Text>
            : (
              <Box flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden" flexDirection="column">
                <Box marginTop={-shift} flexDirection="column">
                  {rows.slice(first, last + 1).map((r) => renderRow(r))}
                </Box>
              </Box>
            )}
          {/* The approval dock and the QUESTION dock both live IN-FLOW inside
              the message column, right under the transcript: the open one
              takes real layout height and pushes the message history above it
              upward (the transcript Box up there is flexGrow with minHeight 0,
              so it shrinks by exactly the dock's height). The question dock
              therefore never paints over transcript text — no opaque backdrop
              needed — its width tracks the message box, and its real height
              (reported every frame as store.questionRows) matches the
              questionH the viewport math reserved above. Typing in the dock's
              inline "Other" editor grows the dock row by row until its ≤5-row
              input window caps it; beyond that the text scrolls inside the
              input window and the transcript stops moving. */}
          {overlay('approval')}
          {overlay('question')}
          {/* Command palette as a bottom-anchored ABSOLUTE overlay inside the
              message column: it takes no layout height, so the transcript keeps
              its full viewport (no compression) and the palette floats just
              above the composer. Each row is opaque (theme.bg) so the
              underlying transcript text never shows through between rows. */}
          {renderPalette(0)}
        </Box>
        {/* The composer is pinned to the bottom of the message column and spans
            its full width: with the Steps sidebar visible its right border sits
            flush against the sidebar's left edge and input wraps before it. */}
        
        {composerNode}
        
          </>
        )}
        </Box>
        {showSidebar && (
        <Box borderStyle="round" borderColor={theme.border} width={sidebarWidth} flexShrink={0} minHeight={0} flexDirection="column" paddingX={1} paddingTop={1} gap={1}>
          <Text color={theme.accent} bold>Steps {stepsTotal > 0 ? `${stepsDone}/${stepsTotal}` : ''}</Text>
          {steps.length === 0
            ? <Text color={mutedReadable()}>no plan yet</Text>
            : <StepRows steps={steps} />}
          {/* Right-sidebar session block: heading styled like the sibling
              "Steps" heading, the session display title (user rename wins
              over the auto title) directly under it in the REGULAR font and
              truncated, then the FULL session id in the message-box Think-row
              color (mutedReadable, non-bold) WRAPPED so the whole id is shown
              across however many rows it needs. The three rows sit flush (no
              gap) inside this inner column; the outer sidebar gap still
              separates the block from the Steps list and the footer. An
              untitled session keeps the heading + id rows (no title row). */}
          <Box flexDirection="column">
            <Text color={theme.accent} bold>Session</Text>
            {store.session !== undefined && (() => {
              const title = sessionDisplayTitle(store.session.id)
              return title === undefined ? null : <Text color={theme.text} wrap="truncate">{stripTerminalControls(title)}</Text>
            })()}
            {store.session !== undefined
              ? <Text color={mutedReadable()} wrap="wrap">{String(store.session.id)}</Text>
              : null}
          </Box>
          <Box flexGrow={1} />
          {/* Sidebar footer: the two version lines (harness above dsh-tui) and
              the workspace path form ONE flush 3-row column (gap 0) hugging
              the sidebar's bottom edge (no bottom padding under it) — the two
              version lines sit one row lower than the older layout, directly
              on the path (the blank row that used to separate group from path
              now sits above the group, absorbed by the flexible spacer).
              Labels use the regular font; the version numbers use the same
              message-box Think color as the composer's reasoning-effort chip
              ("High"), WITHOUT bold — matching its muted weight exactly. */}
          <Box flexDirection="column">
            <Text color={theme.text}>deepseek-harness: <Text color={mutedReadable()}>{HARNESS_VERSION}</Text></Text>
            <Text color={theme.text}>dsh-tui: <Text color={mutedReadable()}>{APP_VERSION}{BETA_FOOTER_SUFFIX}</Text></Text>
            <Text color={theme.text} wrap="truncate">{store.workspace}</Text>
          </Box>
        </Box>
        )}
      </Box>

      {/* Hero (blank session) is CHROME-FREE: the status bar is not drawn at
          all, so the centered hero stack owns the whole window height (the
          layout mirror below reserves no status rows either). */}
      {!heroActive && (
      <Box flexShrink={0} flexDirection="row" borderStyle="round" borderColor={theme.border} paddingX={1} height={STATUS_BAR_HEIGHT}>
        {noteStatusBranch(store)}
        {/* The busy indicator (Working/Paused/Idle + icon) is REPLACED on the
            left while a transient status message (e.g. "copied: …") flashes —
            so the confirmation takes the Idle slot for ~2.5s, then Idle returns.
            NOT a transcript row, so it cannot re-layout the transcript or slide
            the selection highlight. */}
        {/* While the resumed session's OLDER history is still folding, the
            left slot carries its real progress bar + counts: that fold is the
            one long phase of a switch whose numbers exist, and it runs while
            the transcript is already usable — so it belongs here (always
            visible, never blocks input) rather than in a modal. The transcript
            marker keeps the same text for anyone scrolled to the top. */}
        {store.sessionLoading !== null
          ? <Text color={theme.accent} wrap="truncate">{sessionLoadingStatusText(store.sessionLoading, Date.now(), store.sessionLoadingTicked)}</Text>
          : store.compaction !== null
            // A manual `/compact` outranks the fold progress: it is the action
            // the user just took, and it runs while the transcript is otherwise
            // usable (Esc cancels it).
            ? <Text color={theme.accent} wrap="truncate">{compactionStatusText(store.compaction, Date.now(), store.compactionTicked)}</Text>
            : store.preparingRequest
              // The harness assembles this step's request on this thread right
              // after `step/start` (4-6 s on a giant session, `[stall]` in the
              // log): the frame carrying this label is flushed BEFORE that block,
              // so the clock stays hidden until a tick proves the loop is free.
              ? <Text color={theme.accent} wrap="truncate">{preparingRequestStatusText(store.preparingRequestStartedAt, Date.now(), store.preparingRequestTicked)}</Text>
              : store.historyLoadingVisible
            ? <Text color={theme.accent} wrap="truncate">{store.historyProgressText}</Text>
            : store.statusFlash
              ? <Text color={theme.success} wrap="truncate">{store.statusFlash.text}</Text>
              : store.loadError !== null
                // A failed load stays visible until the next attempt / `/clear`:
                // the user must be able to read why the session did not open.
                ? <Text color={theme.error} wrap="truncate">{store.loadError}</Text>
                : <BusyIndicator animate={store.running} paused={store.paused} />}
        {/* The steps/turns · tokens stats are pinned to the RIGHT edge of the
            status bar regardless of the busy indicator's width: an explicit
            flex spacer pushes the stats group flush right, and the group
            truncates instead of wrapping if the terminal is narrow. */}
        <Box flexGrow={1} />
        {statsParts.length > 0 && (
          <Box flexShrink={0}>
            {/* Two-tone stat text: the NUMBERS use the regular text color,
                while their labels ("steps", "turns", "tok in", "tok out") and
                the separators stay in the muted message-Think color — same as
                the composer's reasoning-effort chip — so the figures read as
                plain data next to the busy indicator. */}
            <Text wrap="truncate">
              {/* Oversized session: the numbers cover the LOADED window only
                  (the full pass is skipped on purpose) — the marker leads the
                  group, so right-edge truncation drops digits, never the caveat. */}
              {store.statsWindowOnly
                ? <Text color={mutedReadable()}>{statsParts.length > 0 ? 'window · ' : 'stats: window-only'}</Text>
                : null}
              {statsParts.map((part, i) => (
                <Text key={i} color={part.kind === 'value' ? theme.text : mutedReadable()}>{part.text}</Text>
              ))}
            </Text>
          </Box>
        )}
      </Box>
      )}
    </Box>
  )
}

/** Install the per-frame suffix hook the patched Ink frame writer appends to
 *  every full-screen frame: it re-shows the REAL terminal cursor and parks it
 *  at the composer caret (the macOS IME candidate window anchors to it). The
 *  connect dialog hides the cursor instead (its input is masked dots).
 *
 *  Cursor SHAPE is set here too: terminals differ in their default cursor
 *  (Ubuntu/GNOME shows a block, Windows Terminal shows a bar), and the surface
 *  exposes the hardware cursor at the composer caret, so the shape would
 *  otherwise follow the emulator. Emit DECSCUSR steady-block (`CSI 2 SP q`) so
 *  every terminal shows the same block caret; the exit handler restores the
 *  terminal default (`CSI 0 SP q`). */
export function installFrameSuffix(): void {
  try {
    if (process.stdout.isTTY) process.stdout.write('\x1b[2 q')
  } catch { /* best-effort */ }
  const frameSuffix = (): string => {
    // Park the REAL cursor where the text caret is so IME composition/candidate
    // windows (macOS/Linux/Win) anchor near the text being typed:
    //  - conversation panel → the composer caret;
    //  - question dock with its inline "Other" editor open → that editor's
    //    caret cell (reported by the question panel through a global hook) so
    //    Chinese/other IME candidate windows anchor next to what you type.
    // Any other panel (/sessions, /models, /theme, /help, /export, connect)
    // draws its own caret and hides the hardware cursor instead — re-showing it
    // there would park it on a list row and look like a stray cursor jumping.
    if (store.panel !== 'conversation') {
      if (store.panel === 'question') {
        // The question panel draws its own caret as an in-band inverse block
        // ("the real terminal cursor is hidden inside the overlay"). We still
        // MOVE the hardware cursor to that cell but keep it HIDDEN, so IME
        // composition/candidate windows (e.g. Chinese) anchor next to the typed
        // text while the visible cursor stays the stable inverse block. Showing
        // the hardware cursor here instead (?25h) flickered over the inverse
        // block and blinked out when the measured cell momentarily went null.
        const host = globalThis as { __dshTuiQuestionCaretCell?: (() => { row: number; col: number } | null) | null }
        const qcell = host.__dshTuiQuestionCaretCell?.() ?? null
        if (qcell !== null) return `\x1b[${qcell.row};${qcell.col}H\x1b[?25l`
      }
      return '\x1b[?25l'
    }
    const cell = composerCaretCell()
    // The hero's command palette is lifted ONTO the card, so it covers the
    // input row: keep the cursor parked at the caret cell (IME anchoring) but
    // HIDDEN, otherwise the block caret blinks through the popup's text. In
    // the docked phase the palette floats ABOVE the card and the caret stays
    // visible in the draft, so nothing changes there.
    if (commandPaletteOpen && store.hero) {
      return `\x1b[?25l${cell === null ? '' : `\x1b[${cell.row};${cell.col}H`}`
    }
    // A session switch paints a centered banner over everything: the composer
    // caret belongs to the session being replaced, so keep the cursor hidden
    // until the new session owns the screen.
    if (store.sessionLoading !== null) return '\x1b[?25l'
    return `\x1b[?25h\x1b[2 q${cell === null ? '' : `\x1b[${cell.row};${cell.col}H`}`
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
    const showSidebar = sidebarVisibleFor(width)
    const usable = convUsableWidth(width, showSidebar)
    const composerTop = composerBand(width, rows).top
    const y1 = Math.max(0, Math.min(sel.aRow, sel.cRow) - 1)
    // grid row of the status bar's first border row (hero draws none → the area
    // runs to the bottom of the window).
    const statusTopGrid = store.hero ? rows - 1 : rows - STATUS_BAR_HEIGHT - 1
    // A drag that ANCHORED on the Steps SIDEBAR selects sidebar text only: bound
    // the LINE/FLOW copy to the sidebar's own content band (grid columns), never
    // the message column text beside it. The sidebar is a bordered column whose
    // left border sits right after the message column's last col
    // (messageRight, 1-based) — its text starts two grid cells in (border +
    // padding) and ends two before the terminal edge.
    if (showSidebar && sel.aCol > width - sidebarWidthFor(width)) {
      const band = sidebarContentBand(width, width - sidebarWidthFor(width))
      const left = band.left
      const right = band.right
      if (left >= right) return null
      return {
        rect: { x1: left, y1, x2: right, y2: Math.max(y1, Math.min(statusTopGrid, Math.max(sel.aRow, sel.cRow) - 1)) },
        left,
        right,
      }
    }
    const y2 = Math.min(composerTop - 2, Math.max(sel.aRow, sel.cRow) - 1)
    if (y2 < y1) return null // selection sits entirely in the composer/status
    // LINE/FLOW selection is bounded by the message column's CONTENT column: the
    // left edge (paddingX + MESSAGE_LEFT_COLS) to the content right edge — exactly
    // the wrap column, BEFORE the Steps sidebar. `right` is handed to the frame
    // controller so the flow copy stops at the content edge and never sweeps in
    // a Steps row that happens to be on the same screen line.
    const left = 1 + MESSAGE_LEFT_COLS
    const right = Math.min(width - 2, left + MESSAGE_TEXT_WIDTH(usable) - 1)
    return { rect: { x1: left, y1, x2: right, y2 }, left, right }
  })
  tui.panels.register({
    id: 'conversation',
    mode: 'fullscreen',
    render: () => <ConversationMain tui={tui} />,
    handleKey: (k) => { conversationKey(k, tui); return true },
  })
  installFrameSuffix()
}
