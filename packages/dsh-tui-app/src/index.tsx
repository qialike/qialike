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
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { type AddProviderInput, type ModelsProviderOption, type ProviderTemplate, type TuiModelsService } from './models.ts'
import { reasoningEffortName, type TuiProviderTemplate } from './llm.ts'
import { emptySessionStats, createSessionStatsFolding, type SessionStats, type SessionStatsFolding } from './session-stats.ts'

import { readHiddenProviders, readSidebarMode, resolveResumeLast, setHiddenProviders, setSidebarMode as persistSidebarMode, type SidebarMode } from './config.ts'
import { isPinned, prewarmTitles, rememberTitle, type SessionHeaderLike, type SessionTitlesPersistence } from './session-titles.ts'
import { lastActivity, touchSession } from './session-activity.ts'
import { theme, type ThemePalette } from './theme.ts'
import { StdinDecoder, type RawKey } from './stdin.ts'
import { initCharWidthCalibration } from './charwidth.ts'
import { initErrorLog, logError, logConsoleError, logErrorFileOnly } from './log.ts'
import pkg from '../../../package.json' with { type: 'json' }

/** Stable Cordis plugin name. */
export const name = 'tui-runtime'

/** Project version (single source of truth: the root package.json). */
export const APP_VERSION = (pkg as { version?: string }).version ?? '0.0.0'

/** Footer suffix appended ONLY when beta is forced by `DSH_TUI_BETA=1` on a
 *  plain (non-prerelease) version. A version that already spells it out
 *  (`0.2.2-beta`) shows as-is — no redundant " beta" word (GitHub semver
 *  convention). */
export const BETA_FOOTER_SUFFIX = process.env.DSH_TUI_BETA?.trim() === '1' ? ' beta' : ''

/** Core services required before the terminal session can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'tuiModels', 'workspaceRegistry']

/** Best-effort: attach a session to the workspace that owns `workspace` (the
 *  web groups sessions by workspaceId; a session created with only `meta.cwd`
 *  is otherwise listed as "Ungrouped"). The tui profile mounts the workspace
 *  registry (see cordis.patch.yml); a path or registry mismatch never takes
 *  the TUI down. Retries because a just-created session's header may not be
 *  persisted/indexed the instant the agent handle resolves. */
async function attachSessionToWorkspace(ctx: unknown, workspace: string, sessionId: string): Promise<void> {
  try {
    const wr = (ctx as { workspaceRegistry?: { resolveByPath(p: string): Promise<{ attachSession(id: string): Promise<void> } | undefined> } }).workspaceRegistry
    const ws = await wr?.resolveByPath(workspace)
    if (ws !== undefined) {
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          await ws.attachSession(sessionId)
          logErrorFileOnly('attach', `attached session ${sessionId} (cwd ${workspace})`)
          return
        } catch (error) {
          if (attempt === 11) logErrorFileOnly('attach', `workspace attach failed: ${String(error)}`)
          else await new Promise<void>((resolve) => { setTimeout(resolve, 250) })
        }
      }
    } else {
      logErrorFileOnly('attach', `no workspace for cwd ${workspace}`)
    }
  } catch (error) {
    logErrorFileOnly('attach', `workspace resolve failed: ${String(error)}`)
  }
}

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
  readonly kind: 'user' | 'assistant' | 'reasoning' | 'status' | 'tool' | 'error'
  readonly text: string
  readonly dim?: boolean
  /** Tool-row payload: `running` rows carry the (capped) raw arguments for the
   *  summary; settled rows carry the result/error text (inline-capped for
   *  display; the full text stays in the session log). */
  readonly tool?: {
    readonly state: 'running' | 'ok' | 'error'
    readonly argsRaw?: string
    readonly body?: string
    /** Wall-clock start (ms) of a `running` row — drives the row's live
     *  elapsed-seconds tail while the tool is in flight. */
    readonly startedAt?: number
  }
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

/** One in-band user-question ask shown as a single card dock. A request may
 *  carry several questions; the card shows them ONE at a time, keeps each
 *  committed answer, and submits the whole batch once every question is
 *  answered (opencode question-dock semantics — no popup-per-question).
 *
 *  `questions`/`answers`/… are the batch state; `item`/`index`/`custom`/…
 *  are the ACTIVE question's editable snapshot (`questions[active]`), so the
 *  panel and the row-count estimate read one coherent shape. */
export interface PendingQuestion {
  readonly questions: readonly AskUserQuestionItem[]
  readonly resolve: (answers: AskUserQuestionAnswerItem[]) => void
  readonly reject: (error: Error) => void
  /** Index of the question currently shown (0-based). */
  active: number
  /** Committed answers per question (index-aligned); null = not answered yet. */
  answers: ({ kind: 'option'; label: string } | { kind: 'custom'; text: string } | null)[]
  /** Last highlighted row per question (option index; `options.length` = the
   *  "Other" row). */
  highlights: number[]
  /** Draft "Other" text per question, kept while navigating back/forth. */
  drafts: string[]
  /** Whether the "Other" inline editor was open when the question was left. */
  draftOpen: boolean[]
  // ── active-question snapshot (== questions[active]) ──
  item: AskUserQuestionItem
  /** Highlighted row of the active question (`options.length` = "Other"). */
  index: number
  /** Draft text of the active question's "Other" editor. */
  custom: string
  /** Whether the "Other" editor is open (typed answer lands below the list). */
  customMode: boolean
  /** Character index of the caret inside the active "Other" input. */
  customCursor: number
  /** Live mouse selection inside the active custom input (char indexes, `to`
   *  exclusive), or null when no selection is active. */
  sel: { from: number; to: number } | null
}

/** A command in the slash palette. */
export interface CommandItem {
  readonly name: string
  readonly hint: string
  readonly run: (arg: string) => void
}

/** Coarse phase of the current agent run, shown in the status bar's liveness
 *  indicator: `working` (between events, model computing the next step),
 *  `thinking` (reasoning deltas streaming), `answering` (text streaming) or
 *  `tool` (a tool call row is open). */
export type RunPhase = 'working' | 'thinking' | 'answering' | 'tool'

/** Mutable UI store the Ink app subscribes to. */
export class Store {
  private items: TranscriptItem[] = []
  private key = 0
  private version = 0
  private listeners = new Set<() => void>()
  private _input = ''
  private _cursor = 0
  private _composerImage: ComposerImage | null = null
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
  // ── run-liveness metadata (the status bar must never LOOK frozen while the
  // agent is running, even across long silent stretches) ─────────────────────
  /** Wall-clock (ms) of the last live agent/session activity event. */
  private _lastActivityAt = 0
  /** Wall-clock (ms) the current run started (agent/status → running). */
  private _busySince = 0
  /** The last opened tool call name, while at least one is in flight. */
  private _currentTool: string | null = null
  /** Count of concurrently open tool rows (parallel tool calls). */
  private _toolOpen = 0
  /** Coarse run phase for the status-bar liveness text. */
  private _phase: RunPhase = 'working'
  /** Global tool-body visibility: when true, EVERY settled tool row's result
   *  body shows unless overridden per row; false hides unless overridden. */
  private _toolBodiesDefault = false
  /** Per-row overrides of the global default (key → effective visible). */
  private _toolBodiesOverride = new Map<number, boolean>()
  /** Global reasoning (Think) expansion default; per-row overrides below let
   *  one Think row open/close by mouse without touching the others. */
  private _reasoningDefault = false
  private _reasoningOverride = new Map<number, boolean>()
  /** Bumped when measured row heights change (the transcript layout memo
   *  depends on this instead of the generic render `version`, so typing and
   *  phase/hover churn never recompute the whole layout). */
  private _measureEpoch = 0
  /** Bumped when an expansion toggle changes row heights (/think, per-row). */
  private _expansionEpoch = 0
  /** Tool row currently under the mouse (hover affordance: "clickable"), or
   *  null. Only set when the row is a settled tool with a body. */
  private _hoveredToolKey: number | null = null
  /** Row → transcript item resolver installed by the conversation panel each
   *  render (mouse clicks on a tool row toggle its expansion). */
  private _rowResolver: ((row: number) => TranscriptItem | null) | null = null
  private _followTail = true
  private _scroll = 0
  private _layoutContent = 0
  private _layoutViewport = 0
  private _layoutScroll = 0
  private _layoutTopRow = 1
  private _selection: { aRow: number; aCol: number; cRow: number; cCol: number } | null = null
  private _selectionActive = false
  /** Transient status-bar message (e.g. "copied: …"), shown in the bottom status
   *  bar and auto-cleared. Unlike a `status` TRANSCRIPT item it never adds a
   *  transcript row, so it cannot re-layout / follow-tail auto-scroll the
   *  transcript and slide the (screen-coordinate) selection highlight onto the
   *  next block below. */
  private _statusFlash: { text: string; at: number } | null = null
  private _statusFlashTimer: ReturnType<typeof setTimeout> | null = null
  get statusFlash(): { text: string; at: number } | null { return this._statusFlash }
  flashStatus(text: string, ms = 2500): void {
    this._statusFlash = { text, at: Date.now() }
    if (this._statusFlashTimer) clearTimeout(this._statusFlashTimer)
    this._statusFlashTimer = setTimeout(() => {
      this._statusFlash = null
      this._statusFlashTimer = null
      this.notify()
    }, ms)
    this.notify()
  }
  /** Optional predicate registered by the conversation panel: maps a mouse
   *  selection to the 0-based GRID rectangle it should highlight (or null to
   *  suppress) plus the message column's CONTENT right edge (grid col), so the
   *  flow copy stops before the Steps sidebar. The panel clamps to the transcript
   *  viewport so a composer/status selection (which has its own React inverse) is
   *  never double-highlighted by the frame buffer. */
  private _frameGuard: ((sel: { aRow: number; aCol: number; cRow: number; cCol: number }) => { rect: { x1: number; y1: number; x2: number; y2: number } | null; right: number } | null) | null = null
  setFrameSelectionGuard(fn: (sel: { aRow: number; aCol: number; cRow: number; cCol: number }) => { rect: { x1: number; y1: number; x2: number; y2: number } | null; right: number } | null): void {
    this._frameGuard = fn
  }

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

  // ── right sidebar (Steps) visibility ──────────────────────────────────────
  private _sidebarMode: SidebarMode = readSidebarMode()
  /** Right-sidebar visibility mode: `auto` follows the width threshold, `on`/
   *  `off` pin it (persisted across runs). */
  get sidebarMode(): SidebarMode { return this._sidebarMode }
  setSidebarMode(mode: SidebarMode): void {
    this._sidebarMode = mode
    persistSidebarMode(mode)
    this.notify()
  }
  /** Cycle `auto → on → off → auto` (the `/sidebar` command and a Steps-title
   *  click both use this); returns the new mode. */
  cycleSidebarMode(): SidebarMode {
    const next: SidebarMode = this._sidebarMode === 'auto' ? 'on' : this._sidebarMode === 'on' ? 'off' : 'auto'
    this.setSidebarMode(next)
    return next
  }

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
  /** Abort the whole task when the user cancels an ask_user_question from the
   *  question dock (injected by start(); Esc in the options list calls it, so
   *  cancelling the ask also stops the agent's running turn — the model is
   *  awaiting the answer, so the task must not keep going). */
  cancelQuestionAction: () => void = () => {}
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
  get composerImage(): ComposerImage | null { return this._composerImage }
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
    // Pinned sessions sort to the top; within each group, newest first. The
    // /sessions day grouping (sessions.tsx dayLabel) requires chronological
    // order — without it the same day label recurs non-contiguously, producing
    // duplicate group-header React keys whose reconciliation corrupts the
    // dialog (a doubled filter line / garbled rows). Sort by createdAt DESC.
    return [...base].sort((a, b) =>
      (isPinned(b.id) ? 1 : 0) - (isPinned(a.id) ? 1 : 0)
      || (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }
  get secret() { return this._secret }

  append(kind: TranscriptItem['kind'], text: string, dim = kind === 'reasoning' || kind === 'status'): void {
    this.items = [...this.items, { key: this.key += 1, kind, text, dim }]
    this.notify()
  }

  /** Append a RUN-FAILURE row (provider/billing/quota error, transport after
   *  retries, credential problems…). Harness-web turn-error parity: a visible
   *  error row, not a silent stop — the user can send another message to
   *  start a fresh turn (quota/billing failures are NOT auto-retried). */
  appendRunError(text: string): void {
    this.items = [...this.items, { key: this.key += 1, kind: 'error', text }]
    this.notify()
  }

  /** Append a running tool-call row (opencode-style inline tool). The raw
   *  arguments are kept (capped) for the one-line summary derivation; the
   *  start timestamp feeds the row's live elapsed-seconds tail. */
  toolCall(name: string, argsRaw?: string): void {
    this.items = [...this.items, {
      key: this.key += 1,
      kind: 'tool',
      text: `│ ${name}`,
      tool: { state: 'running', startedAt: Date.now(), ...argsRaw === undefined ? {} : { argsRaw: capToolArgs(argsRaw) } },
    }]
    this._toolOpen += 1
    this._currentTool = name
    this._phase = 'tool'
    this.markActivity()
    this.notify()
  }

  /** Mark the most recent running tool row as completed, attaching the
   *  (inline-capped) result/error text for the expandable body. */
  toolResult(result?: { ok: boolean; text: string }): void {
    const body = result === undefined || result.text.trim() === '' ? undefined : capToolBody(result.text.trim())
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]
      if (item.kind === 'tool') {
        const prevTool = item.tool
        const name = item.text.slice(2)
        const error = result !== undefined && !result.ok
        const header = error ? `✗ ${name}` : `✓ ${name}`
        const tool: TranscriptItem['tool'] = {
          state: error ? 'error' : 'ok',
          ...prevTool?.argsRaw === undefined ? {} : { argsRaw: prevTool.argsRaw },
          ...body === undefined ? {} : { body },
        }
        this.items = [
          ...this.items.slice(0, i),
          { ...item, text: header, tool },
          ...this.items.slice(i + 1),
        ]
        break
      }
    }
    this._toolOpen = Math.max(0, this._toolOpen - 1)
    if (this._toolOpen === 0) {
      this._currentTool = null
      this._phase = 'working'
    }
    this.markActivity()
    this.notify()
  }

  // ── tool-row expansion (collapsed summary ↔ full result body) ─────────────
  /** Whether the tool row's body currently shows: the per-row override when
   *  set, else the global default (`/think`). */
  isToolExpanded(key: number): boolean {
    const override = this._toolBodiesOverride.get(key)
    return override === undefined ? this._toolBodiesDefault : override
  }
  /** Bumped when measured row heights change (see `measureEpoch`). */
  bumpMeasure(): void { this._measureEpoch += 1 }
  /** Bumped when CPR calibration changes glyph widths: wrapped heights may
   *  change, so the transcript layout must recompute. Same epoch as measured
   *  heights — both are "layout-affecting measurements changed". */
  bumpWidths(): void { this._measureEpoch += 1; this.notify() }
  /** Bumped when an expansion toggle changes row heights (see
   *  `expansionEpoch`). */
  private bumpExpansion(): void { this._expansionEpoch += 1 }
  get measureEpoch(): number { return this._measureEpoch }
  get expansionEpoch(): number { return this._expansionEpoch }
  /** Toggle ONE tool row (mouse click): records a per-row override of
   *  the current global default, so individual rows stay clickable in both
   *  global modes. */
  toggleToolExpanded(key: number): void {
    const next = !this.isToolExpanded(key)
    if (next === this._toolBodiesDefault) this._toolBodiesOverride.delete(key)
    else this._toolBodiesOverride.set(key, next)
    this.bumpExpansion()
    this.notify()
  }
  /** `/think`: unified "show all detail" — every reasoning (Think) body AND
   *  every tool result body expand together; toggling again collapses both.
   *  Per-tool click overrides are dropped on each flip. The scroll position is
   *  untouched (B: keep bottom / current position); the status bar flashes a
   *  confirmation with the number of affected rows so the toggle is always
   *  visible feedback. */
  toggleAllDetail(): void {
    const show = !this._toolBodiesDefault
    const detailRows = this.items.reduce(
      (n, it) => n + (it.kind === 'reasoning' ? 1 : 0) + (it.kind === 'tool' && it.tool?.body !== undefined ? 1 : 0),
      0,
    )
    this._toolBodiesDefault = show
    this._toolBodiesOverride.clear()
    this._reasoningDefault = show
    this._reasoningOverride.clear()
    this.bumpExpansion()
    this.flashStatus(show ? `details: show all (${detailRows} rows)` : `details: hide all (${detailRows} rows)`)
    this.notify()
  }
  /** Register the panel's screen-row → transcript-item resolver for the mouse
   *  click handler (re-set every render; null when the panel is unmounted). */
  setRowResolver(resolver: ((row: number) => TranscriptItem | null) | null): void {
    this._rowResolver = resolver
  }
  resolveRow(row: number): TranscriptItem | null {
    return this._rowResolver === null ? null : this._rowResolver(row)
  }
  /** Hover state for the tool-row affordance (opencode-style: a row that can be
   *  clicked highlights under the cursor). */
  get hoveredToolKey(): number | null { return this._hoveredToolKey }
  setHoverTool(key: number | null): void {
    if (key === this._hoveredToolKey) return
    this._hoveredToolKey = key
    this.notify()
  }

  streamText(text: string): void {
    const tail = this.items.at(-1)
    if (tail?.kind === 'assistant') {
      this.items = [...this.items.slice(0, -1), { ...tail, text: tail.text + text }]
    } else {
      this.items = [...this.items, { key: this.key += 1, kind: 'assistant', text }]
    }
    this._phase = 'answering'
    this.markActivity()
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
    this._phase = 'thinking'
    this.markActivity()
    this.notify()
  }

  /** Global reasoning (Think) expansion default (`/think`); per-row mouse
   *  clicks use reasoningExpanded(key) with a per-row override. */
  get expandReasoning(): boolean { return this._reasoningDefault }
  /** Whether ONE reasoning row's body shows: per-row override ?? global. */
  reasoningExpanded(key: number): boolean {
    const override = this._reasoningOverride.get(key)
    return override === undefined ? this._reasoningDefault : override
  }
  /** Toggle ONE Think row (mouse click on its header): records a per-row
   *  override of the global default, so individual reasoning rows open/close
   *  without affecting the others or the `/think` master switch. */
  toggleReasoningRow(key: number): void {
    const next = !this.reasoningExpanded(key)
    if (next === this._reasoningDefault) this._reasoningOverride.delete(key)
    else this._reasoningOverride.set(key, next)
    this.bumpExpansion()
    this.notify()
  }

  clear(): void {
    this.items = []
    this._steps = []
    this._toolBodiesOverride.clear()
    this._toolBodiesDefault = false
    this._reasoningOverride.clear()
    this._reasoningDefault = false
    this._measureEpoch += 1
    this._expansionEpoch += 1
    this._rowResolver = null
    this.notify()
  }

  /** Replace the transcript with folded session history (resumed-session
   *  replay) and continue keying from the loaded items, so live appends never
   *  collide with replayed keys. */
  loadHistory(items: readonly TranscriptItem[], steps: readonly StepItem[]): void {
    this.items = [...items]
    this.key = items.length
    this._steps = [...steps]
    this._toolBodiesOverride.clear()
    this._toolBodiesDefault = false
    this._reasoningOverride.clear()
    this._reasoningDefault = false
    this._measureEpoch += 1
    this._expansionEpoch += 1
    this.notify()
  }

  setInput(value: string): void {
    this._input = value
    if (this._cursor > value.length) this._cursor = value.length
    this.notify()
  }
  /** Attach a composer image (set from a dragged/pasted image file path). */
  setComposerImage(image: ComposerImage): void {
    this._composerImage = image
    this.notify()
  }
  /** Clear the composer image chip (backspace/Esc, or after submit). */
  clearComposerImage(): void {
    if (this._composerImage === null) return
    this._composerImage = null
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
  /** Move the caret to the start of the current logical line (Home). */
  moveCursorToLineStart(): void {
    this.setCursor(this._lineStart(this._cursor))
  }
  /** Move the caret to the end of the current logical line (End). */
  moveCursorToLineEnd(): void {
    this.setCursor(this._lineEnd(this._cursor))
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
  /** Jump the approval highlight to `i` (0=Deny, 1=Allow always, 2=Allow once). */
  setApprovalChoice(i: number): void {
    this._approvalChoice = Math.max(0, Math.min(2, i))
    this.notify()
  }
  /** Tool names the user chose "Allow always" for this session (in-memory, opencode-style). */
  private _allowAlways = new Set<string>()
  /** Tools allowed without asking for the rest of this session. */
  get allowAlways(): readonly string[] { return [...this._allowAlways] }
  isAllowAlways(toolName: string): boolean { return this._allowAlways.has(toolName) }
  rememberAllowAlways(toolName: string): void { this._allowAlways.add(toolName); this.notify() }
  get question(): PendingQuestion | null { return this._question }
  setQuestion(q: PendingQuestion): void { this._question = q; this._questionScroll = 0; this._questionTabFrom = 0; this._questionRows = 0; this._panel = 'question'; this.notify() }
  /** Measured dock ROW count: the question panel reports the real rendered
   *  height of its dock every frame; the floating window + its opaque backdrop
   *  size themselves from THIS value (falling back to the layout estimate
   *  before the first measurement) so the dock's bottom edge is always pinned
   *  and only its top moves as content grows/shrinks. */
  private _questionRows = 0
  get questionRows(): number { return this._questionRows }
  setQuestionRows(v: number): void {
    const n = Math.max(0, Math.round(v))
    if (n === this._questionRows) return
    this._questionRows = n
    this.notify()
  }
  /** Question-body scroll offset (the dock's scrollable body window — detail +
   *  fully-wrapped options — scrolls inside a bounded window; rows are never
   *  ellipsized, they wrap and the window reveals the rest). */
  private _questionScroll = 0
  get questionScroll(): number { return this._questionScroll }
  scrollQuestion(delta: number): void {
    this._questionScroll = Math.max(0, this._questionScroll + delta)
    this.notify()
  }
  /** Horizontal page offset of the multi-question TAB BAR: the index of the
   *  FIRST tab currently visible. Kept in the store so ←/→ can page the tabs
   *  when the bar overflows the dock width; the panel clamps it to the window
   *  that fits (and auto-scrolls the active tab into view). */
  private _questionTabFrom = 0
  get questionTabFrom(): number { return this._questionTabFrom }
  setQuestionTabFrom(v: number): void {
    const next = Math.max(0, v)
    if (next === this._questionTabFrom) return
    this._questionTabFrom = next
    this.notify()
  }
  /** Jump the question body window to an absolute offset (selection-follow:
   *  after ↑/↓/digits move the highlight, the window scrolls so the option's
   *  full wrapped block stays in view). */
  scrollQuestionTo(v: number): void {
    this._questionScroll = Math.max(0, v)
    this.notify()
  }
  // ── card navigation & batch submission (multi-question ask, one dock) ──────
  /** Persist the active question's transient state (highlight, editor text,
   *  editor-open) into its per-question slot before switching away. */
  private stashQuestionSlot(): void {
    const q = this._question
    if (q === null) return
    const a = q.active
    q.highlights[a] = q.index
    q.drafts[a] = q.custom
    q.draftOpen[a] = q.customMode
  }
  /** Load question `i`'s saved state into the active snapshot (and the active
   *  question object), closing the editor unless that question's answer was a
   *  custom text (then it reopens for editing, matching the Other row). */
  private loadQuestionSlot(i: number): void {
    const q = this._question
    if (q === null) return
    const item = q.questions[i]!
    const optsLen = item.options?.length ?? 0
    const ans = q.answers[i]
    q.item = item
    if (ans !== null && ans.kind === 'custom') {
      q.index = optsLen
      q.custom = ans.text
      q.customMode = true
      q.draftOpen[i] = true
    } else if (ans !== null && ans.kind === 'option') {
      const at = item.options?.findIndex((o) => o.label === ans.label) ?? -1
      q.index = at >= 0 ? at : Math.min(q.highlights[i] ?? 0, optsLen)
      q.custom = ''
      q.customMode = false
    } else {
      q.index = Math.min(q.highlights[i] ?? 0, optsLen)
      q.custom = q.drafts[i] ?? ''
      q.customMode = q.custom !== '' && (q.draftOpen[i] ?? false)
    }
    q.customCursor = q.custom.length
    q.sel = null
  }
  /** Move to the previous/next question (free navigation — nothing is
   *  committed by moving; current transient state is stashed). */
  questionGo(dir: -1 | 1): void {
    const q = this._question
    if (q === null) return
    const next = q.active + dir
    if (next < 0 || next >= q.questions.length) return
    this.stashQuestionSlot()
    q.active = next
    this.loadQuestionSlot(next)
    this._questionScroll = 0
    this.notify()
  }
  /** Jump straight to question `i` (clicking the card's tab bar / opencode
   *  dock semantics). */
  questionJump(i: number): void {
    const q = this._question
    if (q === null) return
    const target = Math.max(0, Math.min(q.questions.length - 1, i))
    if (target === q.active) return
    this.stashQuestionSlot()
    q.active = target
    this.loadQuestionSlot(target)
    this._questionScroll = 0
    this.notify()
  }
  /** The primary "answer" action (Enter / click / digit): commit the active
   *  question (option or "Other" text) and advance to the next unanswered one,
   *  or submit the whole batch when every question is answered. Pressing Enter
   *  on the OTHER row (with no text yet) opens the inline editor instead. */
  questionEnter(): void {
    const q = this._question
    if (q === null) return
    const opts = q.item.options ?? []
    const optsLen = opts.length
    const a = q.active
    if (q.customMode) {
      const trimmed = q.custom.trim()
      if (trimmed === '') { this.flashStatus('type your answer first'); return }
      q.answers[a] = { kind: 'custom', text: trimmed }
      q.drafts[a] = q.custom
      q.draftOpen[a] = false
      q.customMode = false
      this.advanceAfterAnswer(q)
      return
    }
    if (q.index === optsLen) {
      // "Other…" chosen: open the inline editor UNDER the option list.
      q.customMode = true
      q.customCursor = q.custom.length
      this.notify()
      return
    }
    const opt = opts[q.index]
    if (opt === undefined) return
    q.answers[a] = { kind: 'option', label: opt.label }
    q.drafts[a] = ''
    q.draftOpen[a] = false
    q.highlights[a] = q.index
    q.customMode = false
    this.advanceAfterAnswer(q)
  }
  /** After a commit: submit when all answered; otherwise jump to / advance
   *  toward the first unanswered question so a batch finishes in order. */
  private advanceAfterAnswer(q: PendingQuestion): void {
    const first = q.answers.findIndex((a) => a === null)
    if (first === -1) { this.submitQuestion(); return }
    if (first !== q.active) {
      this.stashQuestionSlot()
      q.active = first
      this.loadQuestionSlot(first)
      this._questionScroll = 0
      this.notify()
      if (q.questions.length > 1) this.flashStatus(`answer question ${first + 1}/${q.questions.length} first`)
      return
    }
    // Current (now answered) is the first unanswered: step to the next one.
    let next = q.active + 1
    while (next < q.questions.length && q.answers[next] !== null) next++
    if (next >= q.questions.length) { this.submitQuestion(); return }
    this.stashQuestionSlot()
    q.active = next
    this.loadQuestionSlot(next)
    this._questionScroll = 0
    this.notify()
  }
  /** Submit the whole ask with every question's committed answer (in order),
   *  then close the dock. */
  private submitQuestion(): void {
    const q = this._question
    if (q === null) return
    const answers: AskUserQuestionAnswerItem[] = q.questions.map((item, i) => {
      const ans = q.answers[i]
      if (ans === null) return { id: item.id, selected: [] } // guarded: all answered
      if (ans.kind === 'custom') return { id: item.id, selected: [], custom: ans.text }
      return { id: item.id, selected: [ans.label] }
    })
    const resolve = q.resolve
    this.clearQuestion()
    resolve(answers)
  }
  /** Esc / Ctrl+C outside the editor: cancel the WHOLE ask request and abort
   *  the running task (the agent is awaiting the answer; it must not keep
   *  going). */
  cancelQuestion(): void {
    const q = this._question
    if (q === null) return
    const rejectFn = q.reject
    this.clearQuestion()
    rejectFn(new Error('ask_user_question was cancelled'))
    this.cancelQuestionAction()
  }
  clearQuestion(): void { this._question = null; this._questionRows = 0; if (this._panel === 'question') this._panel = 'conversation'; this.notify() }
  bumpQuestionIndex(delta: number): void {
    if (this._question === null) return
    const len = Math.max(1, (this._question.item.options?.length ?? 0) + 1) // +1 = the custom/"Other" row
    this._question.index = (this._question.index + delta + len) % len
    this.notify()
  }
  /** Jump the question highlight to `i` (clamped to the options plus the Other row). */
  setQuestionIndex(i: number): void {
    if (this._question === null) return
    const len = Math.max(1, (this._question.item.options?.length ?? 0) + 1)
    this._question.index = Math.max(0, Math.min(len - 1, i))
    this.notify()
  }
  setQuestionCustom(value: string, mode: boolean): void {
    if (this._question === null) return
    this._question.custom = value
    this._question.customMode = mode
    this._question.customCursor = value.length
    this.notify()
  }
  /** Close the active question's inline "Other" editor via Esc: DISCARD the
   *  typed text (back to the options list for this question; Esc there cancels
   *  the whole ask). Committing (Enter) saves the draft; escaping discards it. */
  questionCloseEditor(): void {
    if (this._question === null) return
    this._question.customMode = false
    this._question.sel = null
    this._question.custom = ''
    this._question.customCursor = 0
    this.notify()
  }
  // ── custom ("Other") input editing — mirrors the composer key semantics ──
  private clampQuestionCursor(): void {
    if (this._question === null) return
    const len = this._question.custom.length
    if (this._question.customCursor > len) this._question.customCursor = len
    if (this._question.customCursor < 0) this._question.customCursor = 0
  }
  questionType(char: string): void {
    if (this._question === null) return
    const q = this._question
    const at = q.customCursor
    q.custom = q.custom.slice(0, at) + char + q.custom.slice(at)
    q.customCursor = at + char.length
    this.notify()
  }
  questionBackspace(): void {
    if (this._question === null) return
    const q = this._question
    if (q.customCursor > 0) {
      const at = q.customCursor - 1
      q.custom = q.custom.slice(0, at) + q.custom.slice(q.customCursor)
      q.customCursor = at
    }
    this.notify()
  }
  questionDelete(): void {
    if (this._question === null) return
    const q = this._question
    if (q.customCursor < q.custom.length) {
      q.custom = q.custom.slice(0, q.customCursor) + q.custom.slice(q.customCursor + 1)
    }
    this.notify()
  }
  /** Ctrl+U: delete the current line's start (after the preceding newline)
   *  through the caret, joining the rest with the previous line — the same
   *  semantics as the composer. */
  questionCtrlU(): void {
    if (this._question === null) return
    const q = this._question
    const at = q.customCursor
    const nl = q.custom.lastIndexOf('\n', at - 1)
    const start = nl === -1 ? 0 : nl
    q.custom = q.custom.slice(0, start) + q.custom.slice(at)
    q.customCursor = start
    this.notify()
  }
  /** Ctrl+C: clear the input (keep the popup open; Esc still cancels). */
  questionClearInput(): void {
    if (this._question === null) return
    this._question.custom = ''
    this._question.customCursor = 0
    this.notify()
  }
  questionCursorToStart(): void {
    if (this._question === null) return
    this._question.customCursor = 0
    this.notify()
  }
  questionCursorToEnd(): void {
    if (this._question === null) return
    this._question.customCursor = this._question.custom.length
    this.notify()
  }
  /** Jump the custom-input caret to an arbitrary (clamped) index (visual-line
   *  up/down movement computed by the question panel). */
  questionCursorTo(index: number): void {
    if (this._question === null) return
    this._question.customCursor = Math.max(0, Math.min(this._question.custom.length, index))
    this.notify()
  }
  // ── mouse: click to place the caret / drag to select inside the custom ──
  questionMousePress(at: number): void {
    if (this._question === null) return
    this._question.customCursor = at
    this._question.sel = { from: at, to: at }
    this.notify()
  }
  questionMouseDrag(at: number): void {
    if (this._question === null) return
    const s = this._question.sel
    if (s !== null) { this._question.sel = { from: s.from, to: at }; this.notify() }
  }
  /** Release: returns the selected range (normalized, `to` exclusive) and
   *  clears the live selection; null when there was none. */
  questionMouseEnd(): { from: number; to: number } | null {
    if (this._question === null) return null
    const s = this._question.sel
    this._question.sel = null
    if (s === null) return null
    return s.from <= s.to ? { from: s.from, to: s.to } : { from: s.to, to: s.from }
  }
  questionCursorLeft(): void {
    if (this._question === null) return
    this._question.customCursor -= 1
    this.clampQuestionCursor()
    this.notify()
  }
  questionCursorRight(): void {
    if (this._question === null) return
    this._question.customCursor += 1
    this.clampQuestionCursor()
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
    if (running) {
      this._paused = false // resuming a turn clears the Stopped state
      const now = Date.now()
      this._busySince = now
      this._lastActivityAt = now
      this._phase = 'working'
    } else {
      // Idle: no in-flight tools and the run clock resets for the next turn.
      this._busySince = 0
      this._toolOpen = 0
      this._currentTool = null
      this._phase = 'working'
    }
    this.notify()
  }
  get paused(): boolean { return this._paused }
  setPaused(paused: boolean): void { if (paused === this._paused) return; this._paused = paused; this.notify() }
  // ── run liveness (status-bar "never looks frozen" state) ───────────────────
  get lastActivityAt(): number { return this._lastActivityAt }
  get busySince(): number { return this._busySince }
  get currentTool(): string | null { return this._currentTool }
  get toolOpenCount(): number { return this._toolOpen }
  get runPhase(): RunPhase { return this._phase }
  /** Liveness beat from the live session-event stream / run start. Cheap and
   *  never notifies (the caller already notifies), so it is safe at the top of
   *  the high-frequency event handler. */
  markActivity(): void {
    const now = Date.now()
    this._lastActivityAt = now
    if (this._busySince === 0) this._busySince = now
  }
  /** Set the coarse run phase shown in the status bar (never notifies; the
   *  caller is already mid-update). */
  setRunPhase(phase: RunPhase): void {
    this._phase = phase
  }
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
  /** Mirror the current mouse selection to the patched Ink frame controller so
   *  Output.get() bakes an inverse highlight onto the exact selected cells before
   *  serialization (in-place, over the real markdown/rail/colors — the code and
   *  panel backgrounds survive). 1-based SGR coords → 0-based grid; only a real
   *  drag (Manhattan > 2) highlights, so a bare click never flashes an inverse.
   *  Set synchronously before notify() so the NEXT frame reads it (no post-commit
   *  race — a post-commit hook would only ever see the previous frame). */
  private syncFrameSelection(): void {
    const g = globalThis as unknown as { __dshFrameController?: { selection: unknown; bg: string; anchor?: unknown; focus?: unknown; contentRight?: number } }
    if (!g.__dshFrameController) g.__dshFrameController = { selection: null, bg: '1' }
    const s = this._selection
    const active = s !== null && (Math.abs(s.aRow - s.cRow) + Math.abs(s.aCol - s.cCol)) > 2
    if (!active || s === null) { g.__dshFrameController.selection = null; g.__dshFrameController.anchor = null; g.__dshFrameController.focus = null; return }
    const gr = this._frameGuard ? this._frameGuard(s) : null
    g.__dshFrameController.selection = gr?.rect ?? null
    // The message column's content right edge (grid col) bounds the flow copy so
    // it stops before the Steps sidebar (which would otherwise be swept in).
    g.__dshFrameController.contentRight = gr?.right ?? (this.width - 1)
    // Anchor + focus (the drag endpoints, 1-based SGR) let the frame controller
    // reproduce a LINE/FLOW copy (opencode-style): walking from the anchor cell to
    // the focus cell following the text flow, so e.g. dragging from the start of a
    // line into the middle of the next copies the whole first line + that prefix.
    g.__dshFrameController.anchor = { row: s.aRow, col: s.aCol }
    g.__dshFrameController.focus = { row: s.cRow, col: s.cCol }
  }
  /** Begin a mouse selection at a terminal cell; clears any previous selection. */
  mousePress(row: number, col: number): void {
    this._selection = { aRow: row, aCol: col, cRow: row, cCol: col }
    this._selectionActive = true
    this.syncFrameSelection()
    this.notify()
  }
  /** Move the current end of a mouse selection. */
  mouseDrag(row: number, col: number): void {
    if (!this._selectionActive || this._selection === null) return
    this._selection = { ...this._selection, cRow: row, cCol: col }
    this.syncFrameSelection()
    this.notify()
  }
  /** Finish a mouse gesture: `drag` when moved (keeps the highlight), `click` otherwise (clears it). */
  mouseRelease(row: number, col: number): 'click' | 'drag' {
    if (this._selection === null || !this._selectionActive) return 'click'
    const s = this._selection
    this._selection = { ...s, cRow: row, cCol: col }
    this._selectionActive = false
    let kind: 'click' | 'drag'
    if (Math.abs(s.aRow - row) + Math.abs(s.aCol - col) > 2) {
      kind = 'drag'
    } else {
      this._selection = null
      kind = 'click'
    }
    this.syncFrameSelection()
    this.notify()
    return kind
  }
  clearSelection(): void {
    if (this._selection === null && !this._selectionActive) return
    this._selection = null
    this._selectionActive = false
    this.syncFrameSelection()
    this.notify()
  }
  private _maxScroll(): number { return Math.max(0, this._layoutContent - this._layoutViewport) }
  scrollPage(dir: -1 | 1): void {
    // A mouse-selection highlight is baked into the SCREEN cells; once the
    // content scrolls those coordinates no longer point at the selected text, so
    // clear it (opencode's visible-region selection also clears on scroll).
    this.clearSelection()
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
    this.clearSelection()
    if (this._followTail) this._scroll = this._maxScroll()
    this._followTail = false
    this._scroll = Math.max(0, Math.min(this._scroll + delta, this._maxScroll()))
    this.notify()
  }
  scrollTop(): void { this.clearSelection(); this._followTail = false; this._scroll = 0; this.notify() }
  scrollBottom(): void { this.clearSelection(); this._followTail = true; this._scroll = this._maxScroll(); this.notify() }
}

/** Durable image attachment reference (derived from the harness message block,
 *  so no direct dsh-attachment import is needed). */
type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']

/** A file dragged into the composer (its path is pasted by the terminal emulator)
 *  that the image-attach plugin resolved to a durable image reference. The
 *  conversation renders it as an attachment chip; submit includes it as an image
 *  content block. */
export interface ComposerImage {
  readonly ref: ImageRef
  readonly name: string
  readonly mediaType: string
}

/** The tui-image-attach plugin's public API (mounted on `tui.imageAttach`). */
export interface ImageAttachApi {
  /** If `text` is a local image file path (quotes/file:// stripped, known image
   *  extension), return that path; otherwise `null`. */
  imagePathFor(text: string): string | null
  /** Read `path`, save via the attachment store, and set the composer image
   *  chip. Returns the durable reference, or `undefined` on failure. */
  attachLocalImage(path: string): Promise<ImageRef | undefined>
  /** Clear the composer image chip. */
  clear(): void
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
  /** Image drag-in attachment (mounted by the tui-image-attach plugin). */
  imageAttach?: ImageAttachApi
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

/** Whether the CURRENT provider's own API key is configured. The composer
 *  label/"not set" state must follow the provider actually selected, not a
 *  DeepSeek-only probe: adding a non-DeepSeek provider first (e.g. OpenCode
 *  Zen) would otherwise keep showing "not set" although its key is stored,
 *  while a first-added DeepSeek provider "succeeds" purely because the probe
 *  hardcodes the DeepSeek key. Falls back to the DeepSeek check when the
 *  models service (per-provider key status) is unavailable. */
async function providerConfigured(ctx: Context, provider: string): Promise<boolean> {
  if (provider === 'deepseek-official') return apiKeyConfigured(ctx)
  const modelsService = ctx.get('tuiModels') as
    | { keyConfigured?(provider: string): Promise<boolean> }
    | undefined
  try {
    if (modelsService?.keyConfigured !== undefined) return await modelsService.keyConfigured(provider)
  } catch {
    // fall through to the best-effort DeepSeek probe below
  }
  return apiKeyConfigured(ctx)
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
  // The loader activates entries in service-availability waves, and
  // `loader.await()` can settle at a momentarily quiescent point before the
  // agent-loop row has activated. The agent factory is registered by that
  // row's AgentLoop service on construction; creating or resuming the launch
  // session before then throws "no agent factory registered (load an
  // agent-loop plugin)". Wait (bounded) for the agentLoop service so the
  // first create/resume below runs after the factory registration.
  const factoryDeadline = Date.now() + 5_000
  while (ctx.get('agentLoop') === undefined && Date.now() < factoryDeadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
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
  //
  // The registry's factory registration can land a short moment AFTER the
  // loader reports quiescence (late service-availability waves during boot);
  // create/resume throws "no agent factory registered" before any side effect
  // when it has not landed yet. Launching the session must tolerate that
  // transient gap, so the establish attempt retries with a bounded window.
  let handle: AgentHandle | undefined
  let resumed = false
  const establish = async (): Promise<{ handle?: AgentHandle; resumed: boolean }> => {
    let nextHandle: AgentHandle | undefined
    let nextResumed = false
    if (config.resume !== undefined) {
      nextHandle = await agents.resume({ resumeSessionId: SessionId(config.resume), agentOptions, setup })
      nextResumed = true
    } else if (resolveResumeLast()) {
      nextHandle = await autoResumeNewest(ctx, agents, config.workspace, agentOptions, setup)
      nextResumed = nextHandle !== undefined
    }
    if (nextHandle === undefined) {
      nextHandle = await agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: config.workspace },
        agentOptions,
        setup,
      })
    }
    return { handle: nextHandle, resumed: nextResumed }
  }
  const NO_FACTORY = /no agent factory registered/
  const factoryRetryDeadline = Date.now() + 10_000
  for (;;) {
    try {
      const result = await establish()
      handle = result.handle
      resumed = result.resumed
      // dsh-tui and the web share the session store under
      // ~/.dsh/sessions/<cwd-encoded>/, but the web groups sessions by
      // workspaceId. A dsh-tui session is created with `meta.cwd` only, so the
      // harness never attaches it and the web lists it under "Ungrouped".
      // Attach this session to the workspace that owns `config.workspace` (when
      // one exists — e.g. the web-created "deepseek" workspace) so it groups
      // under the SAME workspace instead of Ungrouped. Best-effort: a path or
      // registry mismatch must never break the TUI boot.
      if (handle !== undefined) {
        void attachSessionToWorkspace(ctx, config.workspace, handle.agent.session.id)
      }
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!NO_FACTORY.test(message) || Date.now() >= factoryRetryDeadline) throw error
      await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
    }
  }
  // The retry loop above either assigns `handle` (then breaks) or throws once
  // the factory deadline passes; TypeScript cannot see past the try/catch, so
  // assert the assignment here instead of reaching for a non-null assertion.
  if (handle === undefined) {
    throw new Error('tui-runtime: agent handle was not established')
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
    // One pass over the log produces the transcript rows, the step list AND
    // the bottom-bar stats (see foldSessionReplay) — a second full walk of a
    // long session log is pure resume latency.
    const replay = foldSessionReplay(agent.session.snapshotEvents())
    store.loadHistory(replay.items, replay.steps)
    store.setStats(replay.stats)
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
  const hasKey = await providerConfigured(ctx, agentOptions.provider ?? 'deepseek-official')
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

  // Did the current turn produce any assistant TEXT (any step)? A max-tokens
  // turn-end with zero body text is a silent stall (the 8k output budget was
  // spent on reasoning) that the UI must explain instead of leaving Idle bare.
  let textSinceThisTurn = false

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (session.id !== sessionId) return
    // Liveness beat: any live event means the run is active, so the status bar
    // can show "Ns since last event" even across silent model stretches.
    store.markActivity()
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
        textSinceThisTurn = true
        // Authoritative text: replace (or create) the assistant row so a
        // streamed, possibly newline-incomplete copy never lingers (headings
        // flush against the content above), and live matches a resumed replay.
        store.settleAssistantText(joined)
        store.setRunPhase('working') // the answer settled; the next event decides (tool/thinking)
        break
      }
      case 'step/start': {
        const data = event.data as { turn?: number; step?: number }
        if (typeof data.turn === 'number' && typeof data.step === 'number') {
          stepStartAt.set(`${data.turn}:${data.step}`, Date.now())
        }
        // A fresh step begins with the model computing (reasoning deltas flip
        // the phase to `thinking` as they arrive).
        store.setRunPhase('working')
        break
      }
      // Between steps the model is computing the next one; keep the phase
      // honest so a silent gap reads as "working", never as Idle.
      case 'step/end': {
        store.setRunPhase('working')
        break
      }
      // Turn bookkeeping for the max-tokens stall hint (C2H): reset the
      // text-produced flag on a fresh turn; explain a silent ceiling hit.
      case 'turn/start': {
        textSinceThisTurn = false
        break
      }
      case 'turn/end': {
        const reason = (event.data as { reason?: { kind?: string } }).reason
        if (reason?.kind === 'max-tokens') {
          if (!textSinceThisTurn) {
            // The whole output budget went to reasoning (no body text yet).
            store.append('status',
              '⚠ 上一轮输出达到长度上限(8192 tok，多为推理消耗)且未产出正文 — 发送任意消息即可继续；长任务可用 Ctrl+T 调低推理档。',
              true)
          } else {
            // Harness-web parity: output was truncated but kept — tell the
            // user to send "continue" so the model resumes from it.
            store.append('status',
              '⚠ 回答被截断：达到输出 token 上限，已输出的内容已保留 — 发送「继续」即可让模型接着输出。',
              true)
          }
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
        store.toolCall(event.data.name, (event.data as { arguments?: string }).arguments)
        break
      }
      case 'tool/result': {
        const data = event.data as { turn?: number; step?: number }
        const key = `${data.turn}:${data.step}`
        const started = toolCallsAt.get(key)?.shift()
        if (started !== undefined) store.accrueTool(Date.now() - started)
        const { text, error } = toolResultDisplay((event.data as { message?: { content?: unknown } }).message)
        store.toolResult({ ok: !error, text })
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
  tui.commands.register({ name: 'think', hint: 'show/hide details under Think and tool rows (reasoning + tool output)', run: () => { store.toggleAllDetail() } })
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
    // A dragged/pasted image becomes an image content block beside the text.
    const image = store.composerImage
    const content: ContentBlock[] = [{ type: 'text', text }]
    if (image !== null) content.push({ type: 'image', attachment: image.ref })
    agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
    store.clearComposerImage()
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
    void providerConfigured(ctx, provider).then(ok => store.setModelLabel(ok ? `${providerName} · ${modelName}${effortSuffix}` : 'not set', ok ? effortDisplay : ''))
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
  // When the FIRST configured provider is added and it is not the built-in
  // DeepSeek route, promote it to the current model immediately. Before any
  // provider exists the selection defaults to (keyless) DeepSeek, so without
  // this the newly added gateway never becomes the usable model until it is
  // manually re-picked — the asymmetry where "first provider = DeepSeek works,
  // first provider = anything else shows not set / seems to fail to add".
  const activateFirstProviderIfNeeded = (provider: string, entries: readonly ProviderModelsEntry[], wasEmpty: boolean): void => {
    if (!wasEmpty || provider === 'deepseek-official') return
    if (store.currentModel.provider === provider && store.currentModel.model !== '') return
    const entry = entries.find((e) => e.provider === provider)
    const model = entry?.models[0]?.model
    if (entry === undefined || model === undefined) return
    store.modelsSaveAction(provider, model)
    store.append('status', `models: activated ${entry.name} · ${modelDisplayName(model)} as the current model`, true)
  }
  store.keyDialogSubmit = (provider: string, name: string, key: string) => {
    if (modelsService === undefined) return
    void (async (): Promise<void> => {
      let wasEmpty = true
      try { wasEmpty = (await modelsService.listConfigured()).length === 0 } catch { /* treat as empty */ }
      const result = await modelsService.setKey(provider, key)
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
            activateFirstProviderIfNeeded(provider, entries, wasEmpty)
            store.openModels(entries, Math.max(0, entries.findIndex((e) => e.provider === provider)))
            // Refresh the total-provider count shown after ＋ Add provider.
            void modelsService.listAll().then((names) => store.setProviderTotal(names.length)).catch(() => {})
            return
          }
          setTimeout(() => refresh(attempts - 1), 120)
        })
      }
      refresh(25)
    })()
  }
  store.providerFormSubmit = (input: AddProviderInput) => {
    if (modelsService === undefined) {
      store.showProviderFormError('models service unavailable')
      return
    }
    void (async (): Promise<void> => {
      let wasEmpty = true
      try { wasEmpty = (await modelsService.listConfigured()).length === 0 } catch { /* treat as empty */ }
      const result = await modelsService.addProvider(input)
      if (!result.ok) {
        store.showProviderFormError(result.error)
        return
      }
      // The settings write commits before the pi-ai adapter re-registers the
      // new route, so poll briefly until the picker can see it.
      const refresh = (attempts: number): void => {
        const entries = buildProviderEntries(modelsService.listProviders())
        if (entries.some((e) => e.provider === input.route.trim()) || attempts <= 0) {
          activateFirstProviderIfNeeded(input.route.trim(), entries, wasEmpty)
          store.openModels(entries, Math.max(0, entries.findIndex((e) => e.provider === input.route.trim())))
          // Refresh the total-provider count shown after ＋ Add provider.
          void modelsService.listAll().then((names) => store.setProviderTotal(names.length)).catch(() => {})
          store.append('status', `models: provider ${input.route.trim()} added`, true)
          return
        }
        setTimeout(() => refresh(attempts - 1), 120)
      }
      refresh(10)
    })()
  }
  store.pauseAgent = () => {
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    store.setPaused(true)
  }
  store.cancelQuestionAction = () => {
    // The model is awaiting the ask_user_question answer; cancelling it must
    // stop the whole task, not just the dialog. Best-effort: an idle agent
    // makes cancel a harmless no-op (the agent/status listener clears running).
    try { agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch { /* best-effort */ }
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
        void attachSessionToWorkspace(ctx, config.workspace, agent.session.id)
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
        void attachSessionToWorkspace(ctx, config.workspace, agent.session.id)
        touchSession(sessionId)
        resetSessionStats()
        const replay = foldSessionReplay(agent.session.snapshotEvents())
        store.loadHistory(replay.items, replay.steps)
        store.setStats(replay.stats)
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

  // ── render-loop watchdog ──────────────────────────────────────────────────
  // A render-loop wedge (a row that stalls Ink's scheduler without throwing —
  // the process stays up and the agent keeps appending events invisibly) shows
  // as a FROZEN screen while the run is actually healthy. Every second while
  // running, check the patched frame writer's last-flush stamp: if no frame was
  // flushed for a while, revive the screen at two levels — store.touch() feeds
  // the normal React/Ink path, and __dshTuiRepaintLastFrame bypasses Ink
  // entirely (the writer rewrites its last known frame straight to stdout).
  // One rate-bounded log line per stall episode documents the freeze for
  // diagnosis (file only — never scribble on the TUI's own terminal).
  const frameGlobals = (): { lastFlush?: number; repaint?: () => void } => {
    const g = globalThis as unknown as { __dshTuiLastFlushAt?: number; __dshTuiRepaintLastFrame?: () => void }
    return { lastFlush: g.__dshTuiLastFlushAt, repaint: g.__dshTuiRepaintLastFrame }
  }
  let stallLoggedAt = 0
  const watchdog = setInterval(() => {
    try {
      if (!store.running || store.paused) { stallLoggedAt = 0; return }
      const now = Date.now()
      const { lastFlush, repaint } = frameGlobals()
      if (lastFlush === undefined) return // no first frame yet (pre-mount)
      if (now - lastFlush < 3000) { stallLoggedAt = 0; return } // healthy
      const stalledFor = Math.max(1, Math.round((now - lastFlush) / 1000))
      if (stallLoggedAt === 0 || now - stallLoggedAt > 10_000) {
        stallLoggedAt = now
        logErrorFileOnly('watchdog', `no Ink frame flushed for ${stalledFor}s while running (agent active) — forcing a repaint`)
      }
      store.touch() // level 1: feed the normal React/Ink render path
      repaint?.() // level 2: bypass Ink, rewrite the last known frame
    } catch {
      // The watchdog never takes the app down.
    }
  }, 1000)
  watchdog.unref?.()

  // Enable raw mode so the terminal owns no input processing.
  if (typeof process.stdin.setRawMode === 'function' && process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  // Calibrate ambiguous glyph widths against the real terminal (CPR/ESC[6n) so
  // rows align for THIS terminal's fonts: measure while idle, re-layout once a
  // width lands. Deferred whenever the agent is busy so probing never contends
  // with streaming frames or typed input.
  initCharWidthCalibration({
    isBusy: () => store.running || store.paused,
    onWidthsChanged: () => store.bumpWidths(),
  })

  // Park the REAL terminal cursor at the composer caret after every full-screen
  // frame, and keep it visible. Ink hides the terminal cursor and (previously)
  // drew its own blinking block; macOS Terminal anchors the IME composition/
  // candidate window to the real cursor position, so a hidden or wandering
  // cursor makes the candidate window jump on every redraw while typing
  // Chinese. The patched Ink frame writer (apps/tui-bin/build.mjs) appends the
  // suffix after all line updates, so the position is never overwritten by the
  // next frame.
  const app = render(<App />)

  // Enable SGR mouse tracking so the terminal sends press/drag/release/wheel
  // events to the app. The stdin decoder turns wheel bytes (64/65) into
  // wheelUp/wheelDown → `store.scrollLines` (rolls the transcript), and
  // press/drag/release into the in-app selection handlers. This takes over the
  // terminal's NATIVE selection and wheel scrollback, which the full-screen
  // surface replaces (the transcript scrolls in-app; dsh-tui draws its own
  // selection). Restored in the exit handler below.
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?1006h\x1b[?1003h') // SGR + any-motion (hover + drag)
  }

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
    if (process.stdout.isTTY) process.stdout.write('\x1b[?1006l\x1b[?1003l') // disable mouse tracking
    process.stdout.off('resize', onResize)
    process.stdin.off('data', onStdin)
    void app.unmount()
    try { process.stdout.write('\x1b[0 q\x1b[?25h\x1b[?1049l') } catch { /* ignore */ }
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
 * The user-questions answerer: present the model's questions in-band as ONE
 * card dock (opencode-style: one question at a time inside the card, answers
 * accumulated, whole batch submitted once every question is answered) and
 * return the human's answers. Single-select options plus a typeable "Other"
 * row whose editor opens inline under the option list — no second dialog.
 * @param request - the ask_user_question request.
 * @returns the structured answers.
 */
async function askUser(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
  const questions = request.questions
  if (questions.length === 0) return { answers: [] }
  try {
    const answers = await new Promise<AskUserQuestionAnswerItem[]>((resolve, reject) => {
      // An abort (tool/step cancelled) must reject the pending ask.
      if (request.signal?.aborted) {
        reject(new Error('ask_user_question was cancelled'))
        return
      }
      const q: PendingQuestion = {
        questions,
        resolve,
        reject,
        active: 0,
        answers: questions.map(() => null),
        highlights: questions.map(() => 0),
        drafts: questions.map(() => ''),
        draftOpen: questions.map(() => false),
        item: questions[0]!,
        index: 0,
        custom: '',
        customMode: false,
        customCursor: 0,
        sel: null,
      }
      store.setQuestion(q)
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
    return { answers }
  } catch (error) {
    // Web-parity cancellation notice (Esc / abort): the pending ask was not
    // submitted.
    store.append('status', 'Question cancelled — answer not submitted', true)
    throw error
  }
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

/** Cap tool-result text for DISPLAY (expanded rows render it; the session log
 *  keeps the full result). Bounded so a single huge tool output cannot balloon
 *  transcript memory over a long session. */
function capToolBody(text: string): string {
  const MAX_TOOL_BODY = 4000
  return text.length <= MAX_TOOL_BODY ? text : `${text.slice(0, MAX_TOOL_BODY)}…`
}

/** Cap raw tool-call arguments stored for summary derivation (bash command,
 *  read path, todo list counts). Only enough for a one-line summary is kept. */
function capToolArgs(argsRaw: string): string {
  const MAX_TOOL_ARGS = 400
  return argsRaw.length <= MAX_TOOL_ARGS ? argsRaw : `${argsRaw.slice(0, MAX_TOOL_ARGS)}…`
}

/** Extract the display text and error flag from a `tool/result` message.
 *  Outputs arrive as nested `tool-result` blocks (`content[]` each holding
 *  inner `text` blocks and an `isError` flag); plain top-level text blocks are
 *  tolerated. Live and resumed (fold) paths share this, so both agree. */
function toolResultDisplay(message: { content?: unknown } | undefined): { text: string; error: boolean } {
  const content = message?.content
  if (!Array.isArray(content)) return { text: '', error: false }
  let text = ''
  let error = false
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; content?: unknown; isError?: unknown }
    if (b.type === 'tool-result') {
      error = error || b.isError === true
      text += flattenContentText(b.content)
    } else if (b.type === 'text') {
      text += String((b as { text?: unknown }).text ?? '')
    }
  }
  return { text, error }
}

/**
 * Fold a persisted session's event log into transcript rows, mirroring what
 * the live `session/event` listener renders — except assistant text comes from
 * the settled `assistant/message` events (streaming chunks are dropped) and
 * the whole result is produced in one pass so a resumed session replays
 * instantly instead of chunk-by-chunk.
 * @param events - the resumed session's full event log.
 * @param stats - optional bottom-bar stats accumulator; when given, each event
 * is folded into it during the same walk so a caller can also obtain the
 * session stats without a second pass over the log (see
 * {@link foldSessionReplay}).
 * @returns the transcript rows and the latest step list.
 */
function foldHistoryEvents(events: readonly SessionEvent[], stats?: SessionStatsFolding): { items: TranscriptItem[]; steps: StepItem[] } {
  const items: TranscriptItem[] = []
  let key = 0
  let steps: StepItem[] = []
  for (const event of events) {
    stats?.observe(event)
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
      case 'assistant/chunk': {
        // Rebuild the Think (reasoning) rows the live path renders: accumulate
        // reasoning deltas into one reasoning item per contiguous run (append
        // to the tail when it is already a reasoning item, mirroring
        // store.streamReasoning). text-delta chunks stay dropped — the settled
        // assistant/message above is the authoritative text.
        const chunk = (event.data as { chunk?: { type?: string; text?: string } }).chunk
        const delta = chunk?.type === 'reasoning-delta' ? chunk.text : undefined
        if (typeof delta === 'string' && delta !== '') {
          const tail = items.at(-1)
          if (tail !== undefined && tail.kind === 'reasoning') {
            items[items.length - 1] = { ...tail, text: tail.text + delta }
          } else {
            items.push({ key: key += 1, kind: 'reasoning', text: delta })
          }
        }
        break
      }
      case 'todo/write': {
        const todos = event.data.todos
        if (todos.length > 0) steps = todos
        break
      }
      case 'tool/call': {
        const argsRaw = (event.data as { arguments?: string }).arguments
        items.push({
          key: key += 1,
          kind: 'tool',
          text: `│ ${event.data.name}`,
          tool: { state: 'running', startedAt: Date.now(), ...argsRaw === undefined ? {} : { argsRaw: capToolArgs(argsRaw) } },
        })
        break
      }
      case 'tool/result': {
        // Mark the most recent running tool row as completed and attach the
        // result/error body — the same shape the live path's
        // store.toolResult() builds, so resume replays byte-identically.
        const { text, error } = toolResultDisplay((event.data as { message?: { content?: unknown } }).message)
        const body = text.trim() === '' ? undefined : capToolBody(text.trim())
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i]
          if (item !== undefined && item.kind === 'tool' && item.text.startsWith('│ ')) {
            const prevTool = item.tool
            const name = item.text.slice(2)
            items[i] = {
              ...item,
              text: error ? `✗ ${name}` : `✓ ${name}`,
              tool: {
                state: error ? 'error' : 'ok',
                ...prevTool?.argsRaw === undefined ? {} : { argsRaw: prevTool.argsRaw },
                ...body === undefined ? {} : { body },
              },
            }
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

/**
 * Single-pass resume replay: fold a persisted session's event log into the
 * transcript rows, the latest step list AND the bottom-bar session stats in
 * one walk (the stats accumulator shares this loop instead of a second full
 * pass over the log — the only reason a long history is ever scanned twice on
 * resume is per-turn tool timing state, which the accumulator keeps itself).
 * @param events - the resumed session's full event log.
 * @returns the transcript rows, the latest step list, and cumulative stats.
 */
function foldSessionReplay(events: readonly SessionEvent[]): { items: TranscriptItem[]; steps: StepItem[]; stats: SessionStats } {
  const stats = createSessionStatsFolding()
  const history = foldHistoryEvents(events, stats)
  return { items: history.items, steps: history.steps, stats: stats.snapshot() }
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
