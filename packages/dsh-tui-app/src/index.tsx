/**
 * @yourname/dsh-tui-app — a full-screen Ink/React terminal surface. The bundle
 * patch rides over dsh-base without an HTTP host or browser; this runtime
 * creates one Agent through the core registry, streams its session events into
 * an Ink transcript, and drives user input back in via `followup()` / `steer()`.
 *
 * Surface features (each owned here, none touching the harness core):
 *   - slash command palette (type `/`)
 *   - a `approval/request` answerer that prompts for tool approval in-band
 *   - launch auto-resume (`resume_last`) / `--resume <id>` over persisted sessions
 *   - an opencode-style two-panel layout (conversation + activity) and input dock
 *
 * @module @yourname/dsh-tui-app
 */

import { randomUUID } from 'node:crypto'
import { render, Box, Text } from 'ink'
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelection, ModelSelectionRef, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { ManualCompactionError, type CompactionResult, type ManualCompactAgentContext, type ManualCompactionErrorCode } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionOption,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { TUI_STARTUP_SERVICE } from './startup.ts'
import { TUI_MODELS_SERVICE, type AddProviderInput, type ModelsProviderOption, type ProviderTemplate, type TuiModelsService } from './models.ts'
import { reasoningEffortName, type TuiProviderTemplate } from './llm.ts'
import { emptySessionStats, foldSessionStats, type SessionStats } from './session-stats.ts'

import { readHiddenProviders, resolveResumeLast, setHiddenProviders } from './config.ts'
import { isPinned, prewarmTitles, rememberTitle, type SessionHeaderLike, type SessionTitlesPersistence } from './session-titles.ts'
import { lastActivity, touchSession } from './session-activity.ts'
import { theme, type ThemePalette } from './theme.ts'
import { StdinDecoder, type RawKey } from './stdin.ts'
import { initErrorLog, logError, logConsoleError } from './log.ts'
import pkg from '../../../package.json' with { type: 'json' }

/** Stable Cordis plugin name. */
export const name = 'tui-runtime'

/** Project version (single source of truth: the root package.json). */
export const APP_VERSION = (pkg as { version?: string }).version ?? '0.0.0'

/** Whether this build is a beta/preview: true when the version carries a
 *  prerelease tag (`0.2.2-beta.1`, `-rc`, `-alpha`, `-preview`) or
 *  `DSH_TUI_BETA=1` is set at launch. Release builds (plain semver) show no
 *  beta marker in the sidebar footer. */
export const IS_BETA_BUILD = /[-.]?(beta|rc|alpha|preview)[-.]?/i.test(APP_VERSION)
  || process.env.DSH_TUI_BETA?.trim() === '1'

/** Footer suffix appended ONLY when beta is forced by `DSH_TUI_BETA=1` on a
 *  plain (non-prerelease) version. A version that already spells it out
 *  (`0.2.2-beta`) shows as-is — no redundant " beta" word (GitHub semver
 *  convention). */
export const BETA_FOOTER_SUFFIX = process.env.DSH_TUI_BETA?.trim() === '1' ? ' beta' : ''

/** Core services required before the terminal session can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'tuiModels']

/** Plugin config: the invocation flags resolved from the injected provider service. */
export interface Config {
  workspace: string
  resume: string | undefined
  model: string | undefined
}

export const Config: z<Config> = z.object({
  workspace: z.string().required(),
  resume: z.string(),
  model: z.string(),
})

/** One rendered transcript line. */
export interface TranscriptItem {
  readonly key: number
  readonly kind: 'user' | 'assistant' | 'reasoning' | 'status' | 'tool'
  readonly text: string
  readonly dim?: boolean
}

/** A step in the model's plan (mirrors the harness `TodoItem`). */
export interface StepItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** One /models picker option: a provider route plus one of its models. */
export interface ModelsOption {
  /** Registered provider route. */
  provider: string
  /** Model id sent to the provider. */
  model: string
  /** Display label (`provider · model`). */
  label: string
  /** Reasoning-effort levels the model supports (when any): selecting it steps
   *  through an Effort dialog before the choice saves. Absent = direct save. */
  efforts?: readonly { id: string; name: string; description?: string }[]
  /** Effort preselected when no saved effort matches (route default). */
  defaultEffort?: string
}

/** One /models first-level entry: a configured provider with its model list. */
export interface ProviderModelsEntry {
  /** Registered provider route. */
  provider: string
  /** Human-readable provider name. */
  name: string
  /** The provider's model options (the second-level list). */
  models: readonly ModelsOption[]
}

// `todo/write` is typed in the harness by declaration merging from
// `@deepseek-ai/dsh-tool-todo`, whose types this package's typecheck does not
// load (tsconfig.typecheck.json maps only the @deepseek-ai/* packages the app
// imports). The event is emitted at runtime by the bundled tool-todo plugin;
// SessionEventMap is merge-extensible by design (see @deepseek-ai/dsh-session),
// so declare the merge here with the transcript's own step shape.
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'todo/write': { todos: StepItem[] }
  }
}

/** Session file-permission mode, cycled by Tab in the composer (matches the web surface). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export const SANDBOX_CYCLE: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']
const PERMISSION_LABEL: Record<SandboxMode, string> = {
  'read-only': 'Read Only',
  'workspace-write': 'Workspace Write',
  'danger-full-access': 'Full access · no approval',
}
/** Sandbox-mode → theme role; resolved LIVE (theme changes must repaint it). */
const PERMISSION_ROLE: Record<SandboxMode, keyof ThemePalette> = {
  'read-only': 'error',
  'workspace-write': 'warning',
  'danger-full-access': 'success',
}

/** A selectable persisted session for the /sessions dialog. */
export interface SessionSummary {
  readonly id: SessionId
  /** Plain display title (user rename wins over the auto title). */
  readonly title?: string
  readonly label: string
  readonly cwd?: string
  /** Creation timestamp (local epoch ms), used for time-grouped display. */
  readonly createdAt?: number
  /** /sessions dialog extras (harness list projection). */
  readonly running?: boolean
  readonly completed?: boolean
  readonly updatedAt?: number
}

/** An in-progress tool approval question awaiting the user's decision. */
export interface PendingApproval {
  readonly req: ApprovalRequest
  readonly resolve: (outcome: ApprovalOutcome) => void
}

/** An in-band user question (ask_user_question) awaiting the user's decision. */
export interface PendingQuestion {
  readonly item: AskUserQuestionItem
  readonly resolve: (answer: AskUserQuestionAnswerItem) => void
  readonly reject: (error: Error) => void
  index: number
  custom: string
  customMode: boolean
  /** Position within a multi-question ask (1-based) and the total, when > 1. */
  readonly position?: number
  readonly total?: number
}

/** A command in the slash palette. */
export interface CommandItem {
  readonly name: string
  readonly hint: string
  readonly run: (arg: string) => void
}

/** Mutable UI store the Ink app subscribes to. */
export class Store {
  private items: TranscriptItem[] = []
  private key = 0
  private version = 0
  private listeners = new Set<() => void>()
  private _input = ''
  private _cursor = 0
  private _panel: 'conversation' | 'approval' | 'connect' | 'question' | 'sessions' | 'export' | 'help' | 'themes' = 'conversation'
  private _commandFilter = ''
  private _commandIndex = 0
  private _approval: PendingApproval | null = null
  /** /sessions dialog state: full list, highlight, live filter, content-search hits. */
  private _sessionsDialog: readonly SessionSummary[] = []
  private _sessionsDialogIndex = 0
  private _sessionsFilter = ''
  private _sessionsSearch: readonly { id: string; snippet: string }[] = []
  /** Row index armed for deletion (Ctrl+D twice); `null` = not arming. */
  private _sessionsDeleting: number | null = null
  /** One-line in-dialog notice (guard message, delete result). */
  private _sessionsNotice = ''
  /** Row index being renamed (Ctrl+R); `null` = not renaming. */
  private _sessionsRenaming: number | null = null
  /** Rename input text (edited in the filter box while renaming). */
  private _sessionsRenameInput = ''
  /** /export dialog state: format / file name / sanitize fields. */
  private _exportField = 0
  private _exportFormat: 'json' | 'markdown' = 'json'
  private _exportName = ''
  private _exportNameEdited = false
  private _exportSanitize = false
  private _steps: StepItem[] = []
  private _secret = ''
  private _question: PendingQuestion | null = null
  private _width = process.stdout.columns ?? 80
  private _rows = process.stdout.rows ?? 24
  private _permission: SandboxMode = 'workspace-write'
  private _modelLabel = ''
  private _modelEffortName = ''
  private _session: Session | undefined
  private _workspace = ''
  private _running = false
  private _paused = false
  private _followTail = true
  private _scroll = 0
  private _layoutContent = 0
  private _layoutViewport = 0
  private _layoutScroll = 0
  private _layoutTopRow = 1
  private _selection: { aRow: number; aCol: number; cRow: number; cCol: number } | null = null
  private _selectionActive = false

  private _notifyScheduled = false
  private notify(): void {
    // Coalesce bursts of store updates (e.g. a tool run fires tens of session
    // events synchronously) into ONE render per microtask; firing listeners
    // synchronously per notify would nest 50+ React renders and trip React's
    // "Maximum update depth exceeded" guard. The version bump happens in the
    // SAME microtask as the listeners: a bump landing between a commit and its
    // passive-effect flush is observed by React's useSyncExternalStore
    // consistency check, which then force-re-renders DURING the flush and
    // trips the passive-nested-update guard ("Maximum update depth exceeded",
    // see dsh-tui.log) under sustained streaming.
    if (this._notifyScheduled) return
    this._notifyScheduled = true
    queueMicrotask(() => {
      this._notifyScheduled = false
      this.version += 1
      for (const listener of this.listeners) listener()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getVersion = (): number => this.version

  private _themeEpoch = 0
  /** Bumped on every theme (re)apply so memoized rows re-render with new colors. */
  get themeEpoch(): number { return this._themeEpoch }
  bumpTheme(): void { this._themeEpoch += 1; this.notify() }

  // ── action slots (injected by start(); panels call them through the store) ──
  /** Sent-message history (shared with the conversation panel's browse). */
  inputHistory: string[] = []
  /** Last Esc timestamp for the double-Esc pause window. */
  lastEscTime = 0
  /** Last model selection, for panel commands (e.g. /models initial index);
   *  `reasoningEffort` is the saved effort id when one was chosen. */
  currentModel: { provider: string; model: string; reasoningEffort?: string } = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  modelsSaveAction: (provider: string, model: string, effort?: string) => void = () => {}
  /** Cycle the current model's reasoning effort (Ctrl+T / Alt+T). */
  cycleEffort: () => void = () => {}
  /** Hide one provider from /models AND remove its API key (Ctrl+D / Alt+D on
   *  the first level); re-adding happens through "Add provider" + a new key. */
  deactivateProvider: (route: string, name: string) => void = () => {}
  openProviderList: () => void = () => {}
  keyDialogSubmit: (provider: string, name: string, key: string) => void = () => {}
  providerFormSubmit: (input: AddProviderInput) => void = () => {}
  submitMessage: (text: string) => void = () => {}
  cancelAction: () => void = () => {}
  pauseAgent: () => void = () => {}
  /** Start a brand-new session in place (injected by start(); the `/new`
   *  command calls it). The current session is cancelled, disposed, and left
   *  durably persisted by the harness, so it stays reachable from
   *  `/sessions` / `--resume` afterward. */
  newSessionAction: () => void = () => {}

  getItems(): readonly TranscriptItem[] { return this.items }
  get steps(): readonly StepItem[] { return this._steps }
  get stepsDone(): number { return this._steps.filter(s => s.status === 'completed').length }
  get stepsTotal(): number { return this._steps.length }
  get stepsActive(): boolean { return this._steps.length > 0 }
  setSteps(steps: StepItem[]): void { this._steps = steps; this.notify() }
  // ── bottom-bar session stats (web StatsLine subset) ──
  private _stats: SessionStats = emptySessionStats()
  private _turnSeen = new Set<number>()
  get stats(): SessionStats { return this._stats }
  /** Replace stats wholesale (durable-log fold on resume); turns assumed 0..n-1. */
  setStats(stats: SessionStats): void {
    this._stats = stats
    this._turnSeen = new Set(Array.from({ length: stats.turns }, (_, i) => i))
    this.notify()
  }
  /** Reset for a brand-new session. */
  resetStats(): void {
    this._stats = emptySessionStats()
    this._turnSeen.clear()
  }
  /** One assistant step settled: counts + LLM wall time + provider usage. */
  accrueMessage(turn: number, llmMs: number, usage?: { inputTokens?: number; outputTokens?: number }): void {
    this._turnSeen.add(turn)
    const current = this._stats
    this._stats = {
      turns: this._turnSeen.size,
      steps: current.steps + 1,
      llmMs: current.llmMs + Math.max(0, llmMs),
      toolMs: current.toolMs,
      inputTokens: current.inputTokens + (usage?.inputTokens ?? 0),
      outputTokens: current.outputTokens + (usage?.outputTokens ?? 0),
    }
    this.notify()
  }
  /** One tool result settled: add its wall time. */
  accrueTool(ms: number): void {
    if (ms <= 0) return
    const current = this._stats
    this._stats = { ...current, toolMs: current.toolMs + ms }
    this.notify()
  }
  get input(): string { return this._input }
  get panel() { return this._panel }
  get commandFilter() { return this._commandFilter }
  get commandIndex() { return this._commandIndex }
  get approval() { return this._approval }
  get sessionsDialog() { return this._sessionsDialog }
  get sessionsDialogIndex() { return this._sessionsDialogIndex }
  get sessionsFilter() { return this._sessionsFilter }
  get sessionsSearch() { return this._sessionsSearch }
  /** Row index armed for deletion (Ctrl+D twice), or `null`. */
  get sessionsDeleting() { return this._sessionsDeleting }
  /** One-line in-dialog notice (guard message, delete result). */
  get sessionsNotice() { return this._sessionsNotice }
  setSessionsNotice(text: string): void {
    if (this._sessionsNotice !== text) { this._sessionsNotice = text; this.notify() }
  }
  /** Arm (or disarm) the highlighted row for deletion confirmation. */
  armSessionsDelete(index: number | null): void {
    if (this._sessionsDeleting !== index) { this._sessionsDeleting = index; this.notify() }
  }
  cancelSessionsDelete(): void {
    if (this._sessionsDeleting !== null) { this._sessionsDeleting = null; this.notify() }
  }
  /** Row index being renamed (Ctrl+R), or `null`. */
  get sessionsRenaming() { return this._sessionsRenaming }
  /** Rename input text (edited in the filter box while renaming). */
  get sessionsRenameInput() { return this._sessionsRenameInput }
  /** Begin renaming the given row, prefilling its current display title. */
  startSessionsRename(index: number | null, prefill: string): void {
    this._sessionsRenaming = index
    this._sessionsRenameInput = prefill
    this.notify()
  }
  sessionsRenameType(char: string): void {
    this._sessionsRenameInput = (this._sessionsRenameInput + char).slice(0, 120)
    this.notify()
  }
  sessionsRenameBackspace(): void {
    this._sessionsRenameInput = this._sessionsRenameInput.slice(0, -1)
    this.notify()
  }
  cancelSessionsRename(): void {
    if (this._sessionsRenaming !== null) { this._sessionsRenaming = null; this._sessionsRenameInput = ''; this.notify() }
  }
  get exportField() { return this._exportField }
  get exportFormat() { return this._exportFormat }
  get exportName() { return this._exportName }
  get exportSanitize() { return this._exportSanitize }
  /** Open the /export dialog (format / file name / sanitize). */
  openExport(defaultName: string): void {
    this._exportField = 0
    this._exportFormat = 'json'
    this._exportName = defaultName
    this._exportNameEdited = false
    this._exportSanitize = false
    this._panel = 'export'
    this.notify()
  }
  exportFieldMove(delta: number): void {
    this._exportField = (this._exportField + delta + 3) % 3
    this.notify()
  }
  exportFormatToggle(): void {
    this._exportFormat = this._exportFormat === 'json' ? 'markdown' : 'json'
    this.notify()
  }
  exportSanitizeToggle(): void {
    this._exportSanitize = !this._exportSanitize
    this.notify()
  }
  exportNameType(char: string): void {
    // The first typed character REPLACES the prefilled default name; later
    // input appends.
    if (!this._exportNameEdited) {
      this._exportName = ''
      this._exportNameEdited = true
    }
    this._exportName = (this._exportName + char).slice(0, 120)
    this.notify()
  }
  exportNameBackspace(): void {
    this._exportNameEdited = true
    this._exportName = this._exportName.slice(0, -1)
    this.notify()
  }
  cancelExport(): void {
    if (this._panel === 'export') this._panel = 'conversation'
    this.notify()
  }
  /** Open the /help dialog. */
  openHelp(): void {
    this._panel = 'help'
    this.notify()
  }
  cancelHelp(): void {
    if (this._panel === 'help') this._panel = 'conversation'
    this.notify()
  }
  /** /sessions dialog rows filtered by the live filter (title/id/cwd match). */
  get sessionsFiltered(): readonly SessionSummary[] {
    const filter = this._sessionsFilter.trim().toLowerCase()
    const base = filter === ''
      ? this._sessionsDialog
      : this._sessionsDialog.filter((s) =>
        (s.label).toLowerCase().includes(filter)
        || String(s.id).toLowerCase().includes(filter)
        || (s.cwd ?? '').toLowerCase().includes(filter))
    // Pinned sessions sort to the top (stable: createdAt order within groups).
    return [...base].sort((a, b) => (isPinned(b.id) ? 1 : 0) - (isPinned(a.id) ? 1 : 0))
  }
  get secret() { return this._secret }

  append(kind: TranscriptItem['kind'], text: string, dim = kind === 'reasoning' || kind === 'status'): void {
    this.items = [...this.items, { key: this.key += 1, kind, text, dim }]
    this.notify()
  }

  /** Append a running tool-call row (opencode-style inline tool). */
  toolCall(name: string): void {
    this.items = [...this.items, { key: this.key += 1, kind: 'tool', text: `│ ${name}` }]
    this.notify()
  }

  /** Mark the most recent running tool row as completed. */
  toolResult(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]
      if (item.kind === 'tool') {
        this.items = [...this.items.slice(0, i), { ...item, text: `✓ ${item.text.slice(2)}` }, ...this.items.slice(i + 1)]
        break
      }
    }
    this.notify()
  }

  streamText(text: string): void {
    const tail = this.items.at(-1)
    if (tail?.kind === 'assistant') {
      this.items = [...this.items.slice(0, -1), { ...tail, text: tail.text + text }]
    } else {
      this.items = [...this.items, { key: this.key += 1, kind: 'assistant', text }]
    }
    this.notify()
  }

  /** Replace the (streamed) assistant item with the authoritative message text
   *  — the same source a resume replays. Streaming `text-delta` chunks can split
   *  a `\n\n` at a chunk boundary, leaving the live copy missing blank lines
   *  between a heading/label and the content above (looks flush live, but normal
   *  after resume). Settling on `assistant/message` makes live byte-identical to
   *  resume. Falls back to appending when there is no assistant item. */
  settleAssistantText(text: string): void {
    let idx = -1
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]?.kind === 'assistant') { idx = i; break }
    }
    if (idx === -1) {
      this.items = [...this.items, { key: this.key += 1, kind: 'assistant', text }]
      this.notify()
      return
    }
    if (this.items[idx]!.text === text) return
    const next = [...this.items]
    next[idx] = { ...next[idx]!, text }
    this.items = next
    this.notify()
  }

  /** Accumulate reasoning deltas into one `reasoning` block (a collapsed Think). */
  streamReasoning(text: string): void {
    const tail = this.items.at(-1)
    if (tail?.kind === 'reasoning') {
      this.items = [...this.items.slice(0, -1), { ...tail, text: tail.text + text }]
    } else {
      this.items = [...this.items, { key: this.key += 1, kind: 'reasoning', text }]
    }
    this.notify()
  }

  private _expandReasoning = false
  get expandReasoning(): boolean { return this._expandReasoning }
  toggleReasoning(): void { this._expandReasoning = !this._expandReasoning; this.notify() }

  clear(): void {
    this.items = []
    this._steps = []
    this.notify()
  }

  /** Replace the transcript with folded session history (resumed-session
   *  replay) and continue keying from the loaded items, so live appends never
   *  collide with replayed keys. */
  loadHistory(items: readonly TranscriptItem[], steps: readonly StepItem[]): void {
    this.items = [...items]
    this.key = items.length
    this._steps = [...steps]
    this.notify()
  }

  setInput(value: string): void {
    this._input = value
    if (this._cursor > value.length) this._cursor = value.length
    this.notify()
  }
  get cursor(): number { return this._cursor }
  setCursor(index: number): void {
    this._cursor = Math.max(0, Math.min(this._input.length, index))
    this.notify()
  }
  moveCursorLeft(): void { this.setCursor(this._cursor - 1) }
  moveCursorRight(): void { this.setCursor(this._cursor + 1) }
  moveCursorUp(): void {
    const col = this._cursor - this._lineStart(this._cursor)
    const start = this._lineStart(this._cursor)
    if (start === 0) { this.setCursor(0); return }
    const prevEnd = start - 1 // index of '\n' ending the previous line
    const prevStart = this._lineStart(prevEnd)
    this.setCursor(prevStart + Math.min(col, prevEnd - prevStart))
  }
  moveCursorDown(): void {
    const start = this._lineStart(this._cursor)
    const end = this._lineEnd(this._cursor)
    if (end >= this._input.length) { this.setCursor(this._input.length); return }
    const nextStart = end + 1 // after the '\n'
    const nextEnd = this._lineEnd(nextStart)
    const col = this._cursor - start
    this.setCursor(nextStart + Math.min(col, nextEnd - nextStart))
  }
  insertAtCursor(text: string): void {
    this._input = this._input.slice(0, this._cursor) + text + this._input.slice(this._cursor)
    this._cursor += text.length
    this.notify()
  }
  backspaceAtCursor(): void {
    if (this._cursor <= 0) return
    this._input = this._input.slice(0, this._cursor - 1) + this._input.slice(this._cursor)
    this._cursor -= 1
    this.notify()
  }
  /** Delete the character at the cursor (the Delete key, not Backspace), so it
   *  removes the char AFTER the caret. Deletes a full code point to never split
   *  a surrogate pair (emoji). */
  deleteForward(): void {
    if (this._cursor >= this._input.length) return
    const cp = this._input.codePointAt(this._cursor)
    const len = cp !== undefined && cp > 0xffff ? 2 : 1
    this._input = this._input.slice(0, this._cursor) + this._input.slice(this._cursor + len)
    this.notify()
  }
  deleteToLineStart(): void {
    const start = this._lineStart(this._cursor)
    if (start === 0) {
      if (start === this._cursor) return
      this._input = this._input.slice(this._cursor)
      this._cursor = 0
    } else {
      // Delete the newline plus line-start..cursor, then land on the previous
      // line's end (joining the current line up into it).
      this._input = this._input.slice(0, start - 1) + this._input.slice(this._cursor)
      this._cursor = start - 1
    }
    this.notify()
  }
  private _lineStart(index: number): number {
    const newline = this._input.lastIndexOf('\n', index - 1)
    return newline + 1
  }
  private _lineEnd(index: number): number {
    const newline = this._input.indexOf('\n', index)
    return newline === -1 ? this._input.length : newline
  }
  setPanel(panel: Store['_panel']): void { this._panel = panel; this.notify() }
  setCommandFilter(value: string): void { this._commandFilter = value; this._commandIndex = 0; this.notify() }
  setCommandIndex(index: number): void { this._commandIndex = index; this.notify() }

  setApproval(approval: PendingApproval | null): void {
    this._approval = approval
    if (approval) this._approvalChoice = 2 // default: Allow once
    if (approval) this._panel = 'approval'
    else if (this._panel === 'approval') this._panel = 'conversation'
    this.notify()
  }
  /** Selected approval action (0=Deny, 1=Allow always, 2=Allow once); ←/→ cycle + Enter. */
  private _approvalChoice = 2
  get approvalChoice(): number { return this._approvalChoice }
  cycleApprovalChoice(delta: number): void {
    this._approvalChoice = (this._approvalChoice + delta + 3) % 3
    this.notify()
  }
  /** Tool names the user chose "Allow always" for this session (in-memory, opencode-style). */
  private _allowAlways = new Set<string>()
  /** Tools allowed without asking for the rest of this session. */
  get allowAlways(): readonly string[] { return [...this._allowAlways] }
  isAllowAlways(toolName: string): boolean { return this._allowAlways.has(toolName) }
  rememberAllowAlways(toolName: string): void { this._allowAlways.add(toolName); this.notify() }
  get question(): PendingQuestion | null { return this._question }
  setQuestion(q: PendingQuestion): void { this._question = q; this._questionScroll = 0; this._panel = 'question'; this.notify() }
  /** Question-detail scroll offset (long details such as plan reviews are
   *  shown in a bounded, PgUp/PgDn-scrollable window inside the dock). */
  private _questionScroll = 0
  get questionScroll(): number { return this._questionScroll }
  scrollQuestion(delta: number): void {
    this._questionScroll = Math.max(0, this._questionScroll + delta)
    this.notify()
  }
  clearQuestion(): void { this._question = null; if (this._panel === 'question') this._panel = 'conversation'; this.notify() }
  bumpQuestionIndex(delta: number): void {
    if (this._question === null) return
    const len = Math.max(1, (this._question.item.options?.length ?? 0) + 1) // +1 = the custom/"Other" row
    this._question.index = (this._question.index + delta + len) % len
    this.notify()
  }
  setQuestionCustom(value: string, mode: boolean): void {
    if (this._question === null) return
    this._question.custom = value
    this._question.customMode = mode
    this.notify()
  }
  get width(): number { return this._width }
  get rows(): number { return this._rows }
  /** Track the live terminal size; notifies when either dimension changed, so a
   *  height-only resize re-renders the layout (Ink only re-lays-out the width). */
  setSize(width: number, rows: number): void {
    if (width === this._width && rows === this._rows) return
    this._width = width
    this._rows = rows
    this.notify()
  }
  get permission(): SandboxMode { return this._permission }
  get permissionLabel(): string { return PERMISSION_LABEL[this._permission] }
  get permissionColor(): string { return theme[PERMISSION_ROLE[this._permission]] }
  cyclePermission(): SandboxMode {
    const i = SANDBOX_CYCLE.indexOf(this._permission)
    this._permission = SANDBOX_CYCLE[(i + 1) % SANDBOX_CYCLE.length] ?? 'workspace-write'
    this.notify()
    return this._permission
  }
  get modelLabel(): string { return this._modelLabel }
  /** The reasoning-effort display name shown in the composer label ('' when
   *  the current model has no effort chosen or supports none). The full
   *  `modelLabel` already embeds it as ` · <name>`; the composer renders the
   *  effort part separately (warning color, like opencode's variant chip). */
  get modelEffortName(): string { return this._modelEffortName }
  setModelLabel(label: string, effortName = ''): void { this._modelLabel = label; this._modelEffortName = effortName; this.notify() }
  get session(): Session | undefined { return this._session }
  setSession(session: Session): void { this._session = session }
  private _models: readonly ModelsOption[] = []
  private _modelIndex = 0
  private _providers: readonly ProviderModelsEntry[] = []
  /** Provider routes the user hid from the /models first-level list (Ctrl+D /
   *  Alt+D), persisted in `dsh-tui.json`; they stay reachable from the
   *  "Add provider" list, where the same key unhides them. */
  private _hiddenProviders = new Set<string>()
  private _providerIndex = 0
  private _providerFilter = '' // live type-to-filter for the first-level provider list
  private _modelScope = '' // provider route currently shown in the second level; '' = first level
  private _modelScopeName = ''
  private _modelFilter = '' // live type-to-filter text for the second-level model list
  private _providerListFilter = '' // live type-to-filter for the Add-provider list
  private _providerForm = false
  private _providerField = 0
  private _providerTemplates: readonly ProviderTemplate[] = []
  private _providerTemplate = 0
  private _providerValues: string[] = [] // route / display name / base URL / API key / model ids
  private _providerFormError = ''
  private _providerList = false
  private _providerListIndex = 0
  private _providerTotal = 0 // total known providers, for the ＋ Add provider row
  private _providerNames: readonly { provider: string; name: string; configured: boolean; needsBaseURL: boolean }[] = []
  private _keyDialog = false
  private _keyDialogProvider = ''
  private _keyDialogName = ''
  private _keyDialogConfigured = false
  private _dialogNotice = ''
  get models(): readonly ModelsOption[] { return this._models }
  get modelIndex(): number { return this._modelIndex }
  get providers(): readonly ProviderModelsEntry[] { return this._providers }
  /** Hidden provider routes (persisted); wired persistence hook in start(). */
  onHiddenProvidersChange: (routes: string[]) => void = () => {}
  get hiddenProviders(): readonly string[] { return [...this._hiddenProviders] }
  isProviderHidden(route: string): boolean { return this._hiddenProviders.has(route) }
  /** Seed the hidden set from the config file at startup. */
  seedHiddenProviders(routes: readonly string[]): void { this._hiddenProviders = new Set(routes) }
  /** Hide one provider from the first-level list (persisted); no-op when already hidden. */
  hideProvider(route: string): void {
    if (this._hiddenProviders.has(route)) return
    this._hiddenProviders.add(route)
    this._providers = this._providers.filter((p) => p.provider !== route)
    if (this._providerIndex >= this._providers.length) {
      this._providerIndex = Math.max(0, this._providers.length - 1)
    }
    this.onHiddenProvidersChange([...this._hiddenProviders])
    this.notify()
  }
  /** Unhide one provider (its first-level entry returns on the next dialog open). */
  unhideProvider(route: string): void {
    if (!this._hiddenProviders.delete(route)) return
    this.onHiddenProvidersChange([...this._hiddenProviders])
    this.notify()
  }
  get providerIndex(): number { return this._providerIndex }
  get providerFilter(): string { return this._providerFilter }
  /** First-level providers filtered by `providerFilter` (name match, case-insensitive). */
  get providerFiltered(): readonly ProviderModelsEntry[] {
    const filter = this._providerFilter.trim().toLowerCase()
    if (filter === '') return this._providers
    return this._providers.filter((p) => p.name.toLowerCase().includes(filter))
  }
  get modelScope(): string { return this._modelScope }
  get modelScopeName(): string { return this._modelScopeName }
  get modelFilter(): string { return this._modelFilter }
  /** The second-level model list filtered by the live `modelFilter` text
   *  (matches the display label or the model id, case-insensitive). */
  get modelFiltered(): readonly ModelsOption[] {
    const filter = this._modelFilter.trim().toLowerCase()
    if (filter === '') return this._models
    return this._models.filter((m) => m.label.toLowerCase().includes(filter) || m.model.toLowerCase().includes(filter))
  }
  get providerListFilter(): string { return this._providerListFilter }
  /** Add-provider list filtered by `providerListFilter` (name match, case-insensitive). */
  get providerListFiltered(): readonly { provider: string; name: string; configured: boolean; needsBaseURL: boolean }[] {
    const filter = this._providerListFilter.trim().toLowerCase()
    if (filter === '') return this._providerNames
    return this._providerNames.filter((p) => p.name.toLowerCase().includes(filter))
  }
  get dialogNotice(): string { return this._dialogNotice }
  /** Show a transient notice inside the /models dialog (e.g. no providers registered). */
  setDialogNotice(message: string): void {
    this._dialogNotice = message
    this.notify()
  }
  get providerForm(): boolean { return this._providerForm }
  get providerField(): number { return this._providerField }
  get providerTemplates(): readonly ProviderTemplate[] { return this._providerTemplates }
  /** Fill the add-provider template dropdown (merged core + plugin catalog). */
  setProviderTemplates(templates: readonly ProviderTemplate[]): void {
    this._providerTemplates = templates
    this.notify()
  }
  get providerTemplate(): number { return this._providerTemplate }
  get providerValues(): readonly string[] { return this._providerValues }
  get providerFormError(): string { return this._providerFormError }
  get providerList(): boolean { return this._providerList }
  get providerListIndex(): number { return this._providerListIndex }
  get providerNames(): readonly { provider: string; name: string; configured: boolean; needsBaseURL: boolean }[] { return this._providerNames }
  /** Total known providers (the Add-provider list size), shown after ＋ Add provider. */
  get providerTotal(): number { return this._providerTotal }
  setProviderTotal(count: number): void {
    if (this._providerTotal === count) return
    this._providerTotal = count
    this.notify()
  }
  get keyDialog(): boolean { return this._keyDialog }
  get keyDialogProvider(): string { return this._keyDialogProvider }
  get keyDialogName(): string { return this._keyDialogName }
  get keyDialogConfigured(): boolean { return this._keyDialogConfigured }
  /** Move the second-level (model) highlight by `delta` (wraps within the
   *  filtered model list). */
  bumpModelIndex(delta: number): void {
    const len = Math.max(1, this.modelFiltered.length)
    this._modelIndex = (this._modelIndex + delta + len) % len
    this.notify()
  }
  /** Append one character to the live model filter and jump to the first match. */
  modelFilterType(char: string): void {
    this._modelFilter = (this._modelFilter + char).slice(0, 64)
    this._modelIndex = 0
    this.notify()
  }
  /** Remove the last filter character and jump to the first match. */
  modelFilterBackspace(): void {
    this._modelFilter = this._modelFilter.slice(0, -1)
    this._modelIndex = 0
    this.notify()
  }
  /** Clear the live model filter (no-op when already empty). */
  clearModelFilter(): void {
    if (this._modelFilter === '') return
    this._modelFilter = ''
    this._modelIndex = 0
    this.notify()
  }
  /** Jump the second-level highlight to `target` (clamped to the filtered list). */
  moveModelIndex(target: number): void {
    const len = this.modelFiltered.length
    this._modelIndex = len === 0 ? 0 : Math.max(0, Math.min(target, len - 1))
    this.notify()
  }
  // ── third level: the reasoning-effort picker for one effort-capable model ──
  private _effortOpen = false
  private _effortIndex = 0
  /** Whether the Effort picker (third level) is showing. */
  get effortOpen(): boolean { return this._effortOpen }
  /** The highlighted model's reasoning-effort choices (its declared levels). */
  get effortChoices(): readonly { id: string; name: string; description?: string }[] {
    return this.modelFiltered[this._modelIndex]?.efforts ?? []
  }
  get effortIndex(): number { return this._effortIndex }
  /** The highlighted model's label (the Effort picker's subject line). */
  get effortLabel(): string { return this.modelFiltered[this._modelIndex]?.label ?? '' }
  /** Open the Effort picker for the highlighted model (no-op when the model
   *  declares no efforts). The model-list state is kept so Esc returns to it. */
  openEffort(): void {
    const option = this.modelFiltered[this._modelIndex]
    const choices = option?.efforts ?? []
    if (option === undefined || choices.length === 0) return
    let index = 0
    const saved = this.currentModel
    const preselected = saved.provider === option.provider && saved.model === option.model
      ? saved.reasoningEffort
      : undefined
    const preferred = preselected ?? option.defaultEffort ?? ''
    const hit = choices.findIndex((e) => e.id === preferred)
    if (hit >= 0) index = hit
    this._effortIndex = index
    this._effortOpen = true
    this.notify()
  }
  /** Back out of the Effort picker to the model list. */
  cancelEffort(): void {
    if (!this._effortOpen) return
    this._effortOpen = false
    this._effortIndex = 0
    this.notify()
  }
  /** Move the Effort highlight by `delta` (wraps within the choices). */
  bumpEffortIndex(delta: number): void {
    const len = Math.max(1, this.effortChoices.length)
    this._effortIndex = (this._effortIndex + delta + len) % len
    this.notify()
  }
  /** Move the first-level (provider) highlight by `delta` (wraps; while
   *  unfiltered the last two slots are the add-provider entries, filtered the
   *  list is just the matches). */
  bumpProviderIndex(delta: number): void {
    const filtered = this.providerFiltered.length < this._providers.length
    const len = filtered ? Math.max(1, this.providerFiltered.length) : this._providers.length + 2
    this._providerIndex = (this._providerIndex + delta + len) % len
    this.notify()
  }
  /** Jump the first-level highlight to `target` (clamped to the filtered list). */
  moveProviderIndex(target: number): void {
    const len = this.providerFiltered.length
    this._providerIndex = len === 0 ? 0 : Math.max(0, Math.min(target, len - 1))
    this.notify()
  }
  /** Append one character to the first-level provider filter. */
  providerFilterType(char: string): void {
    this._providerFilter = (this._providerFilter + char).slice(0, 64)
    this._providerIndex = 0
    this.notify()
  }
  /** Remove the last first-level filter character. */
  providerFilterBackspace(): void {
    this._providerFilter = this._providerFilter.slice(0, -1)
    this._providerIndex = 0
    this.notify()
  }
  /** Clear the first-level provider filter (no-op when already empty). */
  clearProviderFilter(): void {
    if (this._providerFilter === '') return
    this._providerFilter = ''
    this._providerIndex = 0
    this.notify()
  }
  /** Open the /models dialog at the provider list (first level). Hidden
   *  providers (see `hideProvider`) are dropped from the list; the highlight
   *  re-anchors on the initially-targeted provider when still visible. */
  openModels(providers: readonly ProviderModelsEntry[], initialIndex: number): void {
    this._secret = ''
    const target = providers[Math.max(0, Math.min(initialIndex, providers.length - 1))]?.provider
    const visible = providers.filter((p) => !this._hiddenProviders.has(p.provider))
    this._providers = visible
    const anchor = target === undefined ? 0 : visible.findIndex((p) => p.provider === target)
    this._providerIndex = anchor < 0 ? 0 : anchor
    this._providerFilter = ''
    this._modelScope = ''
    this._modelScopeName = ''
    this._modelFilter = ''
    this._providerListFilter = ''
    this._models = []
    this._modelIndex = 0
    this._providerForm = false
    this._providerField = 0
    this._providerValues = []
    this._providerList = false
    this._keyDialog = false
    this._dialogNotice = ''
    this._effortOpen = false
    this._effortIndex = 0
    this._panel = 'connect'
    this.notify()
  }
  /** Drill into one provider's model list (second level). */
  openProviderModels(entry: ProviderModelsEntry, initialIndex: number): void {
    this._secret = ''
    this._modelScope = entry.provider
    this._modelScopeName = entry.name
    this._modelFilter = ''
    this._models = entry.models
    this._modelIndex = entry.models.length === 0 ? 0 : Math.max(0, Math.min(initialIndex, entry.models.length - 1))
    this.notify()
  }
  /** Back out of the model list to the provider list. */
  cancelProviderModels(): void {
    this._modelScope = ''
    this._modelScopeName = ''
    this._modelFilter = ''
    this._models = []
    this._modelIndex = 0
    this.notify()
  }
  /** Show the registered-provider list (pick one to set or change its API key). */
  startProviderList(names: readonly { provider: string; name: string; configured: boolean; needsBaseURL: boolean }[]): void {
    this._providerList = true
    this._providerTotal = names.length
    this._providerListIndex = 0
    this._providerListFilter = ''
    this._providerNames = names
    this._dialogNotice = ''
    this.notify()
  }
  bumpProviderListIndex(delta: number): void {
    const len = Math.max(1, this.providerListFiltered.length)
    this._providerListIndex = (this._providerListIndex + delta + len) % len
    this.notify()
  }
  /** Jump the Add-provider highlight to `target` (clamped to the filtered list). */
  moveProviderListIndex(target: number): void {
    const len = this.providerListFiltered.length
    this._providerListIndex = len === 0 ? 0 : Math.max(0, Math.min(target, len - 1))
    this.notify()
  }
  /** Append one character to the Add-provider list filter. */
  providerListFilterType(char: string): void {
    this._providerListFilter = (this._providerListFilter + char).slice(0, 64)
    this._providerListIndex = 0
    this.notify()
  }
  /** Remove the last Add-provider filter character. */
  providerListFilterBackspace(): void {
    this._providerListFilter = this._providerListFilter.slice(0, -1)
    this._providerListIndex = 0
    this.notify()
  }
  /** Clear the Add-provider filter (no-op when already empty). */
  clearProviderListFilter(): void {
    if (this._providerListFilter === '') return
    this._providerListFilter = ''
    this._providerListIndex = 0
    this.notify()
  }
  /** Pick the highlighted provider: closes the list and returns the choice. */
  selectProviderList(): { provider: string; name: string; configured: boolean; needsBaseURL: boolean } | undefined {
    const picked = this.providerListFiltered[this._providerListIndex]
    this._providerList = false
    this._providerListFilter = ''
    this._modelIndex = 0 // back on a model option, so Enter saves (not re-opens the list)
    this.notify()
    return picked
  }
  cancelProviderList(): void {
    this._providerList = false
    this._providerListFilter = ''
    this.notify()
  }
  /** Open the API-key sub-dialog for one provider (masked input; Enter saves to its ref). */
  openKeyDialog(provider: string, name: string, configured: boolean): void {
    this._secret = ''
    this._keyDialog = true
    this._keyDialogProvider = provider
    this._keyDialogName = name
    this._keyDialogConfigured = configured
    this.notify()
  }
  cancelKeyDialog(): void {
    this._keyDialog = false
    this.notify()
  }
  /** Submit the key dialog: returns the provider and the typed key, then closes. */
  keyDialogDone(): { provider: string; name: string; key: string } | null {
    const provider = this._keyDialogProvider
    const name = this._keyDialogName
    const key = this._secret
    this._keyDialog = false
    this.notify()
    return { provider, name, key }
  }
  /** Cycle the add-provider template dropdown (last slot = Custom provider); re-applies its defaults. */
  bumpProviderTemplate(delta: number): void {
    const len = this._providerTemplates.length + 1
    this._providerTemplate = (this._providerTemplate + delta + len) % len
    this.applyProviderTemplateDefaults()
    this.notify()
  }
  /** Fill the template-derived fields (route/display name/base URL) from the highlighted template. */
  applyProviderTemplateDefaults(): void {
    const template = this._providerTemplates[this._providerTemplate]
    this._providerValues[0] = template?.id ?? ''
    this._providerValues[1] = template?.name ?? ''
    this._providerValues[2] = template?.baseURL ?? ''
  }
  /** Enter the add-provider form (from the picker's "＋ Add provider" entry). */
  startProviderForm(templates: readonly ProviderTemplate[]): void {
    this._providerForm = true
    this._providerField = 0
    this._providerTemplates = templates
    this._providerTemplate = 0
    this._providerValues = ['', '', '', '', '']
    this._providerFormError = ''
    this.notify()
  }
  /** Open the custom-provider form pre-filled from one Add-provider template
   *  (deployment-configured providers: the user supplies baseURL + API key).
   *  The dropdown was filled at startup via `setProviderTemplates`. */
  startProviderFormForTemplate(provider: string): void {
    const templates = this._providerTemplates
    const template = templates.find((t) => t.id === provider)
    if (template === undefined) { this.startProviderForm(templates); return }
    this._providerTemplates = templates
    this._providerTemplate = templates.findIndex((t) => t.id === provider)
    this._providerValues = [
      template.id,
      template.name,
      '',
      '',
      (template.models ?? []).map((model) => model.id).join(', '),
    ]
    this._providerField = 0
    this._providerFormError = ''
    this._providerForm = true
    this._panel = 'connect'
    this.notify()
  }
  /** Cancel the add-provider form back to the picker. */
  cancelProviderForm(): void {
    this._providerForm = false
    this._providerFormError = ''
    this.notify()
  }
  /** Re-show the form with an error message (a submit failed). */
  showProviderFormError(message: string): void {
    this._providerForm = true
    this._providerFormError = message
    this.notify()
  }
  providerFormType(char: string): void {
    if (this._providerField === 0) return // the template field is a dropdown: arrows only
    this._providerValues[this._providerField - 1] = (this._providerValues[this._providerField - 1] ?? '') + char
    this.notify()
  }
  providerFormBackspace(): void {
    if (this._providerField === 0) return
    const value = this._providerValues[this._providerField - 1] ?? ''
    this._providerValues[this._providerField - 1] = value.slice(0, -1)
    this.notify()
  }
  /** Advance to the next form field; true when the last field was just finished. */
  providerFormAdvance(): boolean {
    if (this._providerField === 0) this.applyProviderTemplateDefaults()
    if (this._providerField >= 5) return true
    this._providerField += 1
    this.notify()
    return false
  }
  /** Append a masked character to the in-progress secret. */
  pushSecret(char: string): void { this._secret += char; this.notify() }
  /** Remove the last secret character (backspace). */
  popSecret(): void { this._secret = this._secret.slice(0, -1); this.notify() }
  /** Close the /connect overlay without storing. */
  cancelConnect(): void { this._secret = ''; this._modelScope = ''; this._modelScopeName = ''; this._modelFilter = ''; this._providerFilter = ''; this._providerListFilter = ''; this._effortOpen = false; this._effortIndex = 0; if (this._panel === 'connect') this._panel = 'conversation'; this.notify() }
  /** Open the /sessions dialog over the full session list (highlight on the current). */
  openSessions(sessions: readonly SessionSummary[]): void {
    this._sessionsDialog = sessions
    this._sessionsDialogIndex = 0
    this._sessionsFilter = ''
    this._sessionsSearch = []
    this._panel = 'sessions'
    this.notify()
  }
  /** Refresh the /sessions dialog rows in place, keeping filter and highlight;
   *  opens the dialog when it is not already open (background title folding). */
  refreshSessionsDialog(sessions: readonly SessionSummary[]): void {
    this._sessionsDialog = sessions
    if (this._panel !== 'sessions') {
      this._sessionsDialogIndex = 0
      this._sessionsFilter = ''
      this._sessionsSearch = []
      this._panel = 'sessions'
    }
    this.notify()
  }
  bumpSessionsDialogIndex(delta: number): void {
    const len = this.sessionsFiltered.length + (this._sessionsFilter !== '' ? this._sessionsSearch.length : 0) + 1
    this._sessionsDialogIndex = (this._sessionsDialogIndex + delta + Math.max(1, len)) % Math.max(1, len)
    this.notify()
  }
  moveSessionsDialogIndex(target: number): void {
    const len = this.sessionsFiltered.length + (this._sessionsFilter !== '' ? this._sessionsSearch.length : 0) + 1
    this._sessionsDialogIndex = len === 0 ? 0 : Math.max(0, Math.min(target, len - 1))
    this.notify()
  }
  sessionsFilterType(char: string): void {
    this._sessionsFilter = (this._sessionsFilter + char).slice(0, 64)
    this._sessionsDialogIndex = 0
    this.notify()
  }
  sessionsFilterBackspace(): void {
    this._sessionsFilter = this._sessionsFilter.slice(0, -1)
    this._sessionsDialogIndex = 0
    this.notify()
  }
  clearSessionsFilter(): void {
    if (this._sessionsFilter === '') return
    this._sessionsFilter = ''
    this._sessionsSearch = []
    this._sessionsDialogIndex = 0
    this.notify()
  }
  setSessionsSearch(results: readonly { id: string; snippet: string }[]): void {
    this._sessionsSearch = results
    this.notify()
  }
  cancelSessions(): void {
    if (this._panel === 'sessions') this._panel = 'conversation'
    this.notify()
  }
  /** Pick one session from the /sessions dialog and close it. The runtime
   *  `resumeSessionAction` switches to that session in place (cancel current
   *  turn → resume the target → dispose the old agent → replay its history),
   *  exactly like the launch auto-resume. */
  resumeSession(id: string): void {
    this._panel = 'conversation'
    this.cancelSessionsDelete()
    this.cancelSessionsRename()
    this.setSessionsNotice('')
    this.notify()
    this.resumeSessionAction(id)
  }
  /** In-place switch to a persisted session (injected by start()). */
  resumeSessionAction: (id: string) => void = () => {}
  get workspace(): string { return this._workspace }
  setWorkspace(workspace: string): void { this._workspace = workspace; this.notify() }
  get running(): boolean { return this._running }
  setRunning(running: boolean): void {
    if (running === this._running) return
    this._running = running
    if (running) this._paused = false // resuming a turn clears the Stopped state
    this.notify()
  }
  get paused(): boolean { return this._paused }
  setPaused(paused: boolean): void { if (paused === this._paused) return; this._paused = paused; this.notify() }
  get followTail(): boolean { return this._followTail }
  get scroll(): number { return this._scroll }
  get layoutContent(): number { return this._layoutContent }
  get layoutViewport(): number { return this._layoutViewport }
  get layoutScroll(): number { return this._layoutScroll }
  get layoutTopRow(): number { return this._layoutTopRow }
  get selection(): { aRow: number; aCol: number; cRow: number; cCol: number } | null { return this._selection }
  get selectionActive(): boolean { return this._selectionActive }
  /** Record the rendered transcript layout (lines, viewport, effective scroll, first visible row). Derived cache for the mouse/scroll handlers; never notifies (avoid setState-in-render). */
  setLayout(content: number, viewport: number, scroll: number, topRow: number): void {
    if (content === this._layoutContent && viewport === this._layoutViewport && scroll === this._layoutScroll && topRow === this._layoutTopRow) return
    this._layoutContent = content
    this._layoutViewport = viewport
    this._layoutScroll = scroll
    this._layoutTopRow = topRow
  }
  /** Bump the version so subscribers re-render (e.g. after measuring an item height). */
  touch(): void {
    this.notify()
  }
  /** Begin a mouse selection at a terminal cell; clears any previous selection. */
  mousePress(row: number, col: number): void {
    this._selection = { aRow: row, aCol: col, cRow: row, cCol: col }
    this._selectionActive = true
    this.notify()
  }
  /** Move the current end of a mouse selection. */
  mouseDrag(row: number, col: number): void {
    if (!this._selectionActive || this._selection === null) return
    this._selection = { ...this._selection, cRow: row, cCol: col }
    this.notify()
  }
  /** Finish a mouse gesture: `drag` when moved (keeps the highlight), `click` otherwise (clears it). */
  mouseRelease(row: number, col: number): 'click' | 'drag' {
    if (this._selection === null || !this._selectionActive) return 'click'
    const s = this._selection
    this._selection = { ...s, cRow: row, cCol: col }
    this._selectionActive = false
    if (Math.abs(s.aRow - row) + Math.abs(s.aCol - col) > 2) return 'drag'
    this._selection = null
    return 'click'
  }
  clearSelection(): void {
    if (this._selection === null && !this._selectionActive) return
    this._selection = null
    this._selectionActive = false
    this.notify()
  }
  private _maxScroll(): number { return Math.max(0, this._layoutContent - this._layoutViewport) }
  scrollPage(dir: -1 | 1): void {
    const page = Math.max(1, this._layoutViewport)
    // While following the tail, _scroll is never kept in sync (the effective
    // scroll IS maxScroll), so a first PgUp would page from stale 0 and clamp
    // to the TOP of the transcript. Sync to the tail first: opencode's sticky
    // scroll pages up from the bottom edge, one viewport at a time.
    if (this._followTail) this._scroll = this._maxScroll()
    this._followTail = false
    this._scroll = Math.max(0, Math.min(this._scroll + dir * page, this._maxScroll()))
    this.notify()
  }
  /** Scroll the transcript by a small line delta (mouse wheel). */
  scrollLines(delta: number): void {
    if (this._followTail) this._scroll = this._maxScroll()
    this._followTail = false
    this._scroll = Math.max(0, Math.min(this._scroll + delta, this._maxScroll()))
    this.notify()
  }
  scrollTop(): void { this._followTail = false; this._scroll = 0; this.notify() }
  scrollBottom(): void { this._followTail = true; this._scroll = this._maxScroll(); this.notify() }
}

/** The single UI store; settled plugins and the Ink app share it. */
export const store = new Store()

/** The live session id, for claim-or-delegate on approval/question listeners. */
const sessionRef: { current?: SessionId } = {}

// ── the `tui` service: panel/command registration for plugins ──────────────

/** How a registered panel participates in the screen layout. */
export type TuiPanelMode = 'fullscreen' | 'overlay'

/** One registered panel: render + optional key handling. */
export interface TuiPanelDefinition {
  /** Panel id; matches `store.panel` when active (`conversation` is the main surface). */
  id: string
  /** Fullscreen replaces the whole tree; overlay renders inside the conversation. */
  mode: TuiPanelMode
  /** Render the panel from the current store state. */
  render(store: Store): React.ReactNode
  /** Consume one key while this panel is active; return true when handled. */
  handleKey?(key: RawKey, store: Store): boolean
}

/** The surface plugins consume: panels, slash commands, and notifications. */
export interface TuiService {
  panels: {
    register(def: TuiPanelDefinition): void
    byId(id: string): TuiPanelDefinition | undefined
  }
  commands: {
    register(cmd: CommandItem): void
    remove(name: string): void
    list(): readonly CommandItem[]
  }
  notify(message: string): void
}

const tuiPanels = new Map<string, TuiPanelDefinition>()
const tuiCommands: CommandItem[] = []

/** The tui service singleton (provided by apply() as `tui`). */
export const tui: TuiService = {
  panels: {
    register(def) { tuiPanels.set(def.id, def) },
    byId(id) { return tuiPanels.get(id) },
  },
  commands: {
    register(cmd) { tuiCommands.push(cmd) },
    remove(name) {
      const index = tuiCommands.findIndex((c) => c.name === name)
      if (index >= 0) tuiCommands.splice(index, 1)
    },
    list() { return tuiCommands },
  },
  notify(message) { store.append('status', message, true) },
}

/** The current agent's session id, set once the agent is created. */
interface TuiIo { exit(code: number): void }

function requestExit(io: TuiIo, code: number): void { void io.exit(code) }

/** Whether the DeepSeek API key is configured (env or the credentials store). */
async function apiKeyConfigured(ctx: Context): Promise<boolean> {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return true
  const credentials = ctx.get('credentials') as
    | { describe?: (ref: ReturnType<typeof credentialRef>) => Promise<{ configured: boolean }> }
    | undefined
  if (credentials?.describe === undefined) return false
  try {
    const info = await credentials.describe(credentialRef('DEEPSEEK_API_KEY'))
    return Boolean(info?.configured)
  } catch {
    return false
  }
}

/** Group the models service's providers into first-level entries (one per provider). */
function buildProviderEntries(providers: readonly ModelsProviderOption[]): ProviderModelsEntry[] {
  return providers.map((p) => ({
    provider: p.provider,
    name: p.name,
    models: p.models.map((m) => ({
      provider: p.provider,
      model: m.id,
      label: m.name,
      ...(m.efforts === undefined ? {} : { efforts: m.efforts }),
      ...(m.defaultEffort === undefined ? {} : { defaultEffort: m.defaultEffort }),
    })),
  }))
}

/** Map a provider model id to a friendly display name (display only). */
function modelDisplayName(model: string): string {
  const known: Record<string, string> = {
    'deepseek-v4-flash': 'DeepSeek V4 Flash',
    'deepseek-v4': 'DeepSeek V4',
    'deepseek-v4-pro': 'DeepSeek V4 Pro',
    'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash Vision Exp',
  }
  return known[model] ?? model
}

/** Map a provider route to a friendly display name (template name or the built-in). */
function providerDisplayName(provider: string, templates: readonly TuiProviderTemplate[]): string {
  if (provider === 'deepseek-official') return 'DeepSeek'
  return templates.find((t) => t.route === provider)?.name ?? provider
}

/** Heuristic: does this bash command modify the filesystem? (best-effort; the
 *  real fence for file tools is fs-sandbox, and OS-level denial needs a native
 *  sandbox that the single-file binary does not bundle.) */
function bashMutates(command: string): boolean {
  const c = command.trim()
  if (c === '') return false
  if (/(^|\s)(rm|mv|cp|mkdir|rmdir|touch|truncate|install|dd|ln)\b/.test(c)) return true
  if (/(^|\s)(echo|printf|tee|cat|sed|awk)\b[^|;]*[>»]/.test(c)) return true
  if (/(^|\s)sed\b[^|;]*-i\b/.test(c)) return true
  if (/(^|\s)(chmod|chown|chattr)\b/.test(c)) return true
  if (/(^|\s)git\b.*\b(add|commit|checkout|reset|clean|restore)\b/.test(c)) return true
  if (/(^|\s)(python3?|python|node|deno|bun|ruby|perl)\b.*(-c|-e|-w)\b/.test(c)) return true
  if (/(^|\s)(python3?|python|node|deno|bun|ruby|perl)\b.*[>»]/.test(c)) return true
  if (/[^|;]*(>|»|>>)[^|;]*/.test(c)) return true
  return false
}

/**
 * Mount one long-lived terminal session: create or resume an agent, bind the
 * event stream to the transcript, register the approval answerer, and wire the
 * input handler to follow up.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param config - the resolved invocation flags.
 */
/** Dispatch one decoded key to the active panel's handler (or the conversation
 *  panel). This replaces Ink's `useInput` (whose parser swallows Alt+Enter/
 *  Home/End and appends SGR mouse bytes as literal text). */
function handleKey(k: RawKey): void {
  const def = tui.panels.byId(store.panel) ?? tui.panels.byId('conversation')
  def?.handleKey?.(k, store)
}

/** Captures render-phase errors from the panel tree (e.g. a layout computation
 *  throwing on unexpected data). React treats such errors as recoverable and
 *  prints them in ways that bypass the log hooks (bun writes to fd 2 natively;
 *  Ink drops 'The above error occurred' frames), so the boundary is what puts
 *  them into `~/.dsh/dsh-tui.log` via `logError('render', ...)`. */
class RenderErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  componentDidCatch(error: Error): void {
    try {
      logError('render', error)
    } catch {
      // best-effort: never throw from the error boundary
    }
  }
  render(): React.ReactNode {
    if (this.state.error !== null) {
      return <Text color={theme.error}>⚠ render error: {this.state.error.message}</Text>
    }
    return this.props.children
  }
}

/** The terminal-owning app: renders the active fullscreen panel, or the
 *  conversation surface (which embeds its overlay panels). */
export function App(): React.JSX.Element {
  const [, forceRender] = React.useReducer((c: number) => c + 1, 0)
  React.useEffect(() => store.subscribe(() => forceRender()), [])
  const active = tui.panels.byId(store.panel)
  // Fullscreen panels replace the tree; overlay panels render inside the
  // conversation surface, which embeds them (see the overlay() slots).
  const def = active !== undefined && active.mode === 'fullscreen' ? active : tui.panels.byId('conversation')
  if (def === undefined) return <></>
  return <RenderErrorBoundary>{def.render(store)}</RenderErrorBoundary>
}

/** The /help dialog: points at the ctrl+p command palette (Esc closes). */
function HelpDialog(): React.JSX.Element {
  return (
    <Box flexDirection="column" height={store.rows} alignItems="center" justifyContent="center">
      <Box position="absolute" width="100%" height={store.rows} flexDirection="column">
        <Text backgroundColor={theme.bg} wrap="wrap">{' '.repeat(Math.max(0, store.width * store.rows))}</Text>
      </Box>
      <Box width={72} borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1} paddingY={1}>
        <Text color={theme.accent} bold>Help</Text>
        <Box marginTop={1}>
          <Text>Press ctrl+p to see all available actions and commands in any context.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Esc close</Text>
        </Box>
      </Box>
    </Box>
  )
}

export function apply(ctx: Context, config: Config): void {
  // Surface services for this plugin tree and every panel plugin: the store
  // (UI state) and the `tui` aggregate (panel/command registration, notify).
  ctx.provide('tuiStore', store)
  ctx.provide('tui', tui)
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runtime: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = { exit }

  // Error log: crash / unhandled errors and React/Ink warnings land in
  // `~/.dsh/dsh-tui.log` (and stderr). Best-effort; never throws.
  initErrorLog()
  process.on('uncaughtException', (error) => {
    logError('uncaughtException', error)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', reason)
  })
  // Capture console.error (React/Ink warnings such as "Maximum update depth
  // exceeded") into the log; install before render. Avoid recursion (we never
  // call console.error from the logger).
  const originalConsoleError = console.error
  console.error = (...args: unknown[]): void => {
    try {
      logConsoleError(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(' '))
    } catch {
      // ignore
    }
    originalConsoleError.apply(console, args)
  }

  // Ask the model to ask the human for user-owned decisions (e.g. which
  // programming language), rather than silently picking a default.
  ctx.get('systemPrompt')?.section({
    name: 'user-chosen-decisions',
    order: -50,
    text: 'When a task can proceed under more than one user-owned choice (such as the programming language, test framework, or output format), call ask_user_question with the options and use the answer the human picks. Do not silently pick a default for a decision the user would prefer to make. Prefer to ask for genuinely user-owned choices; do not ask for facts you can discover yourself.',
  })

  // Answer the model's ask_user_question in-band: the current harness routes
  // the request through the 'user-questions/request' waterfall (see
  // @deepseek-ai/dsh-user-questions), which a UI claims by returning the
  // answer — the same claim-or-delegate pattern as the approval answerer
  // above. Questions aimed at another agent are delegated down the chain.
  ctx.on('user-questions/request', (request, next) => {
    if (sessionRef.current === undefined
      || (request.agent !== undefined && request.agent.session.id !== sessionRef.current)) {
      return next()
    }
    return askUser(request)
  })

  // Register the approval answerer: claim questions for our agent and block on
  // the in-band dialog; delegate every other agent to the rest of the chain.
  ctx.on('approval/request', async (req, next) => {
    if (sessionRef.current === undefined || req.agent.session.id !== sessionRef.current) return next()
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await new Promise<ApprovalOutcome>((resolve) => {
      // opencode-style "allow always": a tool the user approved with `a` this
      // session is auto-allowed without prompting again.
      if (req.toolName !== undefined && store.isAllowAlways(req.toolName)) {
        store.append('status', `approval: ${req.toolName} auto-allowed (allow always)`, true)
        resolve('allowed-once')
        return
      }
      store.setApproval({ req, resolve })
      if (req.signal) {
        req.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
        timer = setTimeout(() => resolve('cancelled'), 5 * 60_000)
      }
    })
    if (timer !== undefined) clearTimeout(timer)
    store.setApproval(null)
    return result
  })

  // File-permission enforcement for bash: fs tools are already fenced by the
  // (pure-JS) fs-sandbox row. Bash bypasses those tools, so in `read-only` we
  // deny commands that would modify the filesystem, carrying the `[sandbox: …]`
  // marker the model surfaces for a `sandbox_permissions` escalation (which
  // routes to the approval answerer above).
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (store.permission !== 'read-only') return next()
    const name = (exec as { name?: unknown }).name
    const args = (exec as { args?: unknown }).args
    const command = String(typeof args === 'string' ? args : typeof args === 'object' && args !== null ? (args as Record<string, unknown>).command ?? '' : '')
    if (typeof name === 'string' && (name === 'bash' || name === 'pwsh' || name.includes('bash')) && bashMutates(command)) {
      return { kind: 'deny', reason: '[sandbox: file access denied under read-only mode]' }
    }
    return next()
  })

  void start(ctx, config, io).catch((error: unknown) => {
    logError('start', error)
    store.append('status', `TUI load failure: ${error instanceof Error ? error.message : String(error)}`, false)
    requestExit(io, 1)
  })
}


/** The async session lifetime, started from `apply` and owned by this plugin. */
async function start(ctx: Context, config: Config, io: TuiIo): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  const agentOptions = config.model === undefined
    ? { provider: selection.provider, model: selection.model }
    : { provider: selection.provider, model: config.model }
  // The mutable selection ref is shared: prompt assembly reads it per request
  // (so the /models dialog can switch the live agent's model), and setup()
  // couples it to the agent.
  const selected: ModelSelectionRef = { current: selection, assembled: undefined }
  const setup = (agentCtx: Context): void => {
    installModelSelection(agentCtx, selected)
  }

  // Explicit `--resume <id>` wins; otherwise the auto-resume default
  // (dsh-tui.json `resume_last`, default on) continues the newest session with
  // real content in this same directory — empty sessions (created and exited
  // without a message) are skipped, so relaunching picks up the last actual
  // work rather than a blank transcript.
  let handle: AgentHandle | undefined
  let resumed = false
  if (config.resume !== undefined) {
    handle = await agents.resume({ resumeSessionId: SessionId(config.resume), agentOptions, setup })
    resumed = true
  } else if (resolveResumeLast()) {
    handle = await autoResumeNewest(ctx, agents, config.workspace, agentOptions, setup)
    resumed = handle !== undefined
  }
  if (handle === undefined) {
    handle = await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: config.workspace },
      agentOptions,
      setup,
    })
  }
  // `handle` / `agent` / `sessionId` are reassigned by `newSessionAction` when
  // `/new` switches to a fresh session; every closure below reads them through
  // the `let` bindings, so the listeners and slots track the live session.
  let agent = handle.agent
  let sessionId = agent.session.id
  sessionRef.current = sessionId
  store.setSession(agent.session)
  // Bottom-bar session stats (web StatsLine subset): per-step/per-tool timing
  // buckets live here; on session switches both are cleared and the durable
  // log is re-folded for counts + tokens.
  const stepStartAt = new Map<string, number>()
  const toolCallsAt = new Map<string, number[]>()
  const resetSessionStats = (): void => {
    stepStartAt.clear()
    toolCallsAt.clear()
    store.resetStats()
  }
  // The active session is the most recently used one (drives list ordering and
  // the launch auto-resume).
  touchSession(sessionId)
  // A resumed session carries its full event log; fold it into the transcript
  // so the UI shows the history, not a blank surface (the live listener below
  // only receives new events). `/new`-created sessions have no history.
  resetSessionStats()
  if (resumed) {
    const history = foldHistoryEvents(agent.session.snapshotEvents())
    store.loadHistory(history.items, history.steps)
    store.setStats(foldSessionStats(agent.session.snapshotEvents()))
  }
  // The merged template directory (core + plugin-registered), read live so a
  // sibling plugin's additions apply without a restart.
  const templates = (): readonly TuiProviderTemplate[] =>
    (ctx.get('tuiLlmTemplates') as { list(): readonly TuiProviderTemplate[] } | undefined)?.list() ?? []
  // No API key -> surface "not set" in the composer; with a key, show the
  // provider · model name (so the same model id from different gateways is
  // distinguishable), plus the saved reasoning effort when one is selected.
  const savedEffort = selection.reasoningEffort === undefined ? undefined : String(selection.reasoningEffort)
  const effortSuffix = savedEffort === undefined ? '' : ` · ${reasoningEffortName(savedEffort)}`
  const hasKey = await apiKeyConfigured(ctx)
  const modelLabel = hasKey
    ? `${providerDisplayName(agentOptions.provider ?? 'deepseek-official', templates())} · ${modelDisplayName(agentOptions.model)}${effortSuffix}`
    : 'not set'
  store.setModelLabel(modelLabel, hasKey ? (savedEffort === undefined ? '' : reasoningEffortName(savedEffort)) : '')
  // Keep the store's current selection in sync with the persisted default so
  // the /models dialog preselects the right provider/model/effort on open.
  store.currentModel = {
    provider: agentOptions.provider ?? 'deepseek-official',
    model: agentOptions.model,
    ...(savedEffort === undefined ? {} : { reasoningEffort: savedEffort }),
  }
  // Hidden-provider list (Ctrl+D/Alt+D in the /models first level): seed from
  // the config file and persist every change back to it.
  store.seedHiddenProviders(readHiddenProviders())
  store.onHiddenProvidersChange = (routes) => { setHiddenProviders(routes) }
  // Belt-and-braces: a session whose current model provider is hidden (e.g. it
  // was deactivated in an older build, or the default persisted before the
  // hide) must not keep `current:` pointing at it. Switch to the first still
  // visible configured provider, else the built-in DeepSeek route.
  if (store.isProviderHidden(store.currentModel.provider)) {
    const service = ctx.get('tuiModels') as TuiModelsService | undefined
    void (service?.listConfigured() ?? Promise.resolve([])).then((providers) => {
      const visible = providers.filter((p) => !store.isProviderHidden(p.provider))
      if (visible.length === 0) {
        // No active (configured + visible) provider remains: show "not set"
        // rather than pointing at a dead route.
        store.setModelLabel('not set', '')
        return
      }
      // Prefer the built-in DeepSeek route over a same-brand sibling, so the
      // composer and `current:` stop showing the hidden provider's family.
      const fallback = visible.find((p) => p.provider === 'deepseek-official') ?? visible[0]
      store.modelsSaveAction(
        fallback.provider,
        fallback.models[0]?.id ?? 'deepseek-v4-flash',
      )
    }).catch(() => { /* best-effort: the /models dialog shows the current provider until the user picks */ })
  }

  store.append('status', `Session ${sessionId} in ${config.workspace}${resumed ? ' (resumed)' : ''}`, true)

  // Warm the title cache shortly after launch so the first /sessions open
  // already has every title (no visible folding delay).
  setTimeout(() => {
    void (async (): Promise<void> => {
      const persistence = ctx.get('sessionPersistence') as (SessionTitlesPersistence & { list?: (signal?: AbortSignal) => Promise<SessionHeaderLike[]> }) | undefined
      if (persistence?.list === undefined) return
      try {
        await prewarmTitles(persistence, await persistence.list())
      } catch {
        // Prewarm is best-effort; a failing list must not disturb the session.
      }
    })()
  }, 500).unref()

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (session.id !== sessionId) return
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        // Reasoning is shown as a collapsed Think block; text streams as the
        // answer. Tool-call deltas are dropped (the settled tool/call row is
        // rendered instead).
        if (chunk.type === 'reasoning-delta') store.streamReasoning(chunk.text)
        else if (chunk.type === 'text-delta') store.streamText(chunk.text)
        break
      }
      case 'assistant/message': {
        const data = event.data as {
          turn?: number
          step?: number
          usage?: { inputTokens?: number; outputTokens?: number }
        }
        // Bottom-bar stats: one assistant step, its LLM wall time (measured
        // from the step/start event) and the provider-reported usage tokens.
        const started = stepStartAt.get(`${data.turn}:${data.step}`)
        const llmMs = started === undefined ? 0 : Date.now() - started
        store.accrueMessage(data.turn ?? 0, llmMs, data.usage)
        const joined = event.data.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        if (joined === '') break
        // Authoritative text: replace (or create) the assistant row so a
        // streamed, possibly newline-incomplete copy never lingers (headings
        // flush against the content above), and live matches a resumed replay.
        store.settleAssistantText(joined)
        break
      }
      case 'step/start': {
        const data = event.data as { turn?: number; step?: number }
        if (typeof data.turn === 'number' && typeof data.step === 'number') {
          stepStartAt.set(`${data.turn}:${data.step}`, Date.now())
        }
        break
      }
      // The model's step-by-step plan and progress: latest write wins (sidebar
      // Steps + pinned block). The tool rows below are separate.
      case 'todo/write': {
        const todos = event.data.todos
        if (todos.length > 0) store.setSteps(todos)
        break
      }
      // Tool calls/results shown inline like opencode (icon + name rows); the
      // result also closes the tool's wall-time bucket (FIFO per turn:step).
      case 'tool/call': {
        const data = event.data as { turn?: number; step?: number }
        const key = `${data.turn}:${data.step}`
        const queue = toolCallsAt.get(key) ?? []
        queue.push(Date.now())
        toolCallsAt.set(key, queue)
        store.toolCall(event.data.name)
        break
      }
      case 'tool/result': {
        const data = event.data as { turn?: number; step?: number }
        const key = `${data.turn}:${data.step}`
        const started = toolCallsAt.get(key)?.shift()
        if (started !== undefined) store.accrueTool(Date.now() - started)
        store.toolResult()
        break
      }
      // The session title (first-task summary) folds in the harness
      // session-title service; remember it so the /sessions and /resume lists
      // never need to re-read the log for this session.
      case 'session/title': {
        rememberTitle(sessionId, event.data.title)
        break
      }
      // Non-user user/message = injected context (e.g. the system prompt),
      // rendered as a "Context injection" notice like dsh web.
      case 'user/message': {
        const source = event.data.source as { kind?: string; plugin?: string }
        if (source.kind === 'user') break
        const label = source.kind === 'plugin' && source.plugin ? source.plugin : (source.kind ?? 'context')
        store.append('status', `Context injection · ${label}`)
        break
      }
      default:
    }
  })

  store.append('status', 'Ready. Enter to send · Ctrl+C clears the input · /exit quits.', true)

  // Wire the slash commands (built after the agent exists). Core commands
  // only; `/models` and `/sessions` register from their panel plugins.
  tui.panels.register({
    id: 'help',
    mode: 'fullscreen',
    render: () => <HelpDialog />,
    handleKey: (k) => {
      if (k.escape || (k.ctrl && (k.char ?? '') === 'c')) store.cancelHelp()
      return true
    },
  })
  tui.commands.register({ name: 'help', hint: 'show this help', run: () => { store.openHelp() } })
  tui.commands.register({ name: 'think', hint: 'expand/collapse the Think (reasoning) text', run: () => { store.toggleReasoning() } })
  tui.commands.register({
    name: 'compact',
    hint: 'compact the session history',
    run: (arg) => {
      // The harness `/compact` takes no arguments; mirror its usage guard.
      if (arg.trim() !== '') {
        store.append('status', 'Usage: /compact (no arguments)', true)
        return
      }
      void compact(ctx, agent)
    },
  })
  tui.commands.register({ name: 'clear', hint: 'clear the transcript', run: () => { store.clear() } })
  tui.commands.register({ name: 'exit', hint: 'quit dsh-tui', run: () => { requestExit(io, 0) } })

  store.submitMessage = (text) => {
    if (store.inputHistory.at(-1) !== text) {
      store.inputHistory.push(text)
      if (store.inputHistory.length > 100) store.inputHistory.shift()
    }
    store.setPaused(false) // any new message resumes; the model decides what to do
    store.append('user', text)
    touchSession(sessionId)
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  }
  store.cancelAction = () => { /* nothing: keep the session open */ }
  const modelsService = ctx.get('tuiModels') as TuiModelsService | undefined
  // Fill the Add-provider dropdown from the merged template directory once at
  // startup (re-fillable by a plugin calling setProviderTemplates again).
  store.setProviderTemplates(templates().map((t) => ({
    id: t.route,
    name: t.name,
    baseURL: t.baseURL,
    ...(t.models !== undefined ? { models: t.models } : {}),
  })))
  store.modelsSaveAction = (provider: string, model: string, effort?: string) => {
    // The mutable selection ref is read per request by prompt assembly, so
    // updating it switches the LIVE agent's next request to the new model and
    // reasoning effort (the same mechanism the web Models page uses);
    // saveSelection persists the default for future runs. An absent effort
    // clears any inherited one, restoring the model's own default behavior.
    const next: ModelSelection = effort === undefined
      ? { provider, model }
      : { provider, model, reasoningEffort: effort as ModelSelection['reasoningEffort'] }
    selected.current = next
    store.currentModel = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    void defaultModel.saveSelection(next).catch(() => { /* best-effort persist */ })
    // Label with the provider name too, so the same model id from different
    // gateways is distinguishable (OpenCode Zen · DeepSeek V4 Flash vs
    // DeepSeek · DeepSeek V4 Flash), plus the saved effort when chosen.
    const providerEntry = modelsService?.listProviders().find((p) => p.provider === provider)
    const providerName = providerEntry?.name ?? providerDisplayName(provider, templates())
    const modelName = providerEntry?.models.find((m) => m.id === model)?.name ?? modelDisplayName(model)
    const effortDisplay = effort === undefined ? '' : reasoningEffortName(effort)
    const effortSuffix = effortDisplay === '' ? '' : ` · ${effortDisplay}`
    void apiKeyConfigured(ctx).then(ok => store.setModelLabel(ok ? `${providerName} · ${modelName}${effortSuffix}` : 'not set', ok ? effortDisplay : ''))
    store.append('status', `models: ${providerName} · ${modelName}${effortSuffix}`, true)
  }
  // Ctrl+T / Alt+T: cycle the current model's reasoning effort through its
  // declared levels (wraps), like opencode's variant_cycle; the save path
  // above persists the new effort and updates the composer label/status.
  store.cycleEffort = () => {
    const { provider, model } = store.currentModel
    const entry = modelsService?.listProviders().find((p) => p.provider === provider)
    const option = entry?.models.find((m) => m.id === model)
    const choices = option?.efforts ?? []
    if (option === undefined || choices.length === 0) {
      store.append('status', `models: ${model} has no reasoning effort`, true)
      return
    }
    const current = store.currentModel.reasoningEffort
    const start = current ?? option.defaultEffort ?? ''
    let index = choices.findIndex((e) => e.id === start)
    if (index < 0) index = -1
    const next = choices[(index + 1) % choices.length]
    if (next !== undefined) store.modelsSaveAction(provider, model, next.id)
  }
  // Ctrl+D / Alt+D on a first-level provider: hide it from /models AND remove
  // its API key (deactivate). An environment-supplied key survives (it cannot
  // be deleted from here) — the hidden set keeps the provider off the list
  // until a stored key is set again in "Add provider".
  store.deactivateProvider = (route: string, name: string) => {
    const service = ctx.get('tuiModels') as TuiModelsService | undefined
    void (async (): Promise<void> => {
      let envNote = ''
      if (service !== undefined) {
        const result = await service.removeKey(route)
        if (!result.ok) {
          store.setDialogNotice(`hidden ${name} — ${result.error}`)
          return
        }
        if (result.envKey) envNote = ' (the key lives in the environment — remove it there to fully deactivate)'
      }
      const wasCurrent = store.currentModel.provider === route
      // Pick a fallback BEFORE the row disappears from the (visible) list.
      // Prefer the built-in DeepSeek route (a clearly different brand) over
      // the first sibling — same-brand gateways (e.g. Moonshot AI vs Moonshot
      // AI (CN), which share one API key) would otherwise keep the composer
      // and `current:` looking like the hidden provider.
      const others = wasCurrent ? store.providers.filter((p) => p.provider !== route) : []
      const fallback = others.find((p) => p.provider === 'deepseek-official') ?? others[0]
      store.hideProvider(route)
      if (wasCurrent && others.length === 0) {
        // No active (configured + visible) provider remains: clear the model
        // selection to "not set" instead of pointing at a dead route.
        store.setModelLabel('not set', '')
        store.setDialogNotice(
          `hidden ${name} — API key removed${envNote}; no active providers left — model not set`,
        )
        return
      }
      if (wasCurrent) {
        // The deactivated provider was the current model: switch the live
        // selection away so "current:" never points at a hidden provider (and
        // later requests do not target a keyless route).
        const provider = fallback?.provider ?? 'deepseek-official'
        const model = fallback?.models[0]?.model ?? 'deepseek-v4-flash'
        store.modelsSaveAction(provider, model)
        const modelName = fallback?.models[0]?.label ?? modelDisplayName(model)
        const fallbackName = fallback?.name ?? 'DeepSeek'
        store.setDialogNotice(
          `hidden ${name} — API key removed${envNote}; current model switched to ${fallbackName} · ${modelName}`,
        )
        return
      }
      store.setDialogNotice(`hidden ${name} — API key removed${envNote}; re-add it in "Add provider"`)
    })()
  }
  store.openProviderList = () => {
    if (modelsService === undefined) return
    void modelsService.listAll().then((names) => {
      if (names.length === 0) {
        // No registered provider at all: surface the notice inside the dialog.
        store.setDialogNotice('no providers are registered')
        return
      }
      store.startProviderList(names)
    })
  }
  store.keyDialogSubmit = (provider: string, name: string, key: string) => {
    if (modelsService === undefined) return
    void modelsService.setKey(provider, key).then((result) => {
      if (!result.ok) {
        store.append('status', `models: ${result.error}`, true)
        return
      }
      store.append('status', `models: API key saved for ${name}`, true)
      // Setting a key through "Add provider" is the re-add path for a hidden
      // provider: clear its hidden flag so /models lists it again.
      store.unhideProvider(provider)
      // Activating a dormant catalog route registers asynchronously (settings
      // write → adapter hot re-register), and its model list only resolves
      // once the route is registered, so poll until the picker can show it.
      const refresh = (attempts: number): void => {
        void modelsService.listConfigured().then((providers) => {
          const entries = buildProviderEntries(providers)
          if (entries.some((e) => e.provider === provider) || attempts <= 0) {
            store.openModels(entries, Math.max(0, entries.findIndex((e) => e.provider === provider)))
            // Refresh the total-provider count shown after ＋ Add provider.
            void modelsService.listAll().then((names) => store.setProviderTotal(names.length)).catch(() => {})
            return
          }
          setTimeout(() => refresh(attempts - 1), 120)
        })
      }
      refresh(25)
    })
  }
  store.providerFormSubmit = (input: AddProviderInput) => {
    if (modelsService === undefined) {
      store.showProviderFormError('models service unavailable')
      return
    }
    void modelsService.addProvider(input).then((result) => {
      if (!result.ok) {
        store.showProviderFormError(result.error)
        return
      }
      // The settings write commits before the pi-ai adapter re-registers the
      // new route, so poll briefly until the picker can see it.
      const refresh = (attempts: number): void => {
        const entries = buildProviderEntries(modelsService.listProviders())
        if (entries.some((e) => e.provider === input.route.trim()) || attempts <= 0) {
          store.openModels(entries, Math.max(0, entries.findIndex((e) => e.provider === input.route.trim())))
          // Refresh the total-provider count shown after ＋ Add provider.
          void modelsService.listAll().then((names) => store.setProviderTotal(names.length)).catch(() => {})
          store.append('status', `models: provider ${input.route.trim()} added`, true)
          return
        }
        setTimeout(() => refresh(attempts - 1), 120)
      }
      refresh(10)
    })
  }
  store.pauseAgent = () => {
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    store.setPaused(true)
  }
  store.newSessionAction = () => {
    // The `/new` command: start a brand-new session in place, modeled on
    // opencode's command-palette "New session" entry. The harness persists
    // every session durably (write-behind on session/event), so the old one
    // stays reachable from /sessions / --resume after it is torn down here.
    if (store.running) {
      try { agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch { /* best-effort */ }
    }
    void (async (): Promise<void> => {
      try {
        // Create the next agent BEFORE tearing the old one down: a failed
        // create leaves the current session untouched.
        const next = await agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          meta: { cwd: config.workspace },
          agentOptions,
          setup,
        })
        // The runtime owns exactly one live handle by the time a user can run
        // `/new`, so it is always set here.
        const old = handle
        if (old === undefined) return
        try { await old.dispose() } catch (error) { logError('new: disposing the old session failed', error) }
        handle = next
        agent = next.agent
        sessionId = agent.session.id
        sessionRef.current = sessionId
        store.setSession(agent.session)
        touchSession(sessionId)
        resetSessionStats()
        store.clear() // transcript + steps from the old session
        store.setRunning(false)
        store.setPaused(false)
        store.append('status', `New session ${sessionId} in ${config.workspace}`, true)
      } catch (error) {
        store.append('status', `new: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    })()
  }
  store.resumeSessionAction = (id) => {
    // The /sessions dialog's Enter: switch to the selected persisted session
    // in place, exactly like the launch auto-resume (agents.resume + history
    // replay). The target is resumed BEFORE the old agent is disposed, so a
    // failed load leaves the current session untouched.
    if (String(id) === String(sessionId)) {
      store.append('status', `already on session ${sessionId}`, true)
      return
    }
    if (store.running) {
      try { agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch { /* best-effort */ }
    }
    void (async (): Promise<void> => {
      try {
        const next = await agents.resume({ resumeSessionId: SessionId(id), agentOptions, setup })
        const old = handle
        if (old === undefined) return
        try { await old.dispose() } catch (error) { logError('resume: disposing the old session failed', error) }
        handle = next
        agent = next.agent
        sessionId = agent.session.id
        sessionRef.current = sessionId
        store.setSession(agent.session)
        touchSession(sessionId)
        resetSessionStats()
        const history = foldHistoryEvents(agent.session.snapshotEvents())
        store.loadHistory(history.items, history.steps)
        store.setStats(foldSessionStats(agent.session.snapshotEvents()))
        store.setRunning(false)
        store.setPaused(false)
        store.append('status', `Session ${sessionId} in ${config.workspace} (resumed)`, true)
      } catch (error) {
        store.append('status', `resume: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    })()
  }
  store.setWorkspace(config.workspace)
  ctx.on('agent/status', (payload: { agent: { id: SessionId }; status: 'idle' | 'running' }) => {
    if (payload.agent.id !== sessionId) return
    if (payload.status === 'running') store.lastEscTime = 0 // fresh turn: clear a stale single-Esc window
    store.setRunning(payload.status === 'running')
  })

  // Enable raw mode so the terminal owns no input processing.
  if (typeof process.stdin.setRawMode === 'function' && process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  // Park the REAL terminal cursor at the composer caret after every full-screen
  // frame, and keep it visible. Ink hides the terminal cursor and (previously)
  // drew its own blinking block; macOS Terminal anchors the IME composition/
  // candidate window to the real cursor position, so a hidden or wandering
  // cursor makes the candidate window jump on every redraw while typing
  // Chinese. The patched Ink frame writer (apps/tui-bin/build.mjs) appends the
  // suffix after all line updates, so the position is never overwritten by the
  // next frame.
  const app = render(<App />)

  // NOTE: mouse tracking is intentionally NOT enabled — the terminal keeps
  // its default behavior (no mouse events to the app; native selection and
  // wheel scrollback stay with the terminal).

  // Live terminal width: Bun/Node emit 'resize' on process.stdout and update
  // `columns`; Ink only re-renders the DOM, so we drive a reactive Store size.
  const onResize = (): void => {
    store.setSize(process.stdout.columns ?? 80, process.stdout.rows ?? 24)
    if (process.env.DSH_TUI_DEBUG_WIDTH === '1') {
      process.stderr.write(`[dsh-tui] width ${process.stdout.columns ?? 80}\n`)
    }
  }
  process.stdout.on('resize', onResize)

  // Alt+Enter (`\x1b\r`) and Home/End (`\x1b[H`/`\x1b[F`) are swallowed by
  // Ink's key parser, so all keyboard input is read raw and dispatched by
  // `handleKey` (panels + conversation composer).
  const decoder = new StdinDecoder()
  let escTimer: ReturnType<typeof setTimeout> | undefined
  const onStdin = (chunk: Buffer | string): void => {
    if (escTimer !== undefined) { clearTimeout(escTimer); escTimer = undefined }
    const keys = decoder.push(chunk)
    for (const key of keys) handleKey(key)
    // A lone ESC could be a pending escape sequence prefix or the Esc key
    // itself; if nothing followed it shortly, treat it as Esc.
    if (decoder.pendingEscape) {
      escTimer = setTimeout(() => {
        for (const key of decoder.flushEsc()) handleKey(key)
      }, 80)
    }
  }
  process.stdin.on('data', onStdin)


  // Restore the terminal on exit. This handler is registered after every other
  // exit-time writer (log.ts's stderr mirror of `dsh-tui exited`, Ink's
  // signal-exit unmount frame), so writing the leave sequence here makes it the
  // process's LAST visible terminal output: everything written before it lands
  // in the alternate screen buffer and is discarded when the buffer is switched
  // back, leaving no dsh-tui residue above the shell prompt. (One harmless
  // `\x1b[?25h` cursor-show may still follow: restore-cursor registers an
  // afterexit hook that unconditionally re-shows the cursor — invisible by
  // design, and the cursor being visible is the correct end state anyway.)
  process.once('exit', () => {
    if (typeof process.stdin.setRawMode === 'function' && process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdout.off('resize', onResize)
    process.stdin.off('data', onStdin)
    void app.unmount()
    try { process.stdout.write('\x1b[?25h\x1b[?1049l') } catch { /* ignore */ }
  })
  await agent.whenIdle()
}

/**
 * Map a terminal SGR-mouse left-click (row/column) to a character index in the
 * composer input and move the cursor there. The composer sits above the status
 * bar; the input text is its first content row, and long lines wrap.
 * @param row - the SGR mouse row (1-based).
 * @param col - the SGR mouse column (1-based).
 */
/**
 * The user-questions answerer: present each of the model's questions in-band
 * and return the human's answer. Single-select options plus a typeable
 * "Other" row; if only one question is asked this is a one-step decision.
 * @param request - the ask_user_question request.
 * @returns the structured answer.
 */
async function askUser(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
  const answers: AskUserQuestionAnswerItem[] = []
  for (let q = 0; q < request.questions.length; q++) {
    const item = request.questions[q]
    const answer = await new Promise<AskUserQuestionAnswerItem>((resolve, reject) => {
      // An abort (tool/step cancelled) must reject the pending ask.
      if (request.signal?.aborted) {
        reject(new Error('ask_user_question was cancelled'))
        return
      }
      store.setQuestion({
        item, resolve, reject, index: 0, custom: '', customMode: false,
        position: q + 1, total: request.questions.length,
      })
      if (request.signal) {
        request.signal.addEventListener('abort', () => {
          if (store.question !== null) {
            const rejectFn = store.question.reject
            store.clearQuestion()
            rejectFn(new Error('ask_user_question was cancelled'))
          }
        }, { once: true })
      }
    })
    answers.push(answer)
  }
  return { answers }
}

/**
 * Auto-resume: the newest same-directory session that actually has user
 * content. Empty sessions (created and exited without a message) are skipped
 * — resuming them would just show a blank transcript — so the relaunch lands
 * on the last real work. The content check reads the already-resumed session's
 * in-memory event list (no extra log reads); skipped sessions stay persisted
 * for manual resume via /sessions.
 * @param ctx - plugin context carrying sessionPersistence.
 * @param agents - the agents service (resume).
 * @param cwd - the directory to match against session headers.
 * @param agentOptions - model/provider options passed to resume.
 * @param setup - the model-selection setup callback passed to resume.
 * @returns the resumed handle, or `undefined` when no candidate has content
 *   (or persistence is unavailable) — the caller starts fresh.
 */
async function autoResumeNewest(
  ctx: Context,
  agents: { resume(options: ResumeAgentOptions): Promise<AgentHandle> },
  cwd: string,
  agentOptions: { provider: string; model: string },
  setup: (agentCtx: Context) => void,
): Promise<AgentHandle | undefined> {
  const persistence = ctx.get('sessionPersistence') as { list?: (signal?: AbortSignal) => Promise<Array<{ id: SessionId; cwd?: string; createdAt?: number }>> } | undefined
  if (persistence?.list === undefined) return undefined
  let list: Array<{ id: SessionId; cwd?: string; createdAt?: number }>
  try {
    list = await persistence.list()
  } catch {
    return undefined // A failing list must not block a fresh launch.
  }
  const candidates = list
    .filter((h) => h.cwd === cwd)
    // Most recently used first (last activity, then creation time).
    .sort((a, b) => {
      const activityA = lastActivity(a.id) ?? 0
      const activityB = lastActivity(b.id) ?? 0
      if (activityA !== activityB) return activityB - activityA
      return (b.createdAt ?? 0) - (a.createdAt ?? 0)
    })
  for (const header of candidates) {
    try {
      const handle = await agents.resume({ resumeSessionId: header.id, agentOptions, setup })
      const hasUserContent = handle.agent.session.snapshotEvents().some(
        (event) => event.type === 'user/message'
          && (event.data as { source?: { kind?: string } }).source?.kind === 'user',
      )
      if (hasUserContent) return handle
      await handle.dispose() // Empty session: skip to the next newest.
    } catch {
      // Unresumable session (corrupt/unreadable): skip it.
    }
  }
  return undefined
}

/** Flatten text blocks from a harness message content (mirrors export.tsx). */
function flattenContentText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .filter((b): b is { type: string; text?: unknown } => b !== null && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('')
}

/**
 * Fold a persisted session's event log into transcript rows, mirroring what
 * the live `session/event` listener renders — except assistant text comes from
 * the settled `assistant/message` events (streaming chunks are dropped) and
 * the whole result is produced in one pass so a resumed session replays
 * instantly instead of chunk-by-chunk.
 * @param events - the resumed session's full event log.
 * @returns the transcript rows and the latest step list.
 */
function foldHistoryEvents(events: readonly SessionEvent[]): { items: TranscriptItem[]; steps: StepItem[] } {
  const items: TranscriptItem[] = []
  let key = 0
  let steps: StepItem[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source as { kind?: string; plugin?: string }
        if (source.kind === 'user') {
          const text = flattenContentText(event.data.content)
          if (text !== '') items.push({ key: key += 1, kind: 'user', text })
        } else {
          const label = source.kind === 'plugin' && source.plugin ? source.plugin : (source.kind ?? 'context')
          items.push({ key: key += 1, kind: 'status', text: `Context injection · ${label}`, dim: true })
        }
        break
      }
      case 'assistant/message': {
        // assistant/message carries `{ turn, step, message }` (unlike
        // user/message, whose data IS the message).
        const joined = flattenContentText(event.data.message.content)
        if (joined === '') break
        items.push({ key: key += 1, kind: 'assistant', text: joined })
        break
      }
      case 'todo/write': {
        const todos = event.data.todos
        if (todos.length > 0) steps = todos
        break
      }
      case 'tool/call': {
        items.push({ key: key += 1, kind: 'tool', text: `│ ${event.data.name}` })
        break
      }
      case 'tool/result': {
        // Mark the most recent running tool row as completed (toolResult()).
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i]
          if (item !== undefined && item.kind === 'tool' && item.text.startsWith('│ ')) {
            items[i] = { ...item, text: `✓ ${item.text.slice(2)}` }
            break
          }
        }
        break
      }
      default:
        // assistant/chunk and session/title are skipped: settled messages and
        // the title cache cover them.
    }
  }
  return { items, steps }
}

/** The harness manual-compaction failure texts, verbatim from dsh-command-compact. */
const COMPACTION_FAILURE_TEXT: Record<ManualCompactionErrorCode, string> = {
  busy: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
  cancelled: 'Compaction cancelled.',
  changed: 'The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.',
  summary: 'Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.',
  commit: 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
  persistence: 'Compaction finished, but the session could not be saved.',
}

/** One manual `/compact` request: run the harness compaction seam on the live
 *  agent and report the outcome the way the harness `/compact` command does. */
async function compact(ctx: Context, agent: unknown): Promise<void> {
  const compaction = ctx.get('compaction') as
    | { compactNow?: (agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId: string) => Promise<CompactionResult | null> }
    | undefined
  if (compaction?.compactNow === undefined) {
    store.append('status', 'compaction service unavailable', true)
    return
  }
  try {
    const result = await compaction.compactNow(
      // The live agent (agent-loop's Agent) implements the compaction contract
      // (runMaintenance + session + options) even though the public dsh-agent
      // type only exposes `id`, so the seam's own context type is asserted here.
      agent as ManualCompactAgentContext,
      new AbortController().signal,
      `tui-${randomUUID()}`,
    )
    store.append('status', result === null
      ? 'No compactable history yet.'
      : `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`, true)
  } catch (error) {
    store.append('status', error instanceof ManualCompactionError
      ? COMPACTION_FAILURE_TEXT[error.code]
      : `compaction: ${error instanceof Error ? error.message : String(error)}`, true)
  }
}

/**
 * Store the DeepSeek API key through the credentials seam — the same write the
 * web Models page performs (`~/.dsh/.credentials.yaml` under the
 * `DEEPSEEK_API_KEY` reference). `dsh-llm-deepseek` resolves the key per
 * request, so the next model turn picks it up without a restart.
 * @param ctx - plugin context carrying the credentials service.
 * @param value - the trimmed API key.
 */
async function connect(ctx: Context, value: string): Promise<void> {
  const credentials = ctx.get('credentials') as { set?: (ref: ReturnType<typeof credentialRef>, value: string) => Promise<void> } | undefined
  if (credentials?.set === undefined) {
    store.append('status', 'connect: the credentials service is unavailable', true)
    return
  }
  try {
    await credentials.set(credentialRef('DEEPSEEK_API_KEY'), value.trim())
    store.append('status', 'connect: API key saved to ~/.dsh/.credentials.yaml — applies to the next request', true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.append('status', `connect: ${message} (tip: if DEEPSEEK_API_KEY is in the environment, use it directly instead)`, true)
  }
}
