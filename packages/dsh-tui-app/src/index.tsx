/**
 * @yourname/dsh-tui-app — a full-screen Ink/React terminal surface. The bundle
 * patch rides over dsh-base without an HTTP host or browser; this runtime
 * creates one Agent through the core registry, streams its session events into
 * an Ink transcript, and drives user input back in via `followup()` / `steer()`.
 *
 * Surface features (each owned here, none touching the harness core):
 *   - slash command palette (type `/`)
 *   - a `approval/request` answerer that prompts for tool approval in-band
 *   - a `--resume` / `/resume` session picker over persisted sessions
 *   - an opencode-style two-panel layout (conversation + activity) and input dock
 *
 * @module @yourname/dsh-tui-app
 */

import { randomUUID } from 'node:crypto'
import { render, Box, Text, useStdin, measureElement, type DOMElement } from 'ink'
import React, { useMemo, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
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
import { TUI_MODELS_SERVICE, PROVIDER_TEMPLATES, type AddProviderInput, type ModelsProviderOption, type ProviderTemplate, type TuiModelsService } from './models.ts'
import { MarkdownText, markdownPlain, estimateMarkdownHeight, visualWidth, countWrappedLines } from './markdown.tsx'
import { persistSidebarMin, resolveSidebarMin } from './config.ts'
import { theme } from './theme.ts'
import { StdinDecoder, type RawKey } from './stdin.ts'
import { initErrorLog, logError, logConsoleError } from './log.ts'
import pkg from '../../../package.json' with { type: 'json' }

/** Stable Cordis plugin name. */
export const name = 'tui-runtime'

/** Project version (single source of truth: the root package.json). */
const APP_VERSION = (pkg as { version?: string }).version ?? '0.0.0'

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
interface ModelsOption {
  /** Registered provider route. */
  provider: string
  /** Model id sent to the provider. */
  model: string
  /** Display label (`provider · model`). */
  label: string
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
  'danger-full-access': 'Full access',
}
const PERMISSION_COLOR: Record<SandboxMode, string> = {
  'read-only': theme.error,
  'workspace-write': theme.warning,
  'danger-full-access': theme.success,
}

/** A selectable persisted session for the resume picker. */
export interface SessionSummary {
  readonly id: SessionId
  readonly label: string
  readonly cwd?: string
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
}

/** A command in the slash palette. */
export interface CommandItem {
  readonly name: string
  readonly hint: string
  readonly run: (arg: string) => void
}

/** Mutable UI store the Ink app subscribes to. */
class Store {
  private items: TranscriptItem[] = []
  private key = 0
  private version = 0
  private listeners = new Set<() => void>()
  private _input = ''
  private _cursor = 0
  private _panel: 'conversation' | 'approval' | 'resume' | 'connect' | 'question' = 'conversation'
  private _commandFilter = ''
  private _commandIndex = 0
  private _approval: PendingApproval | null = null
  private _sessions: SessionSummary[] = []
  private _sessionIndex = 0
  private _steps: StepItem[] = []
  private _secret = ''
  private _question: PendingQuestion | null = null
  private _sidebarMin = resolveSidebarMin()
  private _width = process.stdout.columns ?? 80
  private _rows = process.stdout.rows ?? 24
  private _permission: SandboxMode = 'workspace-write'
  private _modelLabel = ''
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

  getItems(): readonly TranscriptItem[] { return this.items }
  get steps(): readonly StepItem[] { return this._steps }
  get stepsDone(): number { return this._steps.filter(s => s.status === 'completed').length }
  get stepsTotal(): number { return this._steps.length }
  get stepsActive(): boolean { return this._steps.length > 0 }
  setSteps(steps: StepItem[]): void { this._steps = steps; this.notify() }
  get input(): string { return this._input }
  get panel() { return this._panel }
  get commandFilter() { return this._commandFilter }
  get commandIndex() { return this._commandIndex }
  get approval() { return this._approval }
  get sessions() { return this._sessions }
  get sessionIndex() { return this._sessionIndex }
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
  bumpCommandIndex(delta: number): void {
    const len = Math.max(1, this.commands.length)
    this._commandIndex = (this._commandIndex + delta + len) % len
    this.notify()
  }
  private _commands: CommandItem[] = []
  get commands(): CommandItem[] { return this._commands }
  setCommands(commands: CommandItem[]): void { this._commands = commands; this.notify() }

  setApproval(approval: PendingApproval | null): void { this._approval = approval; if (approval) this._panel = 'approval'; else if (this._panel === 'approval') this._panel = 'conversation'; this.notify() }
  get question(): PendingQuestion | null { return this._question }
  setQuestion(q: PendingQuestion): void { this._question = q; this._panel = 'question'; this.notify() }
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
  get sidebarMin(): number { return this._sidebarMin }
  setSidebarMin(min: number): void { this._sidebarMin = min; persistSidebarMin(min); this.notify() }
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
  get permissionColor(): string { return PERMISSION_COLOR[this._permission] }
  cyclePermission(): SandboxMode {
    const i = SANDBOX_CYCLE.indexOf(this._permission)
    this._permission = SANDBOX_CYCLE[(i + 1) % SANDBOX_CYCLE.length] ?? 'workspace-write'
    this.notify()
    return this._permission
  }
  get modelLabel(): string { return this._modelLabel }
  setModelLabel(label: string): void { this._modelLabel = label; this.notify() }
  get session(): Session | undefined { return this._session }
  setSession(session: Session): void { this._session = session }
  setSessions(sessions: SessionSummary[]): void { this._sessions = sessions; this._sessionIndex = 0; this._panel = sessions.length > 0 ? 'resume' : 'conversation'; this.notify() }
  private _models: readonly ModelsOption[] = []
  private _modelIndex = 0
  private _providerForm = false
  private _providerField = 0
  private _providerTemplates: readonly ProviderTemplate[] = []
  private _providerTemplate = 0
  private _providerValues: string[] = [] // route / display name / base URL / API key / model ids
  private _providerFormError = ''
  private _providerList = false
  private _providerListIndex = 0
  private _providerNames: readonly { provider: string; name: string; configured: boolean }[] = []
  private _keyDialog = false
  private _keyDialogProvider = ''
  private _keyDialogName = ''
  private _keyDialogConfigured = false
  private _dialogNotice = ''
  get models(): readonly ModelsOption[] { return this._models }
  get modelIndex(): number { return this._modelIndex }
  get dialogNotice(): string { return this._dialogNotice }
  /** Show a transient notice inside the /models dialog (e.g. no providers registered). */
  setDialogNotice(message: string): void {
    this._dialogNotice = message
    this.notify()
  }
  get providerForm(): boolean { return this._providerForm }
  get providerField(): number { return this._providerField }
  get providerTemplates(): readonly ProviderTemplate[] { return this._providerTemplates }
  get providerTemplate(): number { return this._providerTemplate }
  get providerValues(): readonly string[] { return this._providerValues }
  get providerFormError(): string { return this._providerFormError }
  get providerList(): boolean { return this._providerList }
  get providerListIndex(): number { return this._providerListIndex }
  get providerNames(): readonly { provider: string; name: string; configured: boolean }[] { return this._providerNames }
  get keyDialog(): boolean { return this._keyDialog }
  get keyDialogProvider(): string { return this._keyDialogProvider }
  get keyDialogName(): string { return this._keyDialogName }
  get keyDialogConfigured(): boolean { return this._keyDialogConfigured }
  /** Move the /models picker highlight by `delta` (wraps; the last two slots are the add-provider entries). */
  bumpModelIndex(delta: number): void {
    const len = this._models.length + 2
    this._modelIndex = (this._modelIndex + delta + len) % len
    this.notify()
  }
  /** Open the /models dialog: picker over the configured providers' models. */
  openModels(models: readonly ModelsOption[], initialIndex: number): void {
    this._secret = ''
    this._models = models
    this._modelIndex = Math.max(0, Math.min(initialIndex, models.length))
    this._providerForm = false
    this._providerField = 0
    this._providerValues = []
    this._providerList = false
    this._keyDialog = false
    this._dialogNotice = ''
    this._panel = 'connect'
    this.notify()
  }
  /** Show the registered-provider list (pick one to set or change its API key). */
  startProviderList(names: readonly { provider: string; name: string; configured: boolean }[]): void {
    this._providerList = true
    this._providerListIndex = 0
    this._providerNames = names
    this._dialogNotice = ''
    this.notify()
  }
  bumpProviderListIndex(delta: number): void {
    const len = Math.max(1, this._providerNames.length)
    this._providerListIndex = (this._providerListIndex + delta + len) % len
    this.notify()
  }
  /** Pick the highlighted provider: closes the list and returns the choice. */
  selectProviderList(): { provider: string; name: string; configured: boolean } | undefined {
    const picked = this._providerNames[this._providerListIndex]
    this._providerList = false
    this._modelIndex = 0 // back on a model option, so Enter saves (not re-opens the list)
    this.notify()
    return picked
  }
  cancelProviderList(): void {
    this._providerList = false
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
  cancelConnect(): void { this._secret = ''; if (this._panel === 'connect') this._panel = 'conversation'; this.notify() }
  bumpSessionIndex(delta: number): void {
    const len = Math.max(1, this._sessions.length)
    this._sessionIndex = (this._sessionIndex + delta + len) % len
    this.notify()
  }
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
    this._followTail = false
    const page = Math.max(1, this._layoutViewport)
    this._scroll = Math.max(0, Math.min(this._scroll + dir * page, this._maxScroll()))
    this.notify()
  }
  /** Scroll the transcript by a small line delta (mouse wheel). */
  scrollLines(delta: number): void {
    this._followTail = false
    this._scroll = Math.max(0, Math.min(this._scroll + delta, this._maxScroll()))
    this.notify()
  }
  scrollTop(): void { this._followTail = false; this._scroll = 0; this.notify() }
  scrollBottom(): void { this._followTail = true; this._scroll = this._maxScroll(); this.notify() }
}

/** The single UI store; settled plugins and the Ink app share it. */
export const store = new Store()

/** The current agent's session id, set once the agent is created. */
const sessionRef: { current?: SessionId } = {}

/** Injected action callbacks used by the raw-stdin key dispatcher. */
let submitMessage: (text: string) => void = () => {}
let cancelAction: () => void = () => {}
/** Save the /models dialog's chosen provider/model for the live agent. */
let modelsSaveAction: (provider: string, model: string) => void = () => {}
/** Submit the add-provider form (validates + writes settings/credential, refreshes the picker). */
let providerFormSubmit: (input: AddProviderInput) => void = () => {}
/** Open the "＋ Add provider" list of registered providers missing an API key. */
let openProviderList: () => void = () => {}
/** Submit the API-key sub-dialog for one provider. */
let keyDialogSubmit: (provider: string, name: string, key: string) => void = () => {}
/** The running agent, for the double-Esc pause. */
let pauseAgent: () => void = () => {}
/** Timestamp of the last Esc press (window for the double-Esc pause). */
let lastEscTime = 0
/** Submitted (non-command) messages, newest last; browsed with the Up/Down keys. */
let inputHistory: string[] = []
/** Index into `inputHistory` being viewed; -1 = not browsing. */
let historyBrowse = -1
/** The input saved when browsing started, restored on Down past the newest entry. */
let historyDraft = ''

/** Load history entry `index` into the composer, caret at its end. */
function loadHistoryEntry(index: number): void {
  const entry = inputHistory[index]
  if (entry === undefined) return
  historyBrowse = index
  store.setInput(entry)
  store.setCursor(entry.length)
}

/** Step to an older history entry (start browsing from the newest when idle). */
function browseOlder(): void {
  if (inputHistory.length === 0) return
  if (historyBrowse === -1) {
    historyDraft = store.input
    loadHistoryEntry(inputHistory.length - 1)
  } else {
    loadHistoryEntry(Math.max(0, historyBrowse - 1))
  }
}

/** Step to a newer history entry; past the newest, restore the pre-browse draft. */
function browseNewer(): void {
  if (historyBrowse === -1) return
  if (historyBrowse + 1 >= inputHistory.length) {
    historyBrowse = -1
    store.setInput(historyDraft)
    store.setCursor(historyDraft.length)
  } else {
    loadHistoryEntry(historyBrowse + 1)
  }
}

/** Leave history browsing (used whenever the composer input otherwise changes). */
function resetHistoryBrowse(): void {
  historyBrowse = -1
  historyDraft = ''
}

/** Commands matching the current filter, prefix matches first (shared by palette + Enter). */
function filteredCommands(): CommandItem[] {
  const q = store.commandFilter.toLowerCase()
  return store.commands
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)))
}

/** Measured row heights (actual rendered rows) keyed by item key / 'steps'. */
const measuredHeights = new Map<string, number>()

/** Last time each key notified, to debounce re-measurement during streaming. */
const lastMeasuredNotify = new Map<string, number>()

/** Record a measured row height; notifies only when it materially changed and
 *  not too often — a ±1 oscillation or a burst of re-measures during streaming
 *  must not push React past its "Maximum update depth exceeded" guard. */
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
  // The live estimate (fallback) tracks the streaming text exactly, while the
  // measured value can lag behind it (the measurement effect is debounced, and
  // the final measure can be skipped inside the debounce window). Taking the
  // max keeps the layout on the live height: never under-size a growing row,
  // which would keep old messages on screen and clip the newest text.
  return Math.max(fallback, measuredHeights.get(key) ?? 0)
}

/** A transcript row: a real item, or the todo steps block rendered under the task. */
type Row =
  | { type: 'item'; item: TranscriptItem }
  | { type: 'steps' }

/** The transcript content of one item (no key; the wrapper supplies it). */
function itemContent(item: TranscriptItem, expandReasoning: boolean): React.ReactNode {
  if (item.kind === 'assistant') return <MarkdownText text={item.text} />
  if (item.kind === 'reasoning') {
    return expandReasoning
      ? <Text dimColor>{item.text}</Text>
      : (<><Text color={theme.accent}>↓ Think</Text><Text dimColor> · {item.text.split('\n')[0]}</Text></>)
  }
  if (item.kind === 'tool') {
    return <Text color={item.text.startsWith('✓') ? theme.success : theme.secondary} wrap="wrap">{item.text}</Text>
  }
  return (
    <Text dimColor={item.dim} color={item.kind === 'user' ? theme.primary : undefined} wrap="wrap">
      {item.kind === 'user' ? `> ${item.text}` : item.text}
    </Text>
  )
}

/** A measured transcript item (wraps content, reports its real rendered height). */
function TranscriptItemView(props: { item: TranscriptItem; expandReasoning: boolean }): React.JSX.Element {
  const ref = React.useRef<DOMElement>(null)
  // useEffect (not useLayoutEffect): measuring after paint avoids setState-from-
  // commit-phase nested updates that trip React's update-depth guard.
  React.useEffect(() => {
    if (ref.current) setMeasuredHeight(String(props.item.key), measureElement(ref.current).height)
  }, [props.item.text])
  return <Box ref={ref} flexDirection="column">{itemContent(props.item, props.expandReasoning)}</Box>
}

/** A measured todo-steps block (rendered under the task). */
function StepsRow(props: { steps: readonly StepItem[] }): React.JSX.Element {
  const ref = React.useRef<DOMElement>(null)
  React.useEffect(() => {
    if (ref.current) setMeasuredHeight('steps', measureElement(ref.current).height)
  }, [props.steps])
  return <Box ref={ref} flexDirection="column"><StepsBlock steps={props.steps} /></Box>
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠸', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Animated braille spinner + pause hint while the agent is busy; the ~100ms
 *  tick re-renders only this component, so the screen keeps updating even when
 *  the session is quiet (model thinking / tool running). Stages: "Working · Esc
 *  to pause" → (after one Esc) "Working · Esc again to pause" → (after two Esc)
 *  "Paused". */
function BusyIndicator(props: { animate: boolean; paused: boolean }): React.JSX.Element | null {
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (!props.animate) return
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 100)
    return () => clearInterval(timer)
  }, [props.animate])
  if (props.paused) return <Text color={theme.warning}>⏸ Paused</Text>
  if (!props.animate) return null
  const armed = Date.now() - lastEscTime < 800
  return (
    <Text color={theme.info}>
      {SPINNER_FRAMES[frame]}
      <Text dimColor> Working · {armed ? 'Esc again to pause' : 'Esc to pause'}</Text>
    </Text>
  )
}

/** Ordered rows for the transcript window: items, with a steps block under the task. */
function buildRows(items: readonly TranscriptItem[], steps: readonly StepItem[]): Row[] {
  const out: Row[] = []
  let inserted = false
  for (const it of items) {
    out.push({ type: 'item', item: it })
    if (steps.length > 0 && !inserted && it.kind === 'user') { out.push({ type: 'steps' }); inserted = true }
  }
  if (steps.length > 0 && !inserted) out.push({ type: 'steps' })
  return out
}


/**
 * Dispatch one decoded key to the active panel or the conversation composer.
 * This replaces Ink's `useInput` (whose parser swallows Alt+Enter/Home/End and
 * appends SGR mouse bytes as literal text).
 */
function handleKey(k: RawKey): void {
  const panel = store.panel
  const char = k.char ?? ''
  if (panel === 'approval') {
    const approval = store.approval
    const decision = (): void => {
      if (approval === null) return
      const approve = char.toLowerCase() === 'a' || char.toLowerCase() === 'y'
      store.setApproval(null)
      approval.resolve(approve ? 'allowed-once' : 'rejected')
      cancelAction()
    }
    if (char.toLowerCase() === 'y' || char.toLowerCase() === 'a' || char.toLowerCase() === 'n') decision()
    else if (k.return) decision()
    else if (k.escape || (k.ctrl && char === 'c')) {
      store.setApproval(null)
      if (approval) approval.resolve('rejected')
      cancelAction()
    }
    return
  }
  if (panel === 'resume') {
    const sessions = store.sessions
    const sessionIndex = store.sessionIndex
    if (k.upArrow) store.bumpSessionIndex(-1)
    else if (k.downArrow) store.bumpSessionIndex(1)
    else if (k.return && sessions.length > 0) {
      submitMessage(`/resume ${sessions[sessionIndex]?.id}`)
      store.setPanel('conversation')
    }
    else if (k.escape) store.setPanel('conversation')
    return
  }
  if (panel === 'question') {
    const question = store.question
    if (question === null) { store.setPanel('conversation'); return }
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
      return
    }
    if (k.upArrow) store.bumpQuestionIndex(-1)
    else if (k.downArrow) store.bumpQuestionIndex(1)
    else if (k.return) {
      const options = question.item.options ?? []
      if (question.index < options.length && options[question.index]) {
        const label = options[question.index].label
        store.clearQuestion()
        question.resolve({ id: question.item.id, selected: [label] })
      } else {
        store.setQuestionCustom('', true) // the "Other" row -> type your own
      }
    }
    else if (k.escape || (k.ctrl && char === 'c')) {
      const rejectFn = question.reject; store.clearQuestion(); rejectFn(new Error('ask_user_question was cancelled'))
    }
    else if (char) {
      store.setQuestionCustom(char, true) // free-text answer
    }
    return
  }
  if (panel === 'connect') {
    if (store.keyDialog) {
      if (k.return) {
        const done = store.keyDialogDone()
        if (done !== null) keyDialogSubmit(done.provider, done.name, done.key)
      } else if (k.backspace || k.delete) {
        store.popSecret()
      } else if (k.escape || (k.ctrl && char === 'c')) {
        store.cancelKeyDialog()
      } else if (char) {
        store.pushSecret(char)
      }
      return
    }
    if (store.providerList) {
      if (k.upArrow) { store.bumpProviderListIndex(-1); return }
      if (k.downArrow) { store.bumpProviderListIndex(1); return }
      if (k.return) {
        const picked = store.selectProviderList()
        if (picked !== undefined) store.openKeyDialog(picked.provider, picked.name, picked.configured)
      } else if (k.escape || (k.ctrl && char === 'c')) {
        store.cancelProviderList()
      }
      return
    }
    if (store.providerForm) {
      if (store.providerField === 0 && (k.upArrow || k.downArrow)) {
        store.bumpProviderTemplate(k.upArrow ? -1 : 1)
        return
      }
      if (k.return) {
        if (store.providerFormAdvance()) {
          const values = store.providerValues
          store.cancelProviderForm()
          providerFormSubmit({
            route: values[0] ?? '',
            displayName: values[1] ?? '',
            baseURL: values[2] ?? '',
            apiKey: values[3] ?? '',
            models: (values[4] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''),
          })
        }
      } else if (k.backspace || k.delete) {
        store.providerFormBackspace()
      } else if (k.escape || (k.ctrl && char === 'c')) {
        store.cancelProviderForm()
      } else if (char) {
        store.providerFormType(char)
      }
      return
    }
    const secret = store.secret
    if (k.upArrow) { store.bumpModelIndex(-1); return }
    if (k.downArrow) { store.bumpModelIndex(1); return }
    if (k.return) {
      if (store.modelIndex === store.models.length) {
        // "＋ Add provider": pick a registered provider to set or change its API key.
        void openProviderList()
        return
      }
      if (store.modelIndex === store.models.length + 1) { store.startProviderForm(PROVIDER_TEMPLATES); return } // "＋ Add a custom provider"
      store.cancelConnect()
      const option = store.models[store.modelIndex]
      if (option !== undefined) modelsSaveAction(option.provider, option.model)
    } else if (k.escape || (k.ctrl && char === 'c')) {
      store.cancelConnect()
    }
    return
  }
  // conversation
  const input = store.input
  if (char === '\n' || k.altEnter) { resetHistoryBrowse(); store.insertAtCursor('\n'); return }
  if (k.return) {
    const text = input.trim()
    if (text === '') return
    store.setInput('')
    resetHistoryBrowse()
    store.scrollBottom()
    const filtered = filteredCommands()
    const effectiveIndex = filtered.length === 0 ? -1 : (store.commandIndex % filtered.length)
    if (text.startsWith('/') && filtered.length > 0 && effectiveIndex >= 0) {
      const chosen = filtered[effectiveIndex]
      const remainder = text.slice(chosen.name.length).trim()
      chosen.run(remainder)
    } else {
      submitMessage(text)
    }
    return
  }
  if (k.upArrow) {
    if (input.startsWith('/')) { store.bumpCommandIndex(-1); return } // command palette navigation
    if (historyBrowse !== -1) { browseOlder(); return } // browsing: keep going back
    if (input.includes('\n')) { store.moveCursorUp(); return } // multiline: caret moves between lines
    if (store.cursor > 0) { store.setCursor(0); return } // single-line: first Up goes to line start
    browseOlder() // already at line start: pull up the previous entry
    return
  }
  if (k.downArrow) {
    if (input.startsWith('/')) { store.bumpCommandIndex(1); return } // command palette navigation
    if (historyBrowse !== -1) { browseNewer(); return } // browsing: keep going forward
    if (input.includes('\n')) { store.moveCursorDown(); return } // multiline: caret moves between lines
    if (store.cursor < input.length) { store.setCursor(input.length); return } // single-line: first Down goes to line end
    browseNewer() // already at line end: pull up the next entry
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
      const sel = store.selection
      if (sel !== null) {
        const text = selectionText(sel.aRow, sel.aCol, sel.cRow, sel.cCol)
        const trimmed = text.trim()
        if (trimmed !== '') {
          writeClipboard(trimmed)
          store.append('status', `copied: ${trimmed.slice(0, 40)}${trimmed.length > 40 ? '…' : ''}`, true)
        }
      }
    }
    return
  }
  if (k.ctrl && char === 'u') { resetHistoryBrowse(); store.deleteToLineStart(); return }
  if (k.ctrl && char === 'p') { resetHistoryBrowse(); store.setCommandFilter(''); store.setInput('/'); return }
  if (k.tab) {
    if (input.startsWith('/')) { // command palette: accept the highlighted command
      const filtered = filteredCommands()
      const chosen = filtered.length === 0 ? undefined : filtered[store.commandIndex % filtered.length]
      if (chosen !== undefined) { resetHistoryBrowse(); store.setInput(`/${chosen.name} `); return }
    }
    const next = store.cyclePermission()
    const session = store.session
    if (session !== undefined) {
      try { setSandboxMode(session, next) } catch { /* best-effort */ }
    }
    return
  }
  if (k.escape) {
    store.clearSelection()
    if (input.startsWith('/')) { resetHistoryBrowse(); store.setInput(''); return } // close the command palette
    const now = Date.now()
    if (store.running && now - lastEscTime < 800) { lastEscTime = 0; pauseAgent() }
    else lastEscTime = now
    return
  }
  if (k.ctrl && char === 'c') { resetHistoryBrowse(); store.setInput(''); cancelAction(); return }
  if (k.backspace || k.delete) {
    resetHistoryBrowse()
    store.backspaceAtCursor()
    if (store.commandFilter.startsWith('')) store.setCommandFilter(store.input)
    return
  }
  if (char) {
    resetHistoryBrowse()
    store.insertAtCursor(char)
    if (store.input.startsWith('/')) store.setCommandFilter(store.input.slice(1))
  }
}

/** The terminal-owning app. */
export function App(props: { onSubmit(text: string): void; onCancel(): void }): React.JSX.Element {
  const { isRawModeSupported } = useStdin()
  // Plain force-render subscription to the store. This deliberately avoids
  // useSyncExternalStore: its passive-effect consistency check re-renders
  // DURING the effect flush whenever the store version changed between render
  // and flush, and under sustained streaming that during-flush re-render chain
  // trips React's "Maximum update depth exceeded" guard (dsh-tui.log is full of
  // it). The store already coalesces every burst into one microtask notify, so
  // a manual subscription renders exactly once per batch — no extra flushes.
  const [, forceRender] = React.useReducer((c: number) => c + 1, 0)
  React.useEffect(() => store.subscribe(() => forceRender()), [])
  const version = store.getVersion()
  const items = store.getItems()
  const steps = store.steps
  const stepsDone = store.stepsDone
  const stepsTotal = store.stepsTotal
  const input = store.input
  const panel = store.panel
  const commands = store.commands
  const filter = store.commandFilter
  const commandIndex = store.commandIndex
  const approval = store.approval
  const sessions = store.sessions
  const sessionIndex = store.sessionIndex
  const secret = store.secret
  const sessionIdText = sessionRef.current ? String(sessionRef.current) : ''
  const question = store.question
  const sidebarMin = store.sidebarMin
  const width = store.width
  const expandReasoning = store.expandReasoning
  const permissionLabel = store.permissionLabel
  const permissionColor = store.permissionColor
  const modelLabel = store.modelLabel
  // The width is a Store value updated by our own `stdout.on('resize')`
  // listener (see start()); Ink only re-renders the DOM on resize and would
  // otherwise keep the boot-time width. Reactive version -> App re-render.
  const showSidebar = width >= sidebarMin

  const filtered = useMemo(
    () => filteredCommands(),
    [commands, filter, version],
  )

  const isSlash = input.startsWith('/')
  const [hoverIndex, setHoverIndex] = useState(commandIndex)
  React.useEffect(() => setHoverIndex(commandIndex), [commandIndex])
  const effectiveIndex = filtered.length === 0 ? -1 : (hoverIndex % filtered.length)

  const status = isRawModeSupported ? '' : '(raw input unsupported) '

  const composerH = composerHeight(width, input, COMPOSER_MIN_HEIGHT)
  const modalH = panel === 'approval' ? 5
    : panel === 'resume' ? Math.min(10, sessions.length) + 4
    : panel === 'connect' ? 5
    : panel === 'question' ? (question?.item.options?.length ?? 3) + 3
    : 0
  const usable = convUsableWidth(width, showSidebar)
  // Steps now live inside the transcript (below the task), so the viewport is
  // the full conversation height; the steps row contributes to `content`.
  const viewportLines = convViewportLines(composerH, 0, modalH)
  const rows = useMemo(() => buildRows(items, steps), [items, steps, version])
  const layout = useMemo(() => {
    const hts = rows.map((r) =>
      r.type === 'steps'
        ? rowHeight('steps', stepsBlockHeight(steps.length))
        : rowHeight(String(r.item.key), estItemLines(r.item, usable, expandReasoning)))
    const starts: number[] = []
    let s = 0
    for (let i = 0; i < hts.length; i++) { starts.push(s); s += hts[i] + 1 }
    return { hts, starts, content: s - 1 }
  }, [rows, usable, expandReasoning, steps, version])
  const maxScroll = Math.max(0, layout.content - viewportLines)
  const effectiveScroll = store.followTail ? maxScroll : Math.max(0, Math.min(store.scroll, maxScroll))
  const topRow = 2 // conversation paddingY only (no pinned StepsBlock)
  store.setLayout(layout.content, viewportLines, effectiveScroll, topRow)
  // Line-precise scroll: the window is positioned with a negative margin so the
  // viewport aligns to `effectiveScroll`. Natural paragraph spacing is preserved
  // (content is never compressed); overflowing content is clipped by the
  // viewport. (The earlier "squeeze" was the markdown code-block wrap bug, fixed
  // by rendering code lines with wrap="truncate".)
  let first = 0
  while (first < rows.length && layout.starts[first] + layout.hts[first] <= effectiveScroll) first++
  if (first >= rows.length) first = Math.max(0, rows.length - 1)
  let last = rows.length - 1
  while (last >= 0 && layout.starts[last] >= effectiveScroll + viewportLines) last--
  if (first > last) first = Math.max(0, last)
  const shift = first < rows.length ? effectiveScroll - layout.starts[first] : 0
  const sel = store.selection
  const selRange = sel !== null ? composerSelectionRange(sel) : null

  const renderRow = (r: Row): React.ReactNode =>
    r.type === 'steps'
      ? <StepsRow key="steps" steps={steps} />
      : <TranscriptItemView key={r.item.key} item={r.item} expandReasoning={expandReasoning} />

  // During a mouse selection the transcript renders as flat rows so the
  // highlighted span can be drawn precisely (Markdown styling is suspended).
  const renderFlatTranscript = (): React.ReactNode => {
    if (sel === null) return null
    const tRows = buildTranscriptRows(items, usable, expandReasoning)
    const selRowMin = Math.min(sel.aRow, sel.cRow)
    const selRowMax = Math.max(sel.aRow, sel.cRow)
    const topCell = sel.aRow <= sel.cRow ? { row: sel.aRow, col: sel.aCol } : { row: sel.cRow, col: sel.cCol }
    const bottomCell = sel.aRow <= sel.cRow ? { row: sel.cRow, col: sel.cCol } : { row: sel.aRow, col: sel.aCol }
    const nodes: React.ReactNode[] = []
    for (let r = effectiveScroll; r < Math.min(effectiveScroll + viewportLines, tRows.length); r++) {
      const terminalRow = topRow + (r - effectiveScroll)
      const line = tRows[r]!.text
      if (terminalRow < selRowMin || terminalRow > selRowMax) {
        nodes.push(<Text key={r} dimColor wrap="wrap">{line}</Text>)
        continue
      }
      let cStart = 0
      let cEnd = line.length
      if (terminalRow === selRowMin) cStart = Math.min(colToChar(line, topCell.col - 2), line.length)
      if (terminalRow === selRowMax) cEnd = Math.min(colToChar(line, bottomCell.col - 2), line.length)
      if (terminalRow === selRowMin && terminalRow === selRowMax && cStart > cEnd) [cStart, cEnd] = [cEnd, cStart]
      nodes.push(
        <Text key={r} dimColor wrap="wrap">
          {line.slice(0, cStart)}
          <Text inverse>{line.slice(cStart, cEnd)}</Text>
          {line.slice(cEnd)}
        </Text>,
      )
    }
    return nodes
  }

  const renderComposerText = (): React.ReactNode => {
    const len = input.length
    const seg = (a: number, b: number, inv: boolean, k: string): React.ReactNode =>
      a < b ? <Text key={k} inverse={inv}>{input.slice(a, b)}</Text> : null
    // The caret is drawn by the REAL terminal cursor (parked at the composer
    // caret by the patched Ink frame writer), not by a React-drawn block — a
    // React cursor blinks via setInterval, forcing a whole re-render twice a
    // second, and macOS Terminal anchors the IME candidate window to the real
    // cursor anyway.
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

  // The connect dialog replaces the whole screen (opencode-style modal), so it
  // must be the only thing rendered — the overlay needs the full terminal
  // either way, and replacing the tree keeps the layout trivially centered.
  if (panel === 'connect') {
    return <ModelsDialog masked={'•'.repeat(secret.length)} models={store.models} modelIndex={store.modelIndex} keyDialog={store.keyDialog} keyDialogName={store.keyDialogName} keyDialogConfigured={store.keyDialogConfigured} providerForm={store.providerForm} providerField={store.providerField} providerTemplates={store.providerTemplates} providerTemplate={store.providerTemplate} providerValues={store.providerValues} providerFormError={store.providerFormError} providerList={store.providerList} providerListIndex={store.providerListIndex} providerNames={store.providerNames} dialogNotice={store.dialogNotice} />
  }

  return (
    <Box flexDirection="column" height={store.rows}>
      <Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="row" width="100%">
        <Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          {items.length === 0
            ? <Text dimColor>Start typing to begin a session. Type <Text color={theme.primary}>/</Text> for commands.</Text>
            : sel !== null
              ? (
                <Box flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden" flexDirection="column">
                  {renderFlatTranscript()}
                </Box>
              )
              : (
                <Box flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden" flexDirection="column">
                  <Box marginTop={-shift} flexDirection="column" gap={1}>
                    {rows.slice(first, last + 1).map(renderRow)}
                  </Box>
                </Box>
              )}
        </Box>
        {showSidebar && (
        <Box borderStyle="round" borderColor={theme.border} width="30%" flexShrink={1} minHeight={0} flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          <Text color={theme.accent} bold>Steps {stepsTotal > 0 ? `${stepsDone}/${stepsTotal}` : ''}</Text>
          {steps.length === 0
            ? <Text dimColor>no plan yet</Text>
            : <StepRows steps={steps} />}
          <Text dimColor>session {sessionIdText}</Text>
          <Box flexGrow={1} />
          <Text dimColor>dsh-tui {APP_VERSION}</Text>
        </Box>
        )}
      </Box>

      {/* Modals render below the conversation and above the input dock, so a
          prompt (e.g. a user decision) sits right where you answer it. */}
      {panel === 'approval' && approval && <ApprovalDialog approval={approval} />}
      {panel === 'resume' && <ResumePicker sessions={sessions} index={sessionIndex} />}
      {panel === 'question' && question && <QuestionPanel question={question} />}

      {isSlash && filtered.length > 0 && (
        <Box borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1}>
          {filtered.map((c, i) => (
            <Text key={c.name} color={i === effectiveIndex ? theme.accent : undefined} inverse={i === effectiveIndex}>
              /{c.name} — {c.hint}
            </Text>
          ))}
        </Box>
      )}

      {/* Composer: input text pinned to the top edge, permission + model bar
          pinned to the bottom edge; grows with wrapped content. */}
      <Box flexShrink={0} borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column" justifyContent="space-between"
        height={composerHeight(width, input, COMPOSER_MIN_HEIGHT)}>
        <Text color={theme.text} wrap="wrap">{status}{renderComposerText()}</Text>
        <Box flexDirection="row" gap={2} paddingY={1} marginTop={1}>
          <Text color={permissionColor}>🔒 {permissionLabel} (Tab)</Text>
          {modelLabel !== '' && <Text dimColor>Model: {modelLabel}</Text>}
        </Box>
      </Box>

      {/* Status bar: workspace left, busy indicator center, command hint right. */}
      <Box flexShrink={0} flexDirection="row" borderStyle="round" borderColor={theme.border} paddingX={1} justifyContent="space-between">
        <Text dimColor wrap="truncate">{store.workspace}</Text>
        <Box flexGrow={1} justifyContent="center">
          <BusyIndicator animate={store.running} paused={store.paused} />
        </Box>
        <Text dimColor>ctrl+p commands</Text>
      </Box>
    </Box>
  )
}

/** Composer minimum height (rows); with the bottom bar's padding + margin this
 *  leaves a single row between the input text and the Workspace Write bar. */
const COMPOSER_MIN_HEIGHT = 5

/** Rows scrolled per mouse-wheel tick. */
const WHEEL_STEP = 3

/** Height of the composer: at least `min` rows, growing with wrapped input lines. */
function composerHeight(width: number, input: string, min: number): number {
  const usable = Math.max(10, width - 4)
  // Wrap by VISUAL width (CJK/emoji count as two columns, via string-width —
  // the same rule Ink uses). A code-unit count under-estimates Chinese input's
  // wrapped rows by up to 2x, so the composer box would lag the real text
  // height, clip/overflow the border and shift the whole layout at the wrong
  // keystroke — the worst flicker while typing Chinese.
  const wrapped = input.split('\n').reduce((sum, seg) => sum + Math.max(1, Math.ceil(visualWidth(seg) / usable)), 0)
  const cap = Math.max(min, Math.floor(store.rows * 0.4))
  return Math.min(min + wrapped - 1, cap)
}

/** Estimated rendered rows for one transcript item at the conversation width. */
function estItemLines(item: TranscriptItem, usable: number, expandReasoning: boolean): number {
  if (item.kind === 'reasoning') return expandReasoning ? countWrappedLines(item.text, usable) : 1
  if (item.kind === 'assistant') return estimateMarkdownHeight(item.text, usable)
  return countWrappedLines(item.text, usable)
}

/** Usable text columns for the conversation area (sidebar optional). */
function convUsableWidth(width: number, showSidebar: boolean): number {
  const sidebar = showSidebar ? Math.round(width * 0.3) + 2 : 0
  return Math.max(20, width - 2 - sidebar)
}

/** Rows the transcript viewport can display given the surrounding fixed parts. */
function convViewportLines(composerH: number, stepsH: number, modalH: number): number {
  return Math.max(3, store.rows - composerH - 3 /* status bar: border + row */ - 2 /* conversation paddingY */ - stepsH - modalH)
}

/** In-band approval prompt over a pending tool call. */
/** In-band approval prompt over a pending tool call. */
function ApprovalDialog(props: { approval: PendingApproval }): React.JSX.Element {
  const { req } = props.approval
  return (
    <Box borderStyle="double" borderColor={theme.warning} flexDirection="column" paddingX={1} paddingY={1}>
      <Text color={theme.warning} bold>Approval required</Text>
      <Text>tool: <Text color={theme.secondary}>{req.toolName}</Text>{req.callId ? ` (#${req.callId})` : ''}</Text>
      {req.reason ? <Text wrap="wrap">{req.reason}</Text> : null}
      <Text dimColor>y / a = allow this call once · n / Esc = reject</Text>
    </Box>
  )
}

/** Select a persisted session to resume. */
function ResumePicker(props: { sessions: SessionSummary[]; index: number }): React.JSX.Element {
  const { sessions, index } = props
  return (
    <Box borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1} paddingY={1}>
      <Text color={theme.accent} bold>Resume a session</Text>
      {sessions.map((s, i) => (
        <Text key={String(s.id)} color={i === index ? theme.accent : undefined} inverse={i === index}>
          {String(s.id)} · {s.label}· {s.cwd ?? ''}
        </Text>
      ))}
      <Text dimColor>↑/↓ move · Enter resume · Esc cancel</Text>
    </Box>
  )
}

/** The add-provider form's fields, in entry order (field 1 is the template dropdown). */
const PROVIDER_FORM_FIELDS: readonly string[] = [
  'route id (kebab-case)',
  'display name',
  'base URL',
  'API key',
  'model ids (comma-separated)',
]

/**
 * The `/models` dialog, matching the harness Settings → Models page's core
 * controls in a TUI: a provider/model picker (↑/↓), the API-key status with a
 * masked input, an "＋ Add provider" entry leading to a sequential form
 * (route / display name / base URL / API key / model ids), and Enter to save.
 * Rendered as an opencode-style dialog that REPLACES the whole screen: a
 * full-terminal backdrop with a centered bordered box. (Ink Boxes cannot
 * paint a background — only Text can — so the backdrop is a wrapping run of
 * spaces with the page color; it is the absolute first child, whose static
 * position is the layout origin, so it covers the screen without offsets.)
 * The input shows a blinking block cursor (React-drawn; the real terminal
 * cursor stays hidden while the dialog is open, see installFrameSuffix). Key
 * input needs no IME, so a React cursor is fine here unlike the composer.
 */
function ModelsDialog(props: {
  masked: string
  models: readonly ModelsOption[]
  modelIndex: number
  keyDialog: boolean
  keyDialogName: string
  keyDialogConfigured: boolean
  providerForm: boolean
  providerField: number
  providerTemplates: readonly ProviderTemplate[]
  providerTemplate: number
  providerValues: readonly string[]
  providerFormError: string
  providerList: boolean
  providerListIndex: number
  providerNames: readonly { provider: string; name: string; configured: boolean }[]
  dialogNotice: string
}): React.JSX.Element {
  const [cursorOn, setCursorOn] = React.useState(true)
  React.useEffect(() => {
    const timer = setInterval(() => setCursorOn((on) => !on), 530)
    return () => clearInterval(timer)
  }, [])
  const block = <Text inverse={cursorOn}> </Text>
  const fieldCount = PROVIDER_FORM_FIELDS.length + 1 // +1 = the template dropdown
  return (
    <Box flexDirection="column" height={store.rows} alignItems="center" justifyContent="center">
      <Box position="absolute" width="100%" height={store.rows} flexDirection="column">
        <Text backgroundColor={theme.bg} wrap="wrap">{' '.repeat(Math.max(0, store.width * store.rows))}</Text>
      </Box>
      <Box width={72} borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1} paddingY={1}>
        {props.keyDialog ? (
          <>
            <Text color={theme.accent} bold>API key for {props.keyDialogName}</Text>
            <Text color={theme.primary}>{props.masked}{block}</Text>
            <Text dimColor>{props.keyDialogConfigured ? 'replaces the current key · ' : ''}paste a single-line key · Enter save · Esc cancel</Text>
          </>
        ) : props.providerList ? (
          <>
            <Text color={theme.accent} bold>Add provider</Text>
            <Text dimColor>pick a provider to set or change its API key</Text>
            <Box flexDirection="column" gap={0}>
              {(() => {
                // The catalog lists dozens of providers: render only the rows
                // that fit the dialog, scrolled so the highlighted row stays
                // in view (centered when possible).
                const names = props.providerNames
                const listRows = Math.max(1, store.rows - 8)
                const start = Math.max(0, Math.min(
                  props.providerListIndex - Math.floor(listRows / 2),
                  Math.max(0, names.length - listRows),
                ))
                return names.slice(start, start + listRows).map((p, i) => {
                  const index = start + i
                  return (
                    <Text key={p.provider} color={index === props.providerListIndex ? theme.accent : undefined} inverse={index === props.providerListIndex}>
                      {index === props.providerListIndex ? '› ' : '  '}{p.name}
                      <Text dimColor>  </Text>
                      <Text color={p.configured ? theme.success : theme.warning}>{p.configured ? '✓ key set' : 'no key'}</Text>
                    </Text>
                  )
                })
              })()}
            </Box>
            <Text dimColor>↑/↓ choose · Enter select · Esc back</Text>
          </>
        ) : props.providerForm ? (
          <>
            <Text color={theme.accent} bold>Add a custom provider</Text>
            <Text color={props.providerField === 0 ? theme.primary : undefined}>
              1/{fieldCount} provider: {props.providerTemplate < props.providerTemplates.length
                ? props.providerTemplates[props.providerTemplate]?.name ?? ''
                : 'Custom provider'}
              {props.providerField === 0 ? block : null}
            </Text>
            {PROVIDER_FORM_FIELDS.map((label, i) => {
              const field = i + 2
              return (
                <Text key={label} color={field === props.providerField ? theme.primary : undefined}>
                  {field}/{fieldCount} {label}: {props.providerValues[i] ?? ''}
                  {field === props.providerField ? block : null}
                </Text>
              )
            })}
            {props.providerFormError !== '' && <Text color={theme.error}>{props.providerFormError}</Text>}
            <Text dimColor>↑/↓ choose provider · type fields · Enter next · Enter on last saves · Esc cancel</Text>
          </>
        ) : (
          <>
            <Text color={theme.accent} bold>Models</Text>
            <Text dimColor>current: {props.modelIndex < props.models.length ? props.models[props.modelIndex]?.label ?? '' : '＋ Add provider'}</Text>
            <Box flexDirection="column" gap={0}>
              {props.models.map((m, i) => (
                <Text key={`${m.provider}/${m.model}`} color={i === props.modelIndex ? theme.accent : undefined} inverse={i === props.modelIndex}>
                  {i === props.modelIndex ? '› ' : '  '}{m.label}
                </Text>
              ))}
              <Text color={props.modelIndex === props.models.length ? theme.accent : undefined} inverse={props.modelIndex === props.models.length}>
                {props.modelIndex === props.models.length ? '› ' : '  '}＋ Add provider
              </Text>
              <Text color={props.modelIndex === props.models.length + 1 ? theme.accent : undefined} inverse={props.modelIndex === props.models.length + 1}>
                {props.modelIndex === props.models.length + 1 ? '› ' : '  '}＋ Add a custom provider
              </Text>
            </Box>
            {props.dialogNotice !== '' && <Text color={theme.warning}>{props.dialogNotice}</Text>}
            <Text dimColor>↑/↓ choose · Enter save · Esc cancel</Text>
          </>
        )}
      </Box>
    </Box>
  )
}

/** In-band user decision (ask_user_question): a menu of options plus a typeable "Other". */
function QuestionPanel(props: { question: PendingQuestion }): React.JSX.Element {
  const { item, index, custom, customMode } = props.question
  const options = item.options ?? []
  return (
    <Box borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1} paddingY={1} gap={1}>
      <Text color={theme.accent} bold>Question</Text>
      <Text wrap="wrap">{item.question}</Text>
      {item.detail ? <Text dimColor wrap="wrap">{item.detail}</Text> : null}
      {customMode ? (
        <Text color={theme.primary}>Your answer: {custom || ''}</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {options.map((opt, i) => (
            <Text key={i} color={i === index ? theme.accent : undefined} inverse={i === index}>
              {i === index ? '› ' : '  '}{opt.label}{opt.description ? ` — ${opt.description}` : ''}
            </Text>
          ))}
          <Text color={options.length === index ? theme.accent : undefined} inverse={options.length === index}>
            {options.length === index ? '› ' : '  '}✎ Other…
          </Text>
        </Box>
      )}
      <Text dimColor>{customMode ? 'type your answer · Enter confirm · Esc cancel' : '↑/↓ move · Enter select · Esc cancel'}</Text>
    </Box>
  )
}

/** Status marker and colour for each step. */
const STEP_ICON: Record<StepItem['status'], string> = { completed: '✓', in_progress: '→', pending: '·' }
const STEP_COLOR: Record<StepItem['status'], string | undefined> = { completed: theme.success, in_progress: theme.info, pending: undefined }

/** A list of step rows (capped for the terminal, with a suffix for the rest). */
function StepRows(props: { steps: readonly StepItem[] }): React.JSX.Element {
  const visible = props.steps.slice(0, 12)
  return (
    <Box flexDirection="column" gap={1}>
      {visible.map((s, i) => (
        <Text key={i} color={STEP_COLOR[s.status]} wrap="wrap">
          {STEP_ICON[s.status]} {s.content}
        </Text>
      ))}
      {props.steps.length > visible.length && <Text dimColor>… +{props.steps.length - visible.length} more</Text>}
    </Box>
  )
}

/** The pinned step-plan block shown at the top of the conversation. */
function StepsBlock(props: { steps: readonly StepItem[] }): React.JSX.Element {
  const done = props.steps.filter((s) => s.status === 'completed').length
  return (
    <Box borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1} paddingY={1} gap={1}>
      <Text color={theme.accent} bold>Steps {done}/{props.steps.length}</Text>
      <StepRows steps={props.steps} />
    </Box>
  )
}

/** Process-facing effects: the launcher's bounded exit request. */
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

/** Flatten the models service's providers into picker options (one per model). */
function buildModelOptions(providers: readonly ModelsProviderOption[]): ModelsOption[] {
  return providers.flatMap((p) =>
    p.models.map((m) => ({ provider: p.provider, model: m.id, label: `${p.name} · ${m.name}` })),
  )
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
export function apply(ctx: Context, config: Config): void {
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

/** Install the per-frame suffix hook the patched Ink frame writer (see
 *  apps/tui-bin/build.mjs) appends to every full-screen frame it writes: it
 *  re-shows the REAL terminal cursor and parks it at the composer caret, so the
 *  macOS IME composition/candidate window — which anchors to the real cursor —
 *  stays at the input position instead of jumping on every redraw while typing
 *  Chinese. Called once at startup; exported so the headless verification can
 *  exercise the same wiring. */
export function installFrameSuffix(): void {
  const frameSuffix = (): string => {
    // While the connect dialog is open the composer sits under the overlay
    // backdrop, so parking the real cursor there would show it mid-backdrop;
    // the dialog input is drawn as masked dots, so hide the cursor instead.
    if (store.panel === 'connect') return '\x1b[?25l'
    const cell = composerCaretCell()
    return `\x1b[?25h${cell === null ? '' : `\x1b[${cell.row};${cell.col}H`}`
  }
  ;(globalThis as unknown as { __dshTuiFrameSuffix?: () => string }).__dshTuiFrameSuffix = frameSuffix
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

  const resumeId = config.resume
  const handle = resumeId === undefined
    ? await agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: config.workspace },
        agentOptions,
        setup,
      })
    : await agents.resume({ resumeSessionId: SessionId(resumeId), agentOptions, setup })
  const { agent } = handle
  const sessionId = agent.session.id
  sessionRef.current = sessionId
  store.setSession(agent.session)
  // No API key -> surface "not set" in the composer; with a key,
  // show the model name.
  const modelLabel = (await apiKeyConfigured(ctx)) ? modelDisplayName(agentOptions.model) : 'not set'
  store.setModelLabel(modelLabel)

  store.append('status', `Session ${sessionId} in ${config.workspace}`, true)

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
        const joined = event.data.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        if (joined === '') break
        const tail = store.getItems().at(-1)
        if (tail?.kind === 'assistant') break
        store.append('assistant', joined)
        break
      }
      // The model's step-by-step plan and progress: latest write wins (sidebar
      // Steps + pinned block). The tool rows below are separate.
      case 'todo/write': {
        const todos = event.data.todos
        if (todos.length > 0) store.setSteps(todos)
        break
      }
      // Tool calls/results shown inline like opencode (icon + name rows).
      case 'tool/call': {
        store.toolCall(event.data.name)
        break
      }
      case 'tool/result': {
        store.toolResult()
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

  // Wire the slash commands (built after the agent exists).
  const commandItems: CommandItem[] = [
    { name: 'help', hint: 'show this help', run: () => { store.append('status', '/help · /think · /models · /compact · /clear · /resume · /sidebar · /exit', true) } },
    { name: 'models', hint: 'manage models and the API key', run: () => {
      if (modelsService === undefined) {
        store.append('status', 'models: service unavailable', true)
        return
      }
      void modelsService.listConfigured().then((providers) => {
        const options = buildModelOptions(providers)
        store.openModels(options, Math.max(0, options.findIndex((o) => o.provider === selection.provider && o.model === selection.model)))
      })
    } },
    { name: 'think', hint: 'expand/collapse the Think (reasoning) text', run: () => { store.toggleReasoning() } },
    { name: 'compact', hint: 'compact the session history', run: () => { void compact(ctx, agent, sessionId, selection.provider, selection.model, io) } },
    { name: 'clear', hint: 'clear the transcript', run: () => { store.clear() } },
    {
      name: 'resume',
      hint: 'pick a persisted session',
      run: () => { void loadSessions(ctx).then((list) => store.setSessions(list)) },
    },
    {
      name: 'sidebar',
      hint: 'show/hide threshold for the right sidebar',
      run: (arg) => {
        if (arg.trim() === '') {
          store.append('status', `sidebar min width: ${store.sidebarMin} columns (default 110, ~/.dsh/dsh-tui.json)`, true)
          return
        }
        const n = Number(arg)
        if (!Number.isFinite(n) || n < 0) {
          store.append('status', `sidebar: invalid width "${arg}"`, true)
          return
        }
        store.setSidebarMin(n)
        store.append('status', `sidebar min width set to ${n} columns (saved to ~/.dsh/dsh-tui.json)`, true)
      },
    },
    { name: 'exit', hint: 'quit dsh-tui', run: () => { requestExit(io, 0) } },
  ]
  store.setCommands(commandItems)

  submitMessage = (text) => {
    if (inputHistory.at(-1) !== text) {
      inputHistory.push(text)
      if (inputHistory.length > 100) inputHistory.shift()
    }
    resetHistoryBrowse()
    store.setPaused(false) // any new message resumes; the model decides what to do
    store.append('user', text)
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  }
  cancelAction = () => { /* nothing: keep the session open */ }
  const modelsService = ctx.get('tuiModels') as TuiModelsService | undefined
  modelsSaveAction = (provider: string, model: string) => {
    // The mutable selection ref is read per request by prompt assembly, so
    // updating it switches the LIVE agent's next request to the new model
    // (the same mechanism the web Models page uses); saveSelection persists
    // the default for future runs.
    selected.current = { provider, model }
    void defaultModel.saveSelection({ provider, model }).catch(() => { /* best-effort persist */ })
    void apiKeyConfigured(ctx).then(ok => store.setModelLabel(ok ? modelDisplayName(model) : 'not set'))
    store.append('status', `models: ${provider} · ${modelDisplayName(model)}`, true)
  }
  openProviderList = () => {
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
  keyDialogSubmit = (provider: string, name: string, key: string) => {
    if (modelsService === undefined) return
    void modelsService.setKey(provider, key).then((result) => {
      if (!result.ok) {
        store.append('status', `models: ${result.error}`, true)
        return
      }
      store.append('status', `models: API key saved for ${name}`, true)
      // Activating a dormant catalog route registers asynchronously (settings
      // write → adapter hot re-register), and its model list only resolves
      // once the route is registered, so poll until the picker can show it.
      const refresh = (attempts: number): void => {
        void modelsService.listConfigured().then((providers) => {
          const options = buildModelOptions(providers)
          if (options.some((o) => o.provider === provider) || attempts <= 0) {
            store.openModels(options, Math.max(0, options.findIndex((o) => o.provider === provider)))
            return
          }
          setTimeout(() => refresh(attempts - 1), 120)
        })
      }
      refresh(25)
    })
  }
  providerFormSubmit = (input: AddProviderInput) => {
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
        const options = buildModelOptions(modelsService.listProviders())
        if (options.some((o) => o.provider === input.route.trim()) || attempts <= 0) {
          store.openModels(options, Math.max(0, options.findIndex((o) => o.provider === input.route.trim())))
          store.append('status', `models: provider ${input.route.trim()} added`, true)
          return
        }
        setTimeout(() => refresh(attempts - 1), 120)
      }
      refresh(10)
    })
  }
  pauseAgent = () => {
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    store.setPaused(true)
  }
  store.setWorkspace(config.workspace)
  ctx.on('agent/status', (payload: { agent: { id: SessionId }; status: 'idle' | 'running' }) => {
    if (payload.agent.id !== sessionId) return
    if (payload.status === 'running') lastEscTime = 0 // fresh turn: clear a stale single-Esc window
    store.setRunning(payload.status === 'running')
  })

  // Enable raw mode so the terminal owns no input processing; the TERMINAL
  // keeps its native mouse behavior (plain-drag selection / wheel scrollback).
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
  installFrameSuffix()

  const app = render(<App
    onSubmit={submitMessage}
    onCancel={cancelAction}
  />)

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

  if (resumeId === undefined && config.resume === undefined) {
    void loadSessions(ctx).then((list) => store.setSessions([] as SessionSummary[])).catch(() => {})
  }

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
function positionCursorByMouse(row: number, col: number): void {
  const index = composerInputIndex(row, col)
  if (index !== null) store.setCursor(index)
}

/** Input character index under a terminal cell inside the composer, or null. */
function composerInputIndex(row: number, col: number): number | null {
  const width = process.stdout.columns ?? 80
  const height = process.stdout.rows ?? 24
  const composerH = composerHeight(width, store.input, COMPOSER_MIN_HEIGHT)
  const composerTop = height - composerH - STATUS_BAR_HEIGHT + 1
  const inRow = row - composerTop // 0-based row within the composer (0 = top border)
  const usable = Math.max(10, width - 4)
  const visualStarts: number[] = []
  for (let i = 0; i <= store.input.length; i++) {
    if (i === 0 || store.input[i - 1] === '\n') visualStarts.push(i)
  }
  const lineAt = (start: number): string => {
    const nl = store.input.indexOf('\n', start)
    return store.input.slice(start, nl === -1 ? store.input.length : nl)
  }
  // Wrapping is counted by visual width, not code units: Chinese lines wrap at
  // half the characters the composer's box width would suggest.
  const inputRows = visualStarts.reduce((sum, start) => sum + Math.max(1, Math.ceil(visualWidth(lineAt(start)) / usable)), 0)
  const clickRow = inRow - 1 // after the top border
  if (clickRow < 0 || clickRow >= inputRows) return null
  let acc = 0
  for (const start of visualStarts) {
    const line = lineAt(start)
    const visLines = Math.max(1, Math.ceil(visualWidth(line) / usable))
    if (clickRow < acc + visLines) {
      // Map the clicked terminal column to a character index, counting wide
      // (CJK) characters as two columns (mirrors colToChar).
      return start + colToChar(line, Math.max(0, col - 3))
    }
    acc += visLines
  }
  return null
}

/** Terminal cell (1-based row/col) of the composer caret, or null when the
 *  composer has no laid-out position. Used to park the REAL terminal cursor at
 *  the caret: macOS Terminal anchors the IME composition/candidate window to
 *  that cursor, so keeping it at the input position stops the candidate window
 *  from jumping on every redraw while typing Chinese. */
function composerCaretCell(): { row: number; col: number } | null {
  const width = process.stdout.columns ?? 80
  const height = process.stdout.rows ?? 24
  const composerH = composerHeight(width, store.input, COMPOSER_MIN_HEIGHT)
  const composerTop = height - composerH - STATUS_BAR_HEIGHT + 1
  const usable = Math.max(10, width - 4)
  const caret = Math.max(0, Math.min(store.cursor, store.input.length))
  // Visual (row, col) of the caret inside the input text (rows count wrapping):
  // each '\n'-separated segment occupies ceil(visualWidth/usable) rows, and the
  // caret's own segment wraps again at `usable` columns within the segment
  // (mirrors composerInputIndex, the inverse mouse-click mapping).
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
  // Composer layout: top border at `composerTop`, input text starts on the next
  // row; text column 0 sits at terminal column 3 (border at 1, paddingX at 2).
  return { row: composerTop + 1 + visRow, col: 3 + visCol }
}

/** The composer-input offset range covered by a mouse selection, or null. */
function composerSelectionRange(sel: { aRow: number; aCol: number; cRow: number; cCol: number }): { start: number; end: number } | null {
  const a = composerInputIndex(sel.aRow, sel.aCol)
  const c = composerInputIndex(sel.cRow, sel.cCol)
  if (a === null && c === null) return null
  const start = a === null ? 0 : c === null ? a : Math.min(a, c)
  const end = a === null ? (c ?? 0) : c === null ? store.input.length : Math.max(a, c)
  if (start >= end) return null
  return { start, end }
}

/** The status bar height in terminal rows (bordered single-line bar). */
const STATUS_BAR_HEIGHT = 3

/** Estimated StepsBlock height (rows); shared by the viewport and mouse mapping. */
function stepsBlockHeight(count: number): number {
  return count > 0 ? Math.min(12, 5 + 2 * count) : 0
}

/** One flat visual row of the transcript (selection model). */
interface TranscriptRow { readonly text: string; readonly itemIndex: number }

/** Wrap `text` into visual rows at most `usable` columns wide. */
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

/** Flat visual rows of the whole transcript, mirroring the rendered layout (gap row between items). */
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
    for (const line of wrapRows(plain, usable)) rows.push({ text: line, itemIndex: i })
  })
  return rows
}

/** Map a terminal column into a character index within `line` (wide chars count twice). */
function colToChar(line: string, col: number): number {
  let w = 0
  for (let i = 0; i < line.length; i++) {
    const cw = visualWidth(line[i]!)
    if (w + cw > col) return i
    w += cw
  }
  return line.length
}

/** The plain text between two mouse cells (transcript rows + composer input), for clipboard copy. */
function selectionText(aRow: number, aCol: number, cRow: number, cCol: number): string {
  const width = process.stdout.columns ?? 80
  const height = process.stdout.rows ?? 24
  const input = store.input
  const composerH = composerHeight(width, input, COMPOSER_MIN_HEIGHT)
  const composerTop = height - composerH - STATUS_BAR_HEIGHT + 1
  const usable = convUsableWidth(width, store.width >= store.sidebarMin)
  const rows = buildTranscriptRows(store.getItems(), usable, store.expandReasoning)
  const joined = rows.map((r) => r.text).join('\n')
  const inputStart = joined.length + 1 // '\n' separator before the composer input
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
    return rowPrefix[flat]! + Math.min(colToChar(line, col - 2), line.length)
  }
  const a = cellIndex(aRow, aCol)
  const c = cellIndex(cRow, cCol)
  if (a === null || c === null) return ''
  return `${joined}\n${input}`.slice(Math.min(a, c), Math.max(a, c))
}

/** Write `text` to the system clipboard via OSC 52 (VTE supports set-clipboard). */
function writeClipboard(text: string): void {
  process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x1b\\`)
}

/** List persisted sessions (most recent first) for the resume picker. */
async function loadSessions(ctx: Context): Promise<SessionSummary[]> {
  const persistence = ctx.get('sessionPersistence') as { list?: (signal?: AbortSignal) => Promise<Array<{ id: SessionId; cwd?: string; createdAt?: number }>> } | undefined
  if (persistence?.list === undefined) return []
  const headers = await persistence.list()
  return headers
    .map((h) => ({ id: h.id, label: `@${new Date(h.createdAt ?? 0).toLocaleString()}`, cwd: h.cwd }))
    .sort((a, b) => (b.id === a.id ? 0 : a.id.valueOf() < b.id.valueOf() ? 1 : -1))
    .slice(0, 40)
}

/**
 * The user-questions answerer: present each of the model's questions in-band
 * and return the human's answer. Single-select options plus a typeable
 * "Other" row; if only one question is asked this is a one-step decision.
 * @param request - the ask_user_question request.
 * @returns the structured answer.
 */
async function askUser(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
  const answers: AskUserQuestionAnswerItem[] = []
  for (const item of request.questions) {
    const answer = await new Promise<AskUserQuestionAnswerItem>((resolve, reject) => {
      // An abort (tool/step cancelled) must reject the pending ask.
      if (request.signal?.aborted) {
        reject(new Error('ask_user_question was cancelled'))
        return
      }
      store.setQuestion({ item, resolve, reject, index: 0, custom: '', customMode: false })
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

/** Best-effort manual history compaction; report failures as status. */
async function compact(ctx: Context, agent: unknown, sessionId: SessionId, provider: string, model: string, io: TuiIo): Promise<void> {
  const compaction = ctx.get('compaction') as { compactNow?: (args: unknown, signal: AbortSignal, commandId: string) => Promise<unknown> } | undefined
  if (compaction?.compactNow === undefined) {
    store.append('status', 'compaction service unavailable', true)
    return
  }
  try {
    const result = await compaction.compactNow(
      { agent, session: sessionId, route: { provider, model } },
      new AbortController().signal,
      `tui-${randomUUID()}`,
    )
    store.append('status', result === null ? 'compaction: nothing to compact' : 'compaction: done', true)
  } catch (error) {
    store.append('status', `compaction: ${error instanceof Error ? error.message : String(error)}`, true)
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
