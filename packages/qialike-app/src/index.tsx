/**
 * @yourname/qialike-app — a full-screen Ink/React terminal surface. The bundle
 * patch rides over dsh-base without an HTTP host or browser; this runtime
 * creates one Agent through the core registry, streams its session events into
 * an Ink transcript, and drives user input back in via `followup()` / `steer()`.
 *
 * Surface features (each owned here, none touching the harness core):
 *   - slash command palette (type `/`)
 *   - a `approval/request` answerer that prompts for tool approval in-band
 *   - launch resume (`resume` positional, or the opt-in `resume_last`) and
 *     `--resume <id>` over persisted sessions
 *   - a two-panel layout (conversation + activity) and an input dock
 *
 * @module @yourname/qialike-app
 */

// FIRST import on purpose: `legacy-names.ts` mirrors `DSH_TUI_*` onto
// `QIALIKE_*` at module load, before this file's own module-scope env reads
// (SPLASH_DELAY_MS) and before any other module's.
import { migrateLegacyHomeFiles } from './legacy-names.ts'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { render, Box, Text } from 'ink'
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { lastSandboxMode, partialEnforcementNotice, readOnlyBashDecision, unconfinedShellAskDecision, type SandboxMode } from './bash-policy.ts'
import { blockedReadDecision } from './read-policy.ts'
import { turnEndNotice, type TurnEndReasonLike } from './turn-end-notice.ts'
import { BUILD_MODE } from './build-mode.ts'
import { versionFooterSuffix } from './version-footer.ts'
import { SessionLogReader } from './log-frames.ts'
import { sanitizeTerminalText } from './terminal-safe.ts'
import type { AgentHandle, ModelSelection, ModelSelectionRef, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { ManualCompactionError, type CompactionResult, type ManualCompactAgentContext, type ManualCompactionErrorCode } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { listSessionFiles, projectKey, resolveSessionLogPath, sessionDir, sessionInspector } from './session-files.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { existsSync, readdirSync } from 'node:fs'
import { probeSessionHead } from './session-head.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
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
import { registerUpdateSettings } from './upgrade-policy.ts'
import { isNewerAvailable, parseUpdateReport, updateHintText, updateNoticeLines, type UpdateOffer } from './update-hint.ts'
import { emptySessionStats, createSessionStatsFolding, type SessionStats, type SessionStatsFolding } from './session-stats.ts'

import { readHiddenProviders, readSidebarMode, resolveResumeLast, setHiddenProviders, setSidebarMode as persistSidebarMode, type SidebarMode } from './config.ts'
import { findReusableBlank, foldSessionBlank, isPinned, listRowHeaders, prewarmTitles, rememberBlank, rememberFoldedTitle, rememberTitle, sessionBlank, sessionDisplayTitle, setHeadTitleProbe, type SessionHeaderLike, type SessionTitlesPersistence } from './session-titles.ts'
import { lastActivity, touchSession } from './session-activity.ts'
import { theme, type ThemePalette } from './theme.ts'
import { StdinDecoder, type RawKey } from './stdin.ts'
import { initCharWidthCalibration } from './charwidth.ts'
import { isPlanReview, extractPlanMarkdown, EXIT_PLAN_TOOL } from './plan-review.ts'
import { isMultiSelect } from './question-layout.ts'
import { describeResumeFailure, isCorruptLogMessage, planOlderRanges, planResumeFold, safeBoundaries, tailSlice, withResumeCorruptRetry } from './resume-fold.ts'
import { initErrorLog, logError, logConsoleError, logErrorFileOnly } from './log.ts'
import { armPostExitNotices, flushPostExitNotices, postExitNotice } from './post-exit-notice.ts'
import { outsideOpenDialogList } from './list-geometry.ts'
import { FilesChangedLedger, filesChangedLine } from './files-changed.ts'
import pkg from '../../../package.json' with { type: 'json' }

/** Stable Cordis plugin name. */
export const name = 'tui-runtime'

/** Project version (single source of truth: the root package.json). */
export const APP_VERSION = (pkg as { version?: string }).version ?? '0.0.0'

/** Footer suffix for the sidebar's version line, from the BAKED build channel
 *  (`QIALIKE_BUILD_MODE` at build time — see `./version-footer.ts`). `prod` and
 *  an unset variable both show the bare version. Baked rather than read from the
 *  environment here, so a released binary cannot be relabelled at launch. */
export const VERSION_FOOTER_SUFFIX = versionFooterSuffix(APP_VERSION, BUILD_MODE)

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
  /** Positional `resume`: continue the newest session WITH CONTENT in this
   *  directory and open the conversation view directly. A bare launch never
   *  auto-resumes (it opens/reuses the New Session placeholder + hero). */
  resumeNewest: boolean | undefined
  model: string | undefined
}

export const Config: z<Config> = z.object({
  workspace: z.string().required(),
  resume: z.string(),
  resumeNewest: z.boolean(),
  model: z.string(),
})

/** One rendered transcript line. */
export interface TranscriptItem {
  readonly key: number
  readonly kind: 'user' | 'assistant' | 'reasoning' | 'status' | 'tool' | 'error' | 'plan' | 'compaction'
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
  /** Compaction-checkpoint payload: one DISCLOSURE row standing for the span of
   *  older history the harness replaced with a summary. `summary` is the
   *  markdown the summarizer wrote (embedded in the checkpoint message itself),
   *  and the counts come from the paired `compaction/summary` event. */
  readonly compaction?: CompactionRowFacts
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

/** Session file-permission mode, cycled by Tab in the composer (matches the web surface).
 *  The union itself lives in `bash-policy.ts`, next to the rule it selects. */
export type { SandboxMode }
export const SANDBOX_CYCLE: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']
/** Status-bar labels for the sandbox modes. Exported so the decoupling
 *  contract is testable (fix 3, qialike-security.md). */
export const PERMISSION_LABEL: Record<SandboxMode, string> = {
  'read-only': 'Read Only',
  'workspace-write': 'Workspace Write',
  // Mode and approval policy are decoupled (fix 3, qialike-security.md): Full
  // access lifts the file boundary only; tool approvals still ask unless the
  // user picks Allow always per tool.
  'danger-full-access': 'Full access',
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
  /** Creation timestamp (local epoch ms). */
  readonly createdAt?: number
  /** Last-used timestamp (local epoch ms) when known, else `createdAt`. The
   *  dialog SORTS, GROUPS and LABELS by this one value (F9) — sorting by it and
   *  labelling by `createdAt` is what made the order look wrong. */
  readonly activityAt?: number
  /** Unused "New Session" placeholder (no turn/start yet) — web parity: the
   *  workspace browser shows only the SELECTED blank entry and New Session
   *  reuses an existing blank instead of minting a new id. */
  readonly blank?: boolean
  /** /sessions dialog extras (harness list projection). */
  readonly running?: boolean
  readonly completed?: boolean
  readonly updatedAt?: number
}

/** What the approval dock needs from a request in flight: the tool and the
 *  asker's reason. Structural rather than the harness's full `ApprovalRequest`,
 *  which carries a live `Agent` the dock has no use for. */
export interface ApprovalPrompt {
  readonly toolName: string
  readonly reason?: string
}

/** An in-progress tool approval question awaiting the user's decision. */
export interface PendingApproval {
  readonly req: ApprovalPrompt
  readonly resolve: (outcome: ApprovalOutcome) => void
}

/** One in-band user-question ask shown as a single card dock. A request may
 *  carry several questions; the card shows them ONE at a time, keeps each
 *  committed answer, and submits the whole batch once every question is
 *  answered (question-dock semantics — no popup-per-question).
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
  /** Committed answers per question (index-aligned); null = not answered yet.
   *  `multi` carries a multi-select question's checked labels (plus its typed
   *  "Other" text, when any — the harness accepts both together). */
  answers: ({ kind: 'option'; label: string } | { kind: 'multi'; labels: readonly string[]; custom?: string } | { kind: 'custom'; text: string } | null)[]
  /** Last highlighted row per question (option index; `options.length` = the
   *  "Other" row). */
  highlights: number[]
  /** Draft "Other" text per question, kept while navigating back/forth. */
  drafts: string[]
  /** Whether the "Other" inline editor was open when the question was left. */
  draftOpen: boolean[]
  /** Checked option LABELS per question — the LIVE multi-select draft, toggled
   *  by Space/digits/a click and committed by Enter; navigating away and back
   *  keeps it. Single-select questions never read or write it. */
  picks: string[][]
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

/** Phases of one session switch, in display order. */
export type SessionLoadPhase = 'opening' | 'attaching' | 'tail' | 'index' | 'ready'

/** One row of the switch dialog. A step is either DONE (`ms` set), ACTIVE (last
 *  step without `ms`) or PENDING. `progress` exists only where the phase has a
 *  real denominator — the harness session-open exposes none, so showing a bar
 *  there would be a lie. */
export interface SessionLoadStep {
  readonly phase: SessionLoadPhase
  /** Row label (English). */
  readonly label: string
  /** Wall time the finished step took (ms); undefined while running/pending. */
  readonly ms?: number
  /** Real counts for this step (events), when the phase has them. */
  readonly progress?: { readonly done: number; readonly total: number }
}

/** In-flight session SWITCH (the `/sessions` picker's Enter): non-null from the
 *  moment the target is picked until the new transcript is on screen.
 *
 *  Why the UI needs a state at all: opening a durable session
 *  (`agents.resume`) decodes its whole log inside the harness (no progress
 *  API, and it BLOCKS the single JS thread — measured `openTicks=0`), and the
 *  /sessions panel is already closed by then, so without a dialog the screen
 *  simply looks frozen. */
export interface SessionLoadingState {
  /** Target session id. */
  readonly id: string
  /** Display title, when the picker row had one. */
  readonly title?: string
  /** Durable log size in bytes (`session.jsonl.zstd`), when stat-able. */
  readonly bytes?: number
  /** Epoch ms the switch started (drives the live elapsed seconds). */
  readonly startedAt: number
  /** The load is expected to LAND ON the hero (a flat launch or `/new`): keep the
   *  hero up while it runs instead of painting the docked chrome first. Absent for
   *  a `/sessions` switch, which needs that chrome for its progress slot. */
  readonly keepHero?: boolean
  /** Steps in display order; the last entry is the ACTIVE one. */
  readonly steps: readonly SessionLoadStep[]
}

/** Fixed label per phase (the dialog's rows). */
const SESSION_LOAD_LABELS: Record<SessionLoadPhase, string> = {
  opening: 'Opening session log',
  attaching: 'Attaching session',
  tail: 'Folding recent tail',
  index: 'Scanning index',
  ready: 'Ready',
}

/** S2-2b: transcript status row appended when phase 1's file-first screen
 *  becomes the interactive read-only view (attach still pending).
 *
 *  Claims only what actually works before the attach: scrolling (PgUp/PgDn,
 *  wheel, Home/End), mouse drag-select + Ctrl+Y copy, and `/export`. There is
 *  NO transcript search in this TUI — an earlier revision of this string said
 *  "search", which was simply false (caught 2026-09-12). Anything that needs the
 *  agent (`/sessions` `/new` `/compact` `/goal` `/plan` `/models`) attaches first. */
export const READ_ONLY_HINT =
  'Read-only view from the session log — the session attaches on your first message; '
  + 'scrolling, drag-select + Ctrl+Y copy and /export work now.'

/** S2-2b: the leading "older history" marker while the read-only view is up and
 *  no fold driver is running (the real fold starts with the attach). */
export const READ_ONLY_OLDER_HISTORY =
  'Older history:  not loaded yet — the full log is folded once the session attaches (send a message to attach now)'

/** S2-2b: slash commands that need the live harness agent and are therefore
 *  DEFERRED (queued + replayed through the normal Enter path) while the
 *  read-only view is up. Read-only commands (`/export`, `/sidebar`, `/theme`,
 *  `/help`-class dialogs) run immediately. */
export const ATTACH_DEFERRED_COMMANDS: ReadonlySet<string> =
  new Set(['new', 'sessions', 'compact', 'goal', 'plan', 'models'])

/** Percent (0–100, clamped) of a step's real counts. */
export function sessionLoadPercent(progress: { done: number; total: number }): number {
  if (!Number.isFinite(progress.done) || !Number.isFinite(progress.total) || progress.total <= 0) return 0
  const pct = (progress.done / progress.total) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

/** ASCII-safe progress bar (`█` when the terminal advances it one column, else
 *  `#`) with `·` cells — width-exact, never wraps the dialog. */
export function sessionLoadBar(progress: { done: number; total: number }, width: number, blockGlyph = true): string {
  const w = Math.max(4, Math.floor(width))
  const filled = Math.round((sessionLoadPercent(progress) / 100) * w)
  const full = blockGlyph ? '█' : '#'
  return full.repeat(filled) + '·'.repeat(Math.max(0, w - filled))
}

/** Human byte size for the banner (`18.4 MB`). */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** One-line, English, honest banner text for the in-flight switch.
 *
 *  There is deliberately NO percentage (the harness session-open exposes no
 *  progress) and — measured on a 1.43 M-event session, `openTicks=0` — the
 *  open BLOCKS the one JS thread, so a live seconds counter would freeze at
 *  `0.0s` and read like a hang. The elapsed tail is therefore shown only once
 *  the ticker has actually fired (proof the loop is alive); otherwise the line
 *  states what is happening, without a lying clock. */
/** One-line STATUS-BAR text for the in-flight switch: the ACTIVE phase plus
 *  the target session (and the log size). Same honesty rule as
 *  {@link sessionLoadingText}: the elapsed tail appears only once the ticker
 *  proved the event loop is alive. */
export function sessionLoadingStatusText(state: SessionLoadingState, now: number, showElapsed = true): string {
  const active = state.steps[state.steps.length - 1]
  const label = active === undefined ? 'opening session log' : active.label.toLowerCase()
  return `Load session:  ${label} · ${sessionLoadingText(state, now, showElapsed)}`
}

/** Dialog HEADER: the target session, its log size and (only when the event
 *  loop proved alive) the elapsed seconds. */
export function sessionLoadingText(state: SessionLoadingState, now: number, showElapsed = true): string {
  const rawTitle = state.title !== undefined && state.title.trim() !== '' ? state.title.trim() : ''
  const id = String(state.id)
  const label = rawTitle !== '' ? rawTitle : `${id.slice(0, 8)}…${id.slice(-4)}`
  const size = state.bytes === undefined ? '' : ` — ${formatByteSize(state.bytes)} log`
  if (!showElapsed) return `${label}${size}`
  const secs = Math.max(0, (now - state.startedAt) / 1000).toFixed(1)
  return `${label}${size} · ${secs}s`
}

/** Short, status-bar-sized wording for a FAILED session load. The full
 *  explanation (both possible causes for a corrupt log, the raw harness error
 *  otherwise) stays in the transcript row — a status bar cannot wrap. */
export function sessionLoadErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (isCorruptLogMessage(message)) return 'Load session failed: corrupt session log — see transcript'
  const first = (message.split('\n')[0] ?? '').trim()
  const clip = first.length > 78 ? `${first.slice(0, 77)}…` : first
  return `Load session failed: ${clip === '' ? 'unknown error' : clip}`
}

/** Status-bar label shown while the harness assembles a model request.
 *
 *  Why it exists: submitting is fast (`agent.followup()` returns in ~25-58 ms,
 *  the first event 1-35 ms later) — what freezes the UI for **4-6 s** on a
 *  1.45 M-event session is the request assembly that happens SYNCHRONOUSLY on
 *  this same thread right after `step/start` (user log: `[stall] main loop
 *  blocked for 4s`, repeatedly, around submits). Nothing can repaint during that
 *  block, so the label is set at the last moment we control — on `step/start`
 *  (and on submit, before the turn's first step) — and `paintBeforeBlock()`
 *  flushes the frame BEFORE the thread is taken. It clears on the first content
 *  event of that step (chunk / tool call / settled message / turn end). */
export const PREPARING_REQUEST_LABEL = 'preparing the request…'

/** Safety deadline for the ASSEMBLY phase of a request: the synchronous assembly
 *  runs on this thread and reports its end through `noteAssemblyElapsed` (`llm.ts`
 *  `noteRequest`); if nothing ever answers, the label must not stick forever.
 *  Enforced by the preparing ticker (`tickPreparingRequest`) rather than by a
 *  timer of its own, so the deadline belongs to the window and cannot outlive it
 *  (the old submit-scoped `setTimeout` was never cleared on success and could
 *  cut a LATER window short). */
export const PREPARING_ASSEMBLY_DEADLINE_MS = 30_000

/** Safety deadline for the PROVIDER phase. Once the payload exists the remaining
 *  wait is the provider's time-to-first-token, which is far longer than the
 *  assembly budget — measured `streamToChunk` median 1.4 s on this workstation's
 *  `~/.dsh/qialike.log`, and tens of seconds on the machine that reported
 *  "准备任务包需要的时间难以接受". Enforcing the assembly deadline across that
 *  phase would reproduce the exact "preparing" misreport this split removes, so
 *  the deadline is re-armed when the assembly ends. */
export const PREPARING_PROVIDER_DEADLINE_MS = 300_000

/** The label of the SECOND phase: the request is out and the model has not
 *  answered yet. */
export const WAITING_FOR_MODEL_LABEL = 'waiting for the model…'

/** Status-bar text for the SECOND phase, `waiting for the model… 12.3s`: this
 *  phase's OWN information and clock, nothing else (user request: the two phases
 *  are two parts, each showing its own).
 *
 *  Why the phases are split at all: `assemblyMs` is the app's WHOLE synchronous
 *  assembly, reported by `llm.ts` the moment the payload string exists, while what
 *  the user actually waits next is the provider's time-to-first-token
 *  (`streamToChunk` in the same `[assembly]` log line). Measured on this
 *  workstation's `~/.dsh/qialike.log` (731 records ending 2026-09-16): assembly
 *  median 9 ms / p90 29 ms / max 84 ms, `streamToChunk` median 1.4 s / p90 3.0 s /
 *  max 11.8 s; the macOS session that filed the report saw the same asymmetry
 *  with waits above 100 s. One label ("preparing the request…") covered BOTH
 *  phases, so a two-minute model wait read as two minutes of request preparation.
 *  The assembly's own cost is measured and logged (`[assembly] … assemblyMs=`),
 *  and shown live by phase one; phase two does not repeat it.
 *
 *  The wait clock needs no ticker gate: the assembly that could block the loop is
 *  over and the request is in flight, so the seconds advance with the same 250 ms
 *  ticker that keeps phase one honest.
 *  @param waitMs - milliseconds since the payload left, i.e. the provider wait.
 *  @returns the status-bar string. */
export function waitingForModelStatusText(waitMs: number): string {
  return `${WAITING_FOR_MODEL_LABEL} ${(Math.max(0, waitMs) / 1000).toFixed(1)}s`
}

/** Status-bar text of the request's two phases: `preparing the request… 4.4s`
 *  while the harness assembles this step's payload, then
 *  {@link waitingForModelStatusText} once the payload exists — each phase showing
 *  its own information and its own clock.
 *
 *  Why the ticker gates PHASE ONE's clock: the frame carrying this label is
 *  flushed right before the harness may take the thread, so a clock printed at
 *  that moment would be frozen at `0.0s` and read as a hang. Only a tick proves
 *  the loop is servicing timers; otherwise the seconds appear once the block is
 *  over (and may be superseded at once by the step's first content). Phase two
 *  needs no gate: the assembly that could block the loop is over.
 *  @param startedAt - epoch ms the assembly began, or null when idle.
 *  @param now - current epoch ms (injectable for tests).
 *  @param ticked - whether the preparing ticker fired since the assembly began.
 *  @param assemblyMs - measured assembly time in ms, or null while still running
 *    (it is also what marks the switch to phase two).
 *  @param assemblyDoneAt - epoch ms the payload left (phase two's clock origin),
 *    or null when unknown.
 *  @returns the status-bar string. */
export function preparingRequestStatusText(
  startedAt: number | null,
  now: number,
  ticked: boolean,
  assemblyMs: number | null = null,
  assemblyDoneAt: number | null = null,
): string {
  if (startedAt === null) return PREPARING_REQUEST_LABEL
  if (assemblyMs !== null) {
    return waitingForModelStatusText(assemblyDoneAt === null ? 0 : now - assemblyDoneAt)
  }
  if (!ticked) return PREPARING_REQUEST_LABEL
  return `${PREPARING_REQUEST_LABEL} ${Math.max(0, (now - startedAt) / 1000).toFixed(1)}s`
}

/** Mutable UI store the Ink app subscribes to. */
/** S0 assembly probe (`session/optimization-plan.md` §3): true when the harness's
 *  `derived`/`frozenMessages` caches are cold — set on every attach (launch /
 *  switch / new) because a fresh Session+Agent instance has to derive and
 *  deep-freeze the whole context on its first request (the 4-6 s class). */
let coldNextRequest = true

export class Store {
  /** The transcript rows. Mutated **in place** — the array identity is stable by
   *  design, so re-render invalidation is signalled by {@link Store.itemsRev}
   *  and NOT by `items !== previousItems`. (Every streamed delta used to copy
   *  the whole array: O(n) per chunk, i.e. O(n²) per answer, and two full copies
   *  alive at once — the peak measured while loading a giant session.) Consumers
   *  that memoize on the rows must depend on `itemsRev`. */
  private items: TranscriptItem[] = []
  /** Monotonic revision of {@link Store.items}. Bumped by the three writers
   *  below and read by the transcript panel's row memo. */
  private _itemsRev = 0
  private key = 0
  /** Key of the leading "loading older history" marker row while a chunked
   *  resume is still folding older slices in the background, or -1 when the
   *  full history is present (the marker row is always items[0]). */
  private _historyMarkerKey = -1
  /** Number of OLDER-history items currently loaded behind the marker (rows
   *  inserted by {@link prependHistory}); lets the resume driver bound memory
   *  and trim the oldest loaded slices while the user reads the live tail. */
  private _loadedOlder = 0
  /** Highest older-event count reported so far (the marker's bar is monotonic). */
  private _historyProgressMax = 0
  /** Total older events the driver will report against (bar denominator). */
  private _historyTotal = 0
  /** True while the driver WAITS instead of folding (at the tail budget, or
   *  because the reader sits mid-transcript): a resting state, not a stall. */
  private _historyHolding = false
  /** True once the load reached its resting state for the CURRENT view: the
   *  status bar then shows ONE completion message and hides the progress. */
  private _historySettled = false
  private version = 0
  private listeners = new Set<() => void>()
  private _input = ''
  private _cursor = 0
  private _composerImage: ComposerImage | null = null
  private _panel: 'conversation' | 'approval' | 'connect' | 'question' | 'sessions' | 'export' | 'help' | 'themes' | 'file-refs' = 'conversation'
  /** One-line hint that a newer qialike is waiting; null when there is nothing to say. */
  private _updateHint: string | undefined
  private _commandFilter = ''
  private _commandIndex = 0
  private _approval: PendingApproval | null = null
  /** In-flight session switch (banner + key suppression); null when idle. */
  private _sessionLoading: SessionLoadingState | null = null
  /** True while a step's request is being assembled (see
   *  {@link PREPARING_REQUEST_LABEL}). */
  private _preparingRequest = false
  /** Epoch ms the in-flight assembly began (null when idle). */
  private _preparingStartedAt: number | null = null
  /** True once the preparing ticker fired (loop alive → show elapsed). */
  private _preparingTicked = false
  /** Measured assembly time of the step in flight, or null while it is still
   *  being assembled; it is also what switches the status bar to phase two. */
  private _assemblyMs: number | null = null
  /** Epoch ms the payload left, i.e. phase two's clock origin, or null when the
   *  assembly has not finished (or nothing is in flight). Taken at
   *  {@link noteAssemblyElapsed} rather than derived from the assembly start, so
   *  the wait clock does not inherit the submit → `step/start` gap. */
  private _assemblyDoneAt: number | null = null
  /** Wall-clock deadline for the CURRENT preparing window, or null when idle.
   *  Armed for the assembly phase by {@link beginPreparingRequest}, re-armed for
   *  the provider phase by {@link noteAssemblyElapsed}, enforced (and cleared) by
   *  {@link tickPreparingRequest} / {@link endPreparingRequest}. */
  private _preparingDeadlineAt: number | null = null
  /** In-flight manual `/compact` (status bar + Esc cancel), or null. */
  private _compaction: CompactionState | null = null
  /** True once the compaction ticker fired (loop alive → show elapsed). */
  private _compactionTicked = false
  /** Abort seam installed by {@link compact} while a compaction runs. */
  private _cancelCompaction: (() => void) | null = null
  /** True when the session was too large for the full stats pass (P2① mode A):
   *  the numbers cover the LOADED window and the status bar says so. */
  private _statsWindowOnly = false
  /** Last FAILED session load (short wording) — shown in the status bar until
   *  the next load attempt or an explicit dismiss, because the user has to be
   *  able to read WHY the session did not open. */
  private _loadError: string | null = null
  /** True once the loading ticker fired at least once — i.e. the event loop was
   *  free during the open (see {@link sessionLoadingText}). */
  private _sessionLoadingTicked = false
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
  /** S2-2b: the user cycled the sandbox chip while the read-only view was up. */
  private _readOnlyPermissionPicked = false
  private _modelLabel = ''
  private _modelEffortName = ''
  /** Whether the CURRENT provider has what it needs to run (its own credential,
   *  or none required). `undefined` until the launch's credential probe settles:
   *  the hero hint keys off this rather than string-matching "not set". */
  private _providerReady: boolean | undefined = undefined
  private _session: Session | undefined
  /** S2-2b: id of the session whose log was painted READ-ONLY (phase 1) while
   *  the harness attach is still pending. It keeps the docked chrome up (the
   *  hero would hide the painted transcript) without pretending a load is in
   *  flight, and it answers the few read-only consumers that need a session id
   *  (`/export`, the footer) before `setSession` lands. */
  private _readOnlySessionId: string | undefined
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
  /** Bumped when the transcript is replaced wholesale (clear / loadHistory /
   *  beginHistory): numeric item keys are then REUSED, so row-keyed caches
   *  (e.g. the debounced markdown-height estimates) must drop on this — NOT
   *  on measure/expansion churn, which never re-keys items. */
  private _loadGeneration = 0
  /** Tool row currently under the mouse (hover affordance: "clickable"), or
   *  null. Only set when the row is a settled tool with a body. */
  private _hoveredToolKey: number | null = null
  /** Row → transcript item resolver installed by the conversation panel each
   *  render (mouse clicks on a tool row toggle its expansion). */
  private _rowResolver: ((row: number) => TranscriptItem | null) | null = null
  /** Whether the user submitted anything in the CURRENT session yet (web
   *  parity: the blank→engaging flip happens locally, on the submit's own
   *  frame, so the hero screen leaves immediately). */
  private _promptAttempted = false
  /** Whether the HERO may still show at all. The hero is the LAUNCH placeholder
   *  (a bare `qialike`): any explicit session action — `/new`, a `/sessions`
   *  switch — means the user asked for a CONVERSATION view, so the hero is left
   *  for good, blank session or not. */
  private _heroAllowed = true
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
  /** The repository-overlay line this launch applied (or skipped), for the hero. */
  private _repoOverlayNotice: string | undefined
  get repoOverlayNotice(): string | undefined { return this._repoOverlayNotice }
  setRepoOverlayNotice(text: string): void {
    this._repoOverlayNotice = text
    this.notify()
  }
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
   *  never double-highlighted by the frame buffer.
   *
   *  A guard may also return CLAMPED `anchor`/`focus` (1-based SGR): while a
   *  dialog is up the guard clamps the drag endpoints to the dialog's text box,
   *  so a gesture that leaves the box copies the dialog text only and never the
   *  transcript painted around it. Without them the raw selection endpoints are
   *  used (the conversation surface's own behavior). */
  private _frameGuard: ((sel: { aRow: number; aCol: number; cRow: number; cCol: number }) => { rect: { x1: number; y1: number; x2: number; y2: number } | null; left: number; right: number; anchor?: { row: number; col: number }; focus?: { row: number; col: number } } | null) | null = null
  setFrameSelectionGuard(fn: (sel: { aRow: number; aCol: number; cRow: number; cCol: number }) => { rect: { x1: number; y1: number; x2: number; y2: number } | null; left: number; right: number; anchor?: { row: number; col: number }; focus?: { row: number; col: number } } | null): void {
    this._frameGuard = fn
  }

  /** True when the CONVERSATION surface cannot be laid out honestly at the
   *  current terminal height (see `layout-budget.ts`) and the panel paints the
   *  one-row notice instead. Published by the conversation panel during render
   *  (notify-free: it never affects a frame) because that panel is the only
   *  place that knows exactly what it painted. `handleKey` reads it to STOP
   *  dispatching keys: the notice replaced the docks/composer, but `store.panel`
   *  still routes keys to them — with an approval pending, Enter would settle the
   *  DEFAULT choice ("Allow once") on a prompt the user cannot see. */
  private _surfaceTooSmall = false
  get surfaceTooSmall(): boolean { return this._surfaceTooSmall }
  setSurfaceTooSmall(value: boolean): void {
    this._surfaceTooSmall = value
  }

  /** Render-coalescing window (ms): store mutations schedule AT MOST one
   *  subscriber render per window, so a session-event storm (hundreds of
   *  streamed deltas per second) paints at ≤40 fps instead of once per event —
   *  each event would otherwise force a full ConversationMain render + layout
   *  pass over the whole transcript. Interactive input latency stays under one
   *  window; internal arrays are mutated synchronously, only the subscriber
   *  render is deferred, so no intermediate state is ever lost. */
  private static readonly NOTIFY_BATCH_MS = 25
  private static readonly NOTIFY_LEGACY = /^(1|true|yes|on)$/i.test(process.env.QIALIKE_LEGACY_NOTIFY ?? '')
  private _notifyTimer: ReturnType<typeof setTimeout> | null = null
  private _notifyScheduled = false
  /** Epoch ms of the last store mutation (any `notify`): lets a frame-gap probe
   *  tell a STALL (a mutation was pending and no frame came) from plain
   *  IDLENESS (nothing changed, so Ink paints nothing). */
  private _lastMutationAt = 0
  get lastMutationAt(): number { return this._lastMutationAt }
  /** Settlement counter for the transcript's height model: bumped by
   *  {@link settleAssistantText} so the panel knows an authoritative assistant
   *  text landed and its debounced markdown-height estimate must be re-parsed
   *  (see the why there). Read by the conversation panel's layout memo. */
  private _assistantSettleEpoch = 0
  get assistantSettleEpoch(): number { return this._assistantSettleEpoch }
  /** Row key of the item the last settlement replaced. The transcript panel
   *  busts the debounced markdown estimate for THAT row only, instead of
   *  invalidating every row's estimate (measured: a global bump re-parsed all
   *  ~5.1k markdown rows, 0.72 s on every assistant settle). */
  private _lastSettledKey = -1
  get lastSettledKey(): number { return this._lastSettledKey }

  /** Request a repaint without changing state: a plugin that keeps its own
   *  view state (e.g. the `@file` palette's candidate index) has no store
   *  field to mutate, and `notify` is private to the store. */
  repaint(): void { this.notify() }

  private notify(): void {
    this._lastMutationAt = Date.now()
    if (Store.NOTIFY_LEGACY) {
      // Plan-B A/B switch (QIALIKE_LEGACY_NOTIFY=1): the pre-优化2 behavior —
      // coalesce a burst of synchronous updates into ONE render per microtask
      // (per-macrotask) instead of the 25ms render window.
      if (this._notifyScheduled) return
      this._notifyScheduled = true
      queueMicrotask(() => {
        this._notifyScheduled = false
        this.version += 1
        for (const listener of this.listeners) listener()
      })
      return
    }
    if (this._notifyTimer !== null) return
    this._notifyTimer = setTimeout(() => {
      this._notifyTimer = null
      this.version += 1
      for (const listener of this.listeners) listener()
    }, Store.NOTIFY_BATCH_MS)
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

  /** Repaint after an asynchronous title-cache write: the sidebar session
   *  title renders from the cache, so a title that lands after the last
   *  transcript event would otherwise stay invisible until the next unrelated
   *  state change forces a render. */
  notifyTitles(): void { this.notify() }

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
  currentModel: { provider: string; model: string; reasoningEffort?: string } = { provider: 'deepseek-official', model: 'deepseek-flash' }
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
  /** S2-2b hook consulted BEFORE a slash command runs (injected by `start()`
   *  while the harness attach is still pending): returns false when the command
   *  was deferred until the session is attached — the caller then does NOT run
   *  it. Undefined once the setup is complete, so commands run directly. */
  beforeCommand: ((name: string, text: string) => boolean) | undefined = undefined
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
  /** Revision of the in-place transcript array (see {@link Store.items}). The
   *  panel's row memo keys on THIS: the array identity never changes, so an
   *  identity-keyed memo would silently stop recomputing. */
  get itemsRev(): number { return this._itemsRev }
  /** The ONLY writers of {@link Store.items}. Each bumps {@link Store.itemsRev},
   *  so no mutation can be invisible to the render path (a source guard in
   *  `tests/items-inplace.test.ts` pins that down). */
  private pushItem(item: TranscriptItem): void { this.items.push(item); this._itemsRev += 1 }
  private setItemAt(index: number, item: TranscriptItem): void { this.items[index] = item; this._itemsRev += 1 }
  private replaceItems(next: TranscriptItem[]): void { this.items = next; this._itemsRev += 1 }
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
  /** The update hint, or null when there is no newer release to report. */
  get updateHint(): string | undefined { return this._updateHint }
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
  /** Clear the whole rename input (`Ctrl+U`; the rename box is single-line). */
  sessionsRenameClear(): void {
    if (this._sessionsRenameInput === '') return
    this._sessionsRenameInput = ''
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
  /** Clear the whole file name (`Ctrl+U`; the field is single-line). */
  exportNameClear(): void {
    this._exportNameEdited = true
    if (this._exportName === '') return
    this._exportName = ''
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
  /**
   * Record that a newer release is waiting, as the one-line hint the hero row and the
   * docked status bar both paint.
   *
   * Only Windows reaches this (`process.platform` gates every caller): that platform
   * cannot install a release by itself, so the user has to fetch it, and a status line
   * is where they will see it. No dialog — this is news, not a question, and a
   * takeover would interrupt whatever they were typing.
   */
  noteUpdate(offer: UpdateOffer): void {
    const hint = updateHintText(offer)
    if (this._updateHint === hint) return
    this._updateHint = hint
    this.notify()
  }
  /** Drop the hint (the release is no longer newer, or the check could not run). */
  clearUpdateHint(): void {
    if (this._updateHint === undefined) return
    this._updateHint = undefined
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
    // Pinned sessions sort to the top; within each group, most recently USED
    // first. The /sessions day grouping (sessions.tsx dayLabel) needs one
    // chronological value — without it the same day label recurs
    // non-contiguously, producing duplicate group-header React keys whose
    // reconciliation corrupts the dialog (a doubled filter line / garbled rows).
    // The sort key and the row label are both `activityAt ?? createdAt` (F9), so
    // the order and the clocks can never contradict each other.
    return [...base].sort((a, b) =>
      (isPinned(b.id) ? 1 : 0) - (isPinned(a.id) ? 1 : 0)
      || (b.activityAt ?? b.createdAt ?? 0) - (a.activityAt ?? a.createdAt ?? 0))
  }
  get secret() { return this._secret }

  append(kind: TranscriptItem['kind'], text: string, dim = kind === 'reasoning' || kind === 'status'): void {
    this.pushItem({ key: this.key += 1, kind, text, dim })
    this.notify()
  }

  /** Append a compaction-checkpoint DISCLOSURE row (one collapsed line standing
   *  for the history the harness replaced, expandable to the summary). Replaces
   *  the generic `Context injection · compact` status row that used to hide both
   *  the counts and the summary — and it is the same row for a live compaction
   *  and for a resumed log, because the facts come from the durable events. */
  appendCompaction(facts: CompactionRowFacts): void {
    this.pushItem({
      key: this.key += 1,
      kind: 'compaction',
      text: facts.summary ?? '',
      compaction: facts,
    })
    this.notify()
  }

  /** Append a RUN-FAILURE row (provider/billing/quota error, transport after
   *  retries, credential problems…). Harness-web turn-error parity: a visible
   *  error row, not a silent stop — the user can send another message to
   *  start a fresh turn (quota/billing failures are NOT auto-retried). */
  appendRunError(text: string): void {
    this.pushItem({ key: this.key += 1, kind: 'error', text })
    this.notify()
  }

  /** Append a running tool-call row (rendered inline). The raw
   *  arguments are kept (capped) for the one-line summary derivation; the
   *  start timestamp feeds the row's live elapsed-seconds tail.
   *
   *  A plan submitted for review (harness `exit_plan_mode`) becomes a labelled
   *  message block in the transcript BEFORE its tool row: the review dock then
   *  only asks 确认执行/继续规划 while the plan reads in the conversation.
   *  (Resume replays the same pair from the session log — foldHistoryEvents.) */
  toolCall(name: string, argsRaw?: string): void {
    const plan = name === EXIT_PLAN_TOOL ? extractPlanMarkdown(argsRaw) : undefined
    if (plan !== undefined) this.pushItem({ key: this.key += 1, kind: 'plan', text: plan })
    this.pushItem({
      key: this.key += 1,
      kind: 'tool',
      text: `│ ${name}`,
      tool: { state: 'running', startedAt: Date.now(), ...argsRaw === undefined ? {} : { argsRaw: capToolArgs(argsRaw) } },
    })
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
        this.setItemAt(i, { ...item, text: header, tool })
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
  /** Transcript-load generation: bumps whenever item keys may be reused. */
  get loadGeneration(): number { return this._loadGeneration }
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
      (n, it) => n + (it.kind === 'reasoning' ? 1 : 0)
        + (it.kind === 'tool' && it.tool?.body !== undefined ? 1 : 0)
        + (it.kind === 'compaction' && it.compaction?.summary !== undefined ? 1 : 0),
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
  /** Hover state for the tool-row affordance (a row that can be
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
      this.setItemAt(this.items.length - 1, { ...tail, text: tail.text + text })
    } else {
      this.pushItem({ key: this.key += 1, kind: 'assistant', text })
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
    // Bumped on EVERY settlement, before the no-op early return: the transcript
    // panel reads it to re-parse that row's markdown height exactly once. The
    // streamed copy's height estimate is deliberately debounced (优化1), so the
    // settled row would otherwise keep an estimate measured for a shorter text —
    // and a short estimate is exactly what clips the last wrapped line of the
    // answer off the bottom of the transcript (follow-tail pins the window
    // bottom to the estimated content height).
    this._assistantSettleEpoch += 1
    let idx = -1
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]?.kind === 'assistant') { idx = i; break }
    }
    if (idx === -1) {
      this.pushItem({ key: this.key += 1, kind: 'assistant', text })
      this._lastSettledKey = this.key
      this.notify()
      return
    }
    if (this.items[idx]!.text === text) return
    this.setItemAt(idx, { ...this.items[idx]!, text })
    this._lastSettledKey = this.items[idx]!.key
    this.notify()
  }

  /** Accumulate reasoning deltas into one `reasoning` block (a collapsed Think). */
  streamReasoning(text: string): void {
    const tail = this.items.at(-1)
    if (tail?.kind === 'reasoning') {
      this.setItemAt(this.items.length - 1, { ...tail, text: tail.text + text })
    } else {
      this.pushItem({ key: this.key += 1, kind: 'reasoning', text })
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
    this.replaceItems([])
    this._historyMarkerKey = -1
    this._loadedOlder = 0
    this._historyProgressMax = 0
    this._historyTotal = 0
    this._historyHolding = false
    this._historySettled = false
    this._loadError = null
    this._statsWindowOnly = false
    this._steps = []
    this._toolBodiesOverride.clear()
    this._toolBodiesDefault = false
    this._reasoningOverride.clear()
    this._reasoningDefault = false
    this._measureEpoch += 1
    this._expansionEpoch += 1
    this._loadGeneration += 1
    this._rowResolver = null
    this.notify()
  }

  /** Replace the transcript with folded session history (resumed-session
   *  replay) and continue keying from the loaded items, so live appends never
   *  collide with replayed keys. */
  loadHistory(items: readonly TranscriptItem[], steps: readonly StepItem[]): void {
    // This REPLACES the item list wholesale, so any chunked-resume marker goes
    // with it. Leaving `_historyMarkerKey` pointing into a list that no longer
    // holds that marker kept `historyLoadingVisible` true forever, and the status
    // bar's left slot then rendered `historyProgressText` — which is
    // `items[0].text`, i.e. the first transcript row — instead of the run-phase
    // indicator (`⠿ Idle` / `Working · Esc to pause`). That is exactly what a
    // file-first launch hit: `beginHistory` (S2 phase 1) is followed by the
    // attach's own `loadHistory`, so the marker was gone while the flag stayed.
    this._historyMarkerKey = -1
    this._historyTotal = 0
    this._historyProgressMax = 0
    this._historyHolding = false
    // Same convention as `clear()`: no marker means nothing is settled or
    // pending (the flag is only consulted while a marker exists).
    this._historySettled = false
    this._loadedOlder = 0
    this.replaceItems([...items])
    this.key = items.length
    this._steps = [...steps]
    this._toolBodiesOverride.clear()
    this._toolBodiesDefault = false
    this._reasoningOverride.clear()
    this._reasoningDefault = false
    this._measureEpoch += 1
    this._expansionEpoch += 1
    this._loadGeneration += 1
    this.notify()
  }

  /** Label of the leading "older history still loading" marker row. */
  private static historyMarkerText(done: number, total: number, holding: boolean): string {
    // HOLDING is a RESTING state, not a stalled bar: while the reader stays at
    // the live tail the driver deliberately keeps only a bounded window of
    // older history (RESUME_OLDER_ITEM_CAP) and waits — so the counter stops a
    // percent or two short of the total and a percentage would look stuck
    // forever. The text then says what is true and what to do about it.
    // NOT "Load session:" — that phrase belongs to the STATUS-BAR banner, which is
    // about opening the session and must disappear the moment the transcript is on
    // screen. This row is about OLDER HISTORY being folded in the background, and
    // it stays for as long as the driver works (by design), so sharing the wording
    // made a working background fold read as a stuck session load.
    if (holding) return `Older history:  ${done}/${total} events loaded · scroll to top to load more`
    const pct = sessionLoadPercent({ done, total })
    const bar = sessionLoadBar({ done, total }, 16, true)
    return `Older history:  ${bar} ${String(pct).padStart(3)}%  ${done}/${total} events`
  }

  /** Begin a TAIL-FIRST chunked history load (giant-session resume): paint the
   *  recent `items` immediately under a leading progress marker row, keying so
   *  that later prepends (see {@link Store.prependHistory}) and live appends
   *  never collide with the replayed keys. `olderEvents` = events that still
   *  need folding in the background (shown in the marker). */
  beginHistory(items: readonly TranscriptItem[], steps: readonly StepItem[], olderEvents: number): void {
    const tailMax = items.reduce((max, item) => Math.max(max, item.key), 0)
    const markerKey = Math.max(this.key, tailMax) + 1
    this._historyMarkerKey = markerKey
    this._historyProgressMax = 0
    this._historyTotal = olderEvents
    this._historyHolding = false
    this._historySettled = false
    this.key = markerKey
    this.replaceItems([
      { key: markerKey, kind: 'status', text: Store.historyMarkerText(0, olderEvents, false), dim: true },
      ...items,
    ])
    this._steps = [...steps]
    this._toolBodiesOverride.clear()
    this._toolBodiesDefault = false
    this._reasoningOverride.clear()
    this._reasoningDefault = false
    this._loadedOlder = 0
    this._measureEpoch += 1
    this._expansionEpoch += 1
    this._loadGeneration += 1
    this.notify()
  }

  /** Prepend one OLDER folded slice in front of the current history (chunked
   *  resume background fill). The slice is chronologically older than every
   *  row already shown, so it goes directly before the first history row —
   *  behind the leading marker when one is still present. Existing item
   *  objects keep their identity (their row-height estimates stay valid); only
   *  the incoming slice gets fresh keys from the running counter. */
  prependHistory(chunk: readonly TranscriptItem[]): void {
    if (chunk.length === 0) return
    const keyed: TranscriptItem[] = []
    for (const item of chunk) keyed.push({ ...item, key: this.key += 1 })
    const marker = this._historyMarkerKey >= 0 && this.items.length > 0 && this.items[0]?.key === this._historyMarkerKey
    this.replaceItems(marker
      ? [this.items[0]!, ...keyed, ...this.items.slice(1)]
      : [...keyed, ...this.items])
    if (marker) this._loadedOlder += keyed.length
    this._measureEpoch += 1
    this.notify()
  }

  /** The in-flight session switch, or null when nothing is being opened. */
  get sessionLoading(): SessionLoadingState | null { return this._sessionLoading }

  /** Whether the loading ticker ever fired (loop was alive → show elapsed). */
  get sessionLoadingTicked(): boolean { return this._sessionLoadingTicked }

  /** Short wording of the last failed session load (null when none). */
  get loadError(): string | null { return this._loadError }

  /** Whether the session stats cover only the loaded window (oversized log). */
  get statsWindowOnly(): boolean { return this._statsWindowOnly }

  /** Mark the stats as window-only (see {@link STATS_FULL_SCAN_MAX}). */
  setStatsWindowOnly(windowOnly: boolean): void {
    if (this._statsWindowOnly === windowOnly) return
    this._statsWindowOnly = windowOnly
    this.notify()
  }

  /** Record a failed session load: the status bar keeps this line visible until
   *  the next attempt (a new load clears it) or `/clear`. */
  failSessionLoad(text: string): void {
    this._sessionLoading = null
    this._sessionLoadingTicked = false
    this._loadError = text
    this.notify()
  }

  /** Drop the recorded load failure (new attempt, `/clear`, explicit dismiss). */
  clearLoadError(): void {
    if (this._loadError === null) return
    this._loadError = null
    this.notify()
  }

  /** Enter the "opening a session" state (paints the dialog; suppresses keys).
   *  A second Enter replaces the state instead of stacking dialogs.
   *  @param state.keepHero - the load is expected to LAND ON the hero (a flat
   *    launch or `/new`: the runtime creates or adopts an unused blank session), so
   *    the hero stays up while it runs. Without it the docked chrome (status bar
   *    + `Load session:`) is painted instead — right for a `/sessions` switch,
   *    which needs that progress slot, but it made a plain `qialike` start on the
   *    conversation view for ~0.4 s before the hero replaced it. */
  beginSessionLoading(state: { id: string; title?: string; bytes?: number; startedAt: number; keepHero?: boolean }): void {
    this._loadError = null
    this._sessionLoading = {
      ...state,
      steps: [{ phase: 'opening', label: SESSION_LOAD_LABELS.opening }],
    }
    this._sessionLoadingTicked = false
    this.notify()
  }

  /** Start the next phase: the previous ACTIVE step is closed with `ms` and the
   *  new one becomes active. No-op without an in-flight switch. */
  beginSessionLoadStep(phase: SessionLoadPhase, ms?: number, progress?: { done: number; total: number }): void {
    const state = this._sessionLoading
    if (state === null) return
    const steps: SessionLoadStep[] = state.steps.map((step, i) =>
      i === state.steps.length - 1 && step.ms === undefined ? { ...step, ms: ms ?? 0 } : step)
    const existing = steps.findIndex((step) => step.phase === phase)
    const next: SessionLoadStep = { phase, label: SESSION_LOAD_LABELS[phase], ...(progress === undefined ? {} : { progress }) }
    if (existing >= 0) steps[existing] = { ...steps[existing]!, ...next }
    else steps.push(next)
    this._sessionLoading = { ...state, steps }
    this.notify()
  }

  /** Refresh the ACTIVE step's real counts (events folded so far). */
  setSessionLoadProgress(done: number, total: number): void {
    const state = this._sessionLoading
    if (state === null || state.steps.length === 0) return
    const last = state.steps[state.steps.length - 1]!
    if (last.ms !== undefined) return
    const steps = [...state.steps.slice(0, -1), { ...last, progress: { done, total } }]
    this._sessionLoading = { ...state, steps }
    this.notify()
  }

  /** Re-render the banner so its elapsed seconds advance. Firing at all proves
   *  the event loop is free (a blocking session-open fires no timer), which is
   *  what unlocks the elapsed tail in the banner text. */
  tickSessionLoading(): void {
    if (this._sessionLoading === null) return
    this._sessionLoadingTicked = true
    this.notify()
  }

  /** Leave the "opening a session" state (success OR failure). */
  endSessionLoading(): void {
    if (this._sessionLoading === null) return
    this._sessionLoading = null
    this._sessionLoadingTicked = false
    this.notify()
  }

  /** Enter the S2-2b READ-ONLY view: phase 1 folded this session's tail from
   *  the durable log and the harness attach is deliberately still pending, so
   *  the user can scroll/search/export without paying the ~2 s open. Keeps the
   *  docked chrome up (the hero would hide the painted transcript) and answers
   *  the id for read-only consumers; NOT a load state, so input stays live.
   *  @param id - the session whose log was painted. */
  beginReadOnlySession(id: string): void {
    if (this._readOnlySessionId === id) return
    this._readOnlySessionId = id
    this._readOnlyPermissionPicked = false
    this.notify()
  }

  /** Leave the read-only view (the attach has landed and `setSession` took
   *  over), or drop it when the launch fell back to attach-first. */
  endReadOnlySession(): void {
    if (this._readOnlySessionId === undefined) return
    this._readOnlySessionId = undefined
    this.notify()
  }

  /** The session id of the read-only phase, or undefined when not in it. */
  get readOnlySessionId(): string | undefined { return this._readOnlySessionId }

  /** Whether a request is being assembled (see {@link PREPARING_REQUEST_LABEL}). */
  get preparingRequest(): boolean { return this._preparingRequest }

  /** Epoch ms the in-flight assembly began, or null when idle. */
  get preparingRequestStartedAt(): number | null { return this._preparingStartedAt }

  /** Whether the preparing ticker ever fired (loop alive → show elapsed). */
  get preparingRequestTicked(): boolean { return this._preparingTicked }

  /** Measured assembly time of the step in flight, or null while it is still
   *  being assembled; it is also what switches the status bar to phase two. */
  get assemblyMs(): number | null { return this._assemblyMs }

  /** Epoch ms the payload left (phase two's clock origin), or null while the
   *  assembly is still running (phase two's clock starts at it). */
  get assemblyDoneAt(): number | null { return this._assemblyDoneAt }

  /** Epoch ms the CURRENT preparing window's safety deadline expires, or null
   *  when idle (see {@link beginPreparingRequest} / {@link noteAssemblyElapsed}).
   *  Exposed for the window tests; the status bar never reads it. */
  get preparingDeadlineAt(): number | null { return this._preparingDeadlineAt }

  /** Mark the assembly window: set on `step/start` (and on submit), i.e. right
   *  before the harness takes the thread. A second call inside the same window
   *  (submit → `step/start`) keeps the original clock, so the seconds measure
   *  the wait the user actually experiences.
   *
   *  The deadline is taken from the wall clock HERE rather than from `startedAt`:
   *  `startedAt` is the timestamp the wait is DISPLAYED against (tests pass a
   *  synthetic one), while the deadline is about when the ticker gives up. */
  beginPreparingRequest(startedAt: number = Date.now()): void {
    if (this._preparingRequest) return
    this._preparingRequest = true
    this._preparingStartedAt = startedAt
    this._preparingTicked = false
    this._assemblyMs = null
    this._assemblyDoneAt = null
    this._preparingDeadlineAt = Date.now() + PREPARING_ASSEMBLY_DEADLINE_MS
    this.notify()
  }

  /** The request payload now exists: the synchronous assembly is over (reported
   *  by the LLM adapter, `llm.ts` `noteRequest`), so the status bar can name the
   *  phase and print what it cost. Everything after this point is the
   *  provider's time-to-first-token, which is what the label's second half says —
   *  and which the assembly deadline must no longer cut short.
   *  @param ms - measured assembly time (epoch-ms delta). */
  noteAssemblyElapsed(ms: number): void {
    if (!this._preparingRequest) return
    const rounded = Math.max(0, Math.round(ms))
    this._preparingDeadlineAt = Date.now() + PREPARING_PROVIDER_DEADLINE_MS
    // Phase two's clock origin: taken HERE, not derived from the assembly start,
    // so the wait seconds never inherit the submit → `step/start` gap.
    this._assemblyDoneAt = Date.now()
    if (this._assemblyMs === rounded) return
    this._assemblyMs = rounded
    this.notify()
  }

  /** Re-render so the elapsed seconds advance (firing proves the loop is free).
   *  Also the only place the safety deadline is enforced: no frame can be painted
   *  while the loop is blocked, so a tick is exactly the moment "nothing ever
   *  answered" becomes observable.
   *  @param now - current epoch ms (injectable for tests). */
  tickPreparingRequest(now: number = Date.now()): void {
    if (!this._preparingRequest) return
    if (this._preparingDeadlineAt !== null && now >= this._preparingDeadlineAt) {
      this.endPreparingRequest()
      return
    }
    this._preparingTicked = true
    this.notify()
  }

  /** Leave it: the step produced content, the turn ended, or the safety deadline
   *  expired. */
  endPreparingRequest(): void {
    if (!this._preparingRequest) return
    this._preparingRequest = false
    this._preparingStartedAt = null
    this._preparingTicked = false
    this._assemblyMs = null
    this._assemblyDoneAt = null
    this._preparingDeadlineAt = null
    this.notify()
  }

  /** The in-flight manual `/compact`, or null when none is running. */
  get compaction(): CompactionState | null { return this._compaction }

  /** Whether the compaction ticker ever fired (loop alive → show elapsed). */
  get compactionTicked(): boolean { return this._compactionTicked }

  /** Whether a manual compaction is running (Esc then cancels it). */
  get compactionActive(): boolean { return this._compaction !== null }

  /** Enter the compaction state (status bar takes over; Esc can abort). */
  beginCompaction(startedAt: number): void {
    this._compaction = { startedAt, phase: 'selecting', tokens: 0, estimated: true, queued: 0 }
    this._compactionTicked = false
    this.notify()
  }

  /** Install the abort seam for the running compaction (null clears it). */
  setCompactionCancel(cancel: (() => void) | null): void {
    this._cancelCompaction = cancel
  }

  /** Abort the running compaction through the harness's own cancellation
   *  signal (the only way out of a summary that runs long). No-op when none
   *  is running. */
  cancelCompaction(): void {
    this._cancelCompaction?.()
  }

  /** Move the compaction to its next phase (`compaction/start` → summarizing,
   *  `compaction/summary` → committing). */
  noteCompactionPhase(phase: CompactionPhase): void {
    if (this._compaction === null || this._compaction.phase === phase) return
    this._compaction = { ...this._compaction, phase }
    this.notify()
  }

  /** Record streamed summary output (tokens + whether it is an estimate). */
  noteCompactionTokens(tokens: number, estimated: boolean, budget?: number): void {
    const state = this._compaction
    if (state === null) return
    const next = {
      ...state,
      tokens: Math.max(state.tokens, Math.round(tokens)),
      estimated,
      ...budget === undefined ? {} : { budget },
    }
    if (next.tokens === state.tokens && next.estimated === state.estimated && next.budget === state.budget) return
    this._compaction = next
    this.notify()
  }

  /** One user message the harness is holding until the compaction settles. */
  noteCompactionQueued(): void {
    if (this._compaction === null) return
    this._compaction = { ...this._compaction, queued: this._compaction.queued + 1 }
    this.notify()
  }

  /** Re-render so the elapsed seconds advance (firing proves the loop is free). */
  tickCompaction(): void {
    if (this._compaction === null) return
    this._compactionTicked = true
    this.notify()
  }

  /** Leave the compaction state (success, failure or cancellation). */
  endCompaction(): void {
    if (this._compaction === null) return
    this._compaction = null
    this._compactionTicked = false
    this.notify()
  }

  /** Whether a load progress indicator should occupy the status bar: a load is
   *  running and it has not settled yet (settled → one completion flash, then
   *  the slot returns to the normal busy indicator). */
  get historyLoadingVisible(): boolean {
    return this._historyMarkerKey >= 0 && !this._historySettled
  }

  /** Which line owns the status bar's LEFT slot — the single source of truth for
   *  the render, so the priority order cannot drift from what is tested.
   *
   *  Order and why:
   *   - `loading`/`compaction`/`preparing`: the user just took an action and
   *     these carry live numbers (or the request-assembly clock) — nothing may
   *     hide them;
   *   - `flash`: a transient confirmation of the user's own action. It MUST
   *     outrank the fold, because in the read-only phase (S2-2b) the fold's
   *     marker is set and no driver ever settles it, so `historyLoadingVisible`
   *     is true for as long as the user only reads — anything ranked below it
   *     can never be seen (measured: `/sidebar` and Ctrl+Y copy gave no feedback
   *     at all before this order was fixed). The flash expires by itself, so the
   *     fold text comes back on its own;
   *   - `error`: a failed load stays until the next attempt or `/clear`, and it
   *     is the only line that explains why the user's action did not work, so it
   *     also outranks the fold. Safe to rank above `history`: any new load
   *     clears `loadError` first, so a stale error can never hide a live fold;
   *   - `history`: the long older-history fold's progress + counts (also row 0
   *     of the transcript, so it is never lost);
   *   - `busy`: the idle/running indicator. */
  get statusBarLeft(): 'loading' | 'compaction' | 'preparing' | 'flash' | 'error' | 'history' | 'busy' {
    if (this._sessionLoading !== null) return 'loading'
    if (this._compaction !== null) return 'compaction'
    if (this._preparingRequest) return 'preparing'
    if (this._statusFlash !== null) return 'flash'
    if (this._loadError !== null) return 'error'
    if (this.historyLoadingVisible) return 'history'
    return 'busy'
  }

  /** The leading marker's text (progress bar + counts) — reused by the status
   *  bar so the long older-history fold is visible without scrolling up. */
  get historyProgressText(): string {
    const marker = this.items[0]
    if (this._historyMarkerKey < 0 || marker === undefined) return ''
    return marker.text
  }

  /** Mark the load as settled for the current view: flash ONE completion line
   *  and let the status bar drop the progress (folding resumes → unsettle). */
  settleHistoryLoad(total: number): void {
    if (this._historySettled) return
    this._historySettled = true
    // Nothing older was folded (the tail already filled the view): a completion
    // flash would be a lie ("… · 0 events in view") and pure noise.
    if (total <= 0) return
    // "loaded" (not "of N"): what is loaded is what this view needs — the rest
    // stays on disk and comes back on scroll-up, so a fraction would mislead.
    this.flashStatus(`Older history loaded · ${total} events in view`, 4000)
  }

  /** A settle is reversed as soon as folding starts again (reader scrolled up). */
  unsettleHistoryLoad(): void {
    this._historySettled = false
  }

  /** Number of older-history items currently loaded behind the marker row. */
  get loadedOlder(): number { return this._loadedOlder }
  /** Whether an "older history still loading" marker row is present (a chunked
   *  resume has not reached event 0 yet). */
  get olderLoading(): boolean { return this._historyMarkerKey >= 0 }

  /** Drop the OLDEST loaded older-history items so the transcript holds at
   *  most `keep` of them (memory bound for very long sessions while the user
   *  reads the live tail). Only valid while the marker row is present (older
   *  history is still loading); the dropped slices can be re-folded later by
   *  the resume driver, so nothing is lost. Row keys of kept items are
   *  untouched (their height caches stay valid); the visual position is
   *  bottom-anchored because callers only trim while following the tail.
   *  @param keep - how many older items to keep after the drop.
   *  @returns how many items were dropped (0 when nothing to drop). */
  trimOlderFront(keep: number): number {
    if (this._historyMarkerKey < 0 || this._loadedOlder <= keep) return 0
    const drop = this._loadedOlder - keep
    const dropable = Math.max(0, this.items.length - 1)
    const dropN = Math.min(drop, dropable)
    if (dropN <= 0) return 0
    this.replaceItems([this.items[0]!, ...this.items.slice(1 + dropN)])
    this._loadedOlder -= dropN
    this._measureEpoch += 1
    this.notify()
    return dropN
  }

  /** Refresh the leading marker's progress text while the background fold of
   *  older events advances. */
  setHistoryProgress(done: number, total: number): void {
    if (this._historyMarkerKey < 0 || this.items.length === 0) return
    const marker = this.items[0]!
    if (marker.key !== this._historyMarkerKey) return
    // Monotonic: at the live tail the driver evicts the oldest loaded slices
    // and re-folds them on demand, which makes the raw accounting wobble by a
    // percent or two. A progress readout must never go backwards.
    const shown = Math.max(this._historyProgressMax, done)
    this._historyProgressMax = shown
    this._historyTotal = total
    this.setItemAt(0, { ...marker, text: Store.historyMarkerText(shown, total, this._historyHolding) })
    this.notify()
  }

  /** S2-2b: while the READ-ONLY view is up (phase 1 painted the tail, the
   *  harness attach is deliberately still pending) no fold driver is running,
   *  so the leading marker must not show a progress bar that cannot advance —
   *  rewrite it to say what is true. The attach's driver overwrites it with
   *  real progress through {@link setHistoryProgress}, so this is undone simply
   *  by calling it with `false` (or by the first fold slice). */
  setReadOnlyHistoryMarker(readOnly: boolean): void {
    if (this._historyMarkerKey < 0 || this.items.length === 0) return
    const marker = this.items[0]!
    if (marker.key !== this._historyMarkerKey) return
    const text = readOnly
      ? READ_ONLY_OLDER_HISTORY
      : Store.historyMarkerText(this._historyProgressMax, this._historyTotal, this._historyHolding)
    if (marker.text === text) return
    this.setItemAt(0, { ...marker, text })
    this.notify()
  }

  /** Switch the marker between "folding" and "holding" (see
   *  {@link Store.historyMarkerText}). No-op when unchanged. */
  setHistoryHolding(holding: boolean): void {
    if (this._historyHolding === holding) return
    this._historyHolding = holding
    if (this._historyMarkerKey < 0 || this.items.length === 0) return
    const marker = this.items[0]!
    if (marker.key !== this._historyMarkerKey) return
    this.setItemAt(0, {
      ...marker,
      text: Store.historyMarkerText(this._historyProgressMax, this._historyTotal, holding),
    })
    this.notify()
  }

  /** Remove the leading marker once every older slice has been prepended: the
   *  transcript now holds the FULL history. */
  finishHistory(): void {
    if (this._historyMarkerKey < 0) return
    this._historyMarkerKey = -1
    if (this.items.length > 0) this.replaceItems(this.items.slice(1))
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
    // Second gate for the two things that must never enter the draft. The paste
    // path already normalizes both at the decoder (stdin.ts); this one keeps any
    // OTHER textual insert (today: a typed character, an inserted '\n') from
    // smuggling them in, and is a no-op for text that is already clean.
    //  · a CR is invisible at best and erases its own row on screen at worst
    //    (CRLF -> LF, a lone CR -> LF). Enter is handled as its own key.
    //  · control bytes: Ink re-emits a control byte it does not recognise
    //    VERBATIM into the frame, so a draft holding `X\x1b[2JY` erased the screen
    //    (measured, replayed on every repaint) — see terminal-safe.ts.
    const clean = sanitizeTerminalText(text.replace(/\r\n?/g, '\n'))
    this._input = this._input.slice(0, this._cursor) + clean + this._input.slice(this._cursor)
    this._cursor += clean.length
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
    if (approval) this._approvalRows = 0 // re-measured by the panel's first report
    if (approval) this._panel = 'approval'
    else if (this._panel === 'approval') this._panel = 'conversation'
    this.notify()
  }
  /** Selected approval action (0=Deny, 1=Allow always, 2=Allow once); ←/→ cycle + Enter. */
  private _approvalChoice = 2
  get approvalChoice(): number { return this._approvalChoice }
  /** Measured dock ROW count: the approval panel reports the real rendered
   *  height of its IN-FLOW dock so `conversation.tsx` reserves exactly that
   *  many transcript rows. 0 means "not measured yet"; the caller then uses the
   *  layout estimate (`approvalReasonLayout().dockRows`). */
  private _approvalRows = 0
  get approvalRows(): number { return this._approvalRows }
  setApprovalRows(v: number): void {
    const n = Math.max(0, Math.round(v))
    if (n === this._approvalRows) return
    this._approvalRows = n
    this.notify()
  }
  cycleApprovalChoice(delta: number): void {
    this._approvalChoice = (this._approvalChoice + delta + 3) % 3
    this.notify()
  }
  /** Jump the approval highlight to `i` (0=Deny, 1=Allow always, 2=Allow once). */
  setApprovalChoice(i: number): void {
    this._approvalChoice = Math.max(0, Math.min(2, i))
    this.notify()
  }
  /** Tool names the user chose "Allow always" for this session (in-memory). */
  private _allowAlways = new Set<string>()
  /** Tools allowed without asking for the rest of this session. */
  get allowAlways(): readonly string[] { return [...this._allowAlways] }
  isAllowAlways(toolName: string): boolean { return this._allowAlways.has(toolName) }
  rememberAllowAlways(toolName: string): void { this._allowAlways.add(toolName); this.notify() }
  get question(): PendingQuestion | null { return this._question }
  setQuestion(q: PendingQuestion): void { this._question = q; this._questionScroll = 0; this._questionTabFrom = 0; this._questionRows = 0; this._panel = 'question'; this.notify() }
  /** Measured dock ROW count: the question panel reports the real rendered
   *  height of its dock every frame; the conversation's in-flow reservation
   *  (modalH) sizes the transcript space from THIS value (falling back to the
   *  layout estimate before the first measurement), so the reserved rows never
   *  drift from the painted dock — typing in the "Other" editor pushes the
   *  message history up row by row until the dock's ≤5-row input cap. */
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
    } else if (ans !== null && ans.kind === 'multi') {
      // A committed multi-select answer maps back to its first checked row;
      // the checks themselves are already in `picks[i]` (they are the live
      // draft, not stashed state). A committed "Other" text reopens the inline
      // editor, exactly as a custom answer does.
      const at = item.options?.findIndex((o) => o.label === ans.labels[0]) ?? -1
      q.index = at >= 0 ? at : Math.min(q.highlights[i] ?? 0, optsLen)
      q.custom = ans.custom ?? ''
      q.customMode = q.custom !== ''
      q.drafts[i] = q.custom
      q.draftOpen[i] = q.customMode
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
  /** Jump straight to question `i` (clicking the card's tab bar). */
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
   *  on the OTHER row (with no text yet) opens the inline editor instead.
   *
   *  A MULTI-SELECT question commits its whole checked set (`picks[active]`)
   *  and never advances on a toggle: Space/digits/click check options and
   *  Enter answers (requiring at least one check — an empty set is not an
   *  answer). Typing in its "Other" editor commits the checks AND the text,
   *  which the harness answer carries together. */
  questionEnter(): void {
    const q = this._question
    if (q === null) return
    const opts = q.item.options ?? []
    const optsLen = opts.length
    const a = q.active
    const multi = isMultiSelect(q.item)
    if (q.customMode) {
      const trimmed = q.custom.trim()
      if (trimmed === '') { this.flashStatus('type your answer first'); return }
      if (multi) {
        q.answers[a] = { kind: 'multi', labels: [...(q.picks[a] ?? [])], custom: trimmed }
      } else {
        q.answers[a] = { kind: 'custom', text: trimmed }
      }
      q.drafts[a] = q.custom
      q.draftOpen[a] = false
      q.customMode = false
      this.advanceAfterAnswer(q)
      return
    }
    if (q.index === optsLen) {
      // "Other…" chosen: open the inline editor UNDER the option list. Never
      // in plan-review — its dock is a bare confirm/decline (see
      // setQuestionCustom); this arm is unreachable there but kept safe.
      if (isPlanReview(q.item)) return
      q.customMode = true
      q.customCursor = q.custom.length
      this.notify()
      return
    }
    if (multi) {
      const labels = [...(q.picks[a] ?? [])]
      if (labels.length === 0) { this.flashStatus('check at least one option first (space)'); return }
      q.answers[a] = { kind: 'multi', labels }
      q.drafts[a] = ''
      q.draftOpen[a] = false
      q.highlights[a] = q.index
      q.customMode = false
      this.advanceAfterAnswer(q)
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
  /** Toggle one option of the active MULTI-SELECT question (Space / a digit /
   *  a click): the checked label set is that question's live draft, committed
   *  by Enter. The click/keystroke also moves the highlight to the toggled row.
   *  A no-op on single-select questions and on the "Other…" row (index ===
   *  options.length), which opens the inline editor instead. */
  toggleQuestionPick(index: number): void {
    const q = this._question
    if (q === null) return
    const opt = (q.item.options ?? [])[index]
    if (opt === undefined) return
    const picks = (q.picks[q.active] ??= [])
    const at = picks.indexOf(opt.label)
    if (at >= 0) picks.splice(at, 1)
    else picks.push(opt.label)
    // A changed check set invalidates the committed answer until Enter commits
    // the new one (the tab bar's ✓ follows the committed state, not the
    // draft); un-checking everything then leaves the question unanswered.
    q.answers[q.active] = null
    q.index = index
    q.highlights[q.active] = index
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
      if (ans.kind === 'multi') {
        // The harness accepts checked labels and custom text together for a
        // multi-select question (see AskUserQuestionAnswerItem).
        return ans.custom === undefined
          ? { id: item.id, selected: [...ans.labels] }
          : { id: item.id, selected: [...ans.labels], custom: ans.custom }
      }
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
    // Plan-review dock = a bare confirm/decline: no "Other" row to wrap into.
    const review = isPlanReview(this._question.item)
    const len = Math.max(1, (this._question.item.options?.length ?? 0) + (review ? 0 : 1)) // +1 = the custom/"Other" row
    this._question.index = (this._question.index + delta + len) % len
    this.notify()
  }
  /** Jump the question highlight to `i` (clamped to the options plus the Other row). */
  setQuestionIndex(i: number): void {
    if (this._question === null) return
    const review = isPlanReview(this._question.item)
    const len = Math.max(1, (this._question.item.options?.length ?? 0) + (review ? 0 : 1))
    this._question.index = Math.max(0, Math.min(len - 1, i))
    this.notify()
  }
  setQuestionCustom(value: string, mode: boolean): void {
    // Plan-review never opens the free-text editor: an opinion goes into the
    // composer as a normal message (the dock stays confirm/decline only).
    if (this._question === null || isPlanReview(this._question.item)) return
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
  /** Notified when the sandbox mode is cycled. A callback on the shared store —
   *  not a module export — because the panel bundles each get their own copy of
   *  every module VALUE (only this store instance is shared). */
  onPermissionChange: (mode: SandboxMode) => void = () => {}
  cyclePermission(): SandboxMode {
    const i = SANDBOX_CYCLE.indexOf(this._permission)
    this._permission = SANDBOX_CYCLE[(i + 1) % SANDBOX_CYCLE.length] ?? 'workspace-write'
    // S2-2b: while the session is READ-ONLY there is no live session to record
    // the choice on (the panel's Tab handler stamps `store.session`, which is a
    // stub then), so remember that the user picked a mode explicitly. The attach
    // must then stamp THIS mode durably instead of adopting the log's and
    // silently throwing the choice away.
    if (this._readOnlySessionId !== undefined) this._readOnlyPermissionPicked = true
    this.onPermissionChange(this._permission)
    this.notify()
    return this._permission
  }
  /** Whether the user cycled the sandbox permission while the read-only view was
   *  up (S2-2b) — the attach uses this to decide between stamping the choice and
   *  adopting the session's durable mode. */
  get readOnlyPermissionPicked(): boolean { return this._readOnlyPermissionPicked }
  /** Consume the read-only permission choice (called once the attach settled). */
  settleReadOnlyPermission(): void { this._readOnlyPermissionPicked = false }
  /** Adopt the SESSION's durable mode (its last `sandbox/mode`) when a session is
   *  opened or switched to. No `onPermissionChange`: the session is the source of
   *  this value, so pushing it back would be a no-op write. */
  adoptPermission(mode: SandboxMode | undefined): void {
    if (mode === undefined || mode === this._permission) return
    this._permission = mode
    this.notify()
  }
  get modelLabel(): string { return this._modelLabel }
  /** The reasoning-effort display name shown in the composer label ('' when
   *  the current model has no effort chosen or supports none). The full
   *  `modelLabel` already embeds it as ` · <name>`; the composer renders the
   *  effort part separately (warning color, as a variant chip). */
  get modelEffortName(): string { return this._modelEffortName }
  /** `true`/`false` once the credential probe settled, `undefined` before that. */
  get providerReady(): boolean | undefined { return this._providerReady }
  setModelLabel(label: string, effortName = '', providerReady: boolean | undefined = undefined): void {
    this._modelLabel = label
    this._modelEffortName = effortName
    this._providerReady = providerReady
    this.notify()
  }
  /** The live harness session, or — while S2-2b's read-only phase is up — a
   *  minimal stand-in carrying only the id. Read-only consumers (`/export`, the
   *  footer) need the id; anything that would CALL into the session is gated by
   *  the attach itself (`store.session` is replaced by the real one there). */
  get session(): Session | undefined {
    if (this._session !== undefined) return this._session
    if (this._readOnlySessionId !== undefined) return { id: SessionId(this._readOnlySessionId) } as unknown as Session
    return undefined
  }
  setSession(session: Session): void {
    this._session = session
    this._readOnlySessionId = undefined
    // Turn ledgers belong to the session that produced them.
    this._filesChanged.reset()
    coldNextRequest = true // S0 probe: the next LLM request pays a cold derive+freeze
    // A session switch (launch / /new / /sessions) starts a fresh hero state.
    this._promptAttempted = false
    // Stats belong to the session that produced them: a new session is not
    // window-only until ITS resume says so.
    this._statsWindowOnly = false
  }

  /** Per-turn ledger of the paths the turn WROTE (web parity: the harness's
   *  `ui-deliverables` row). Reset with the session; fed by both the live event
   *  stream and the resume replay, so a resumed turn shows the same row. */
  private readonly _filesChanged = new FilesChangedLedger()

  /** Remember one tool call's mutation path (see `files-changed.ts`). */
  fileCall(turn: number, callId: string, name: string, argsRaw?: string): void {
    this._filesChanged.call(turn, callId, name, argsRaw)
  }

  /** Settle one tool result: an errored call wrote nothing. */
  fileResult(callId: string, error: boolean): void {
    this._filesChanged.result(callId, error)
  }

  /**
   * Close a turn and append the "Files changed" row when it wrote files.
   * @param turn - the turn `turn/end` reports.
   * @returns the paths listed (empty when the turn wrote nothing).
   */
  fileTurnEnd(turn: number): readonly string[] {
    const paths = this._filesChanged.flush(turn)
    if (paths.length > 0) this.append('status', filesChangedLine(paths))
    return paths
  }

  /** Whether this session has had a submission attempt (see the field). */
  get promptAttempted(): boolean { return this._promptAttempted }
  /** First-submit flip: leaves the hero on the submit's own frame. */
  markPromptAttempted(): void {
    if (this._promptAttempted) return
    this._promptAttempted = true
    this.notify()
  }
  /** Hero (web parity): the blank New Session screen — an unused session with
   *  no submission attempt and nothing running yet. A resumed session with
   *  content (or a running turn) can never be the hero. */
  get hero(): boolean {
    // Picking a session in /sessions leaves the hero IMMEDIATELY (user call):
    // the docked chrome — status bar included — is up while the harness opens
    // the target, so the load has a visible progress slot from the first frame
    // instead of a modal over the hero. A LAUNCH that can only land on a blank
    // session (`keepHero`) is the exception: `qialike` must START on the hero,
    // not flash the conversation view while the session opens.
    if (this._sessionLoading !== null && this._sessionLoading.keepHero !== true) return false
    // S2-2b read-only view: phase 1 painted a real transcript from the durable
    // log, so the hero must not replace it while the attach is still pending.
    if (this._readOnlySessionId !== undefined) return false
    // A FAILED load keeps the docked view up too: the hero has neither a status
    // bar nor transcript rows, so an error shown there would be invisible.
    if (this._loadError !== null) return false
    const session = this._session
    if (session === undefined) return true
    return this._heroAllowed
      && sessionBlank(session.id) === true
      && !this._promptAttempted
      && !this._running
  }

  /** Leave the hero permanently: the user asked for a session explicitly
   *  (`/new`, `/sessions`), so the docked conversation view is the right screen
   *  even while the session it lands on is still blank. */
  leaveHero(): void {
    if (!this._heroAllowed) return
    this._heroAllowed = false
    this.notify()
  }
  private _models: readonly ModelsOption[] = []
  private _modelIndex = 0
  private _providers: readonly ProviderModelsEntry[] = []
  /** Provider routes the user hid from the /models first-level list (Ctrl+D /
   *  Alt+D), persisted in `qialike.json`; they stay reachable from the
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
  /** Clear the current form field (`Ctrl+U`; field 0 is a dropdown). */
  providerFormClear(): void {
    if (this._providerField === 0) return
    if ((this._providerValues[this._providerField - 1] ?? '') === '') return
    this._providerValues[this._providerField - 1] = ''
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
  /** Clear the whole API-key field (`Ctrl+U` in the key dialog — the single-line
   *  inputs delete the WHOLE line, unlike the composer/question editors where the
   *  same key deletes to the line start). */
  clearSecret(): void {
    if (this._secret === '') return
    this._secret = ''
    this.notify()
  }
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
   *  opens the dialog when it is not already open (background title folding).
   *  The highlight follows the SELECTED SESSION, not its row index: a refresh
   *  can drop rows (a folded `blank` bit hides an unused placeholder) or reorder
   *  them (a pin), and an index that survived that would point at a different
   *  session — Ctrl+F/Ctrl+D would then act on the wrong one. */
  refreshSessionsDialog(sessions: readonly SessionSummary[]): void {
    const highlighted = this.sessionsFiltered[this._sessionsDialogIndex]?.id
    this._sessionsDialog = sessions
    if (this._panel !== 'sessions') {
      this._sessionsDialogIndex = 0
      this._sessionsFilter = ''
      this._sessionsSearch = []
      this._panel = 'sessions'
    } else if (highlighted !== undefined) {
      const at = this.sessionsFiltered.findIndex((row) => String(row.id) === String(highlighted))
      this._sessionsDialogIndex = at >= 0
        ? at
        // The highlighted session is gone (deleted/hidden): stay in range rather
        // than on a row that no longer exists.
        : Math.min(this._sessionsDialogIndex, Math.max(0, this.sessionsFiltered.length - 1))
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
  /** The launch workspace. Known BEFORE any session is open (it comes from the
   *  CLI/config), and the read-only sidebar's footer prints it — so it is set
   *  before the file-first paint, not only when a session opens. Idempotent, so
   *  the later attach-time call costs nothing. */
  setWorkspace(workspace: string): void {
    if (this._workspace === workspace) return
    this._workspace = workspace
    this.notify()
  }
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
    const g = globalThis as unknown as { __dshFrameController?: { selection: unknown; bg: string; anchor?: unknown; focus?: unknown; contentLeft?: number; contentRight?: number } }
    if (!g.__dshFrameController) g.__dshFrameController = { selection: null, bg: '1' }
    const s = this._selection
    const active = s !== null && (Math.abs(s.aRow - s.cRow) + Math.abs(s.aCol - s.cCol)) > 2
    if (!active || s === null) { g.__dshFrameController.selection = null; g.__dshFrameController.anchor = null; g.__dshFrameController.focus = null; return }
    const gr = this._frameGuard ? this._frameGuard(s) : null
    g.__dshFrameController.selection = gr?.rect ?? null
    // The FLOW copy's content column band (grid cols) — the message column's
    // content [left .. right], or the STEPS SIDEBAR's own column band when the
    // anchor started there, so a sidebar drag selects/copies sidebar text only.
    g.__dshFrameController.contentLeft = gr?.left ?? 4
    g.__dshFrameController.contentRight = gr?.right ?? (this.width - 1)
    // Anchor + focus (the drag endpoints, 1-based SGR) let the frame controller
    // reproduce a LINE/FLOW copy, walking from the anchor cell to
    // the focus cell following the text flow, so e.g. dragging from the start of a
    // line into the middle of the next copies the whole first line + that prefix.
    g.__dshFrameController.anchor = gr?.anchor ?? { row: s.aRow, col: s.aCol }
    g.__dshFrameController.focus = gr?.focus ?? { row: s.cRow, col: s.cCol }
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
  /**
   * Move the transcript by `delta` rows and decide tail-following from WHERE
   * THE WINDOW LANDS.
   *
   * A mouse-selection highlight is baked into the SCREEN cells; once the
   * content scrolls those coordinates no longer point at the selected text, so
   * clear it (visible-region selections also clear on scroll).
   *
   * While following, `_scroll` is not kept in sync (the effective scroll IS
   * maxScroll), so the first scroll must sync to the tail: sticky scroll leaves
   * the bottom edge, one page/step at a time, instead of jumping from stale 0.
   *
   * Reaching the bottom RE-ARMS following (this is the fix for the reported
   * "PgUp to browse mid-turn, PgDn back to the bottom, new content no longer
   * auto-scrolls"): the old code cleared `_followTail` on every scroll input, so
   * a reader who returned to the tail kept a frozen window while rows streamed
   * in below it.
   */
  private scrollBy(delta: number): void {
    this.clearSelection()
    if (this._followTail) this._scroll = this._maxScroll()
    this._scroll = Math.max(0, Math.min(this._scroll + delta, this._maxScroll()))
    this._followTail = this._scroll >= this._maxScroll()
    this.notify()
  }
  scrollPage(dir: -1 | 1): void {
    this.scrollBy(dir * Math.max(1, this._layoutViewport))
  }
  /** Scroll the transcript by a small line delta (mouse wheel). */
  scrollLines(delta: number): void {
    this.scrollBy(delta)
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

/** One plugin-contributed block in the right sidebar (above the Steps list).
 *  The plugin owns its rows and its paint; the conversation panel owns the
 *  height budget, so `rows()` is what keeps a contributed block from pushing
 *  the sidebar's footer over the composer (Ink 4 has no `overflow`). */
export interface TuiSidebarSection {
  /** Stable id (also the registration key; re-registering replaces). */
  id: string
  /** Sort key inside the column; smaller renders higher. */
  order: number
  /** Rows this section needs: `full` at rest, `compact` when the column is
   *  tight (`compact <= full`; either 0 means "render nothing"). Both are
   *  budgeted before the Steps list, and the section is dropped when neither
   *  fits. Pure enough to call during render. */
  rows(store: Store, contentWidth: number): { full: number; compact: number }
  /** Paint the section; `compact` is true when the planner took the fallback
   *  row count, so the plugin can paint a one-line form. */
  render(store: Store, contentWidth: number, compact: boolean): React.ReactNode
}

/** The surface plugins consume: panels, slash commands, sidebar sections, and
 *  notifications. */
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
  /** Right-sidebar sections (rendered above the Steps list, budgeted by
   *  `sidebarStepPlan`). */
  sidebar: {
    register(section: TuiSidebarSection): void
    /** Registered sections in render order (`order`, then id). */
    list(): readonly TuiSidebarSection[]
  }
  /** Image drag-in attachment (mounted by the tui-image-attach plugin). */
  imageAttach?: ImageAttachApi
  notify(message: string): void
}

const tuiPanels = new Map<string, TuiPanelDefinition>()
const tuiCommands: CommandItem[] = []
const tuiSidebar = new Map<string, TuiSidebarSection>()

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
  sidebar: {
    register(section) { tuiSidebar.set(section.id, section) },
    list() {
      return [...tuiSidebar.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },
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
    'deepseek-flash': 'DeepSeek-V41-Flash',
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
  // The release of a right-click: its PRESS was consumed by the dialog gate
  // below (or ignored by the conversation surface). The release carries no
  // button in the SGR protocol, so without this swallow it would reach the
  // active panel as a LEFT-click release and confirm/select something the user
  // did not click. Right-click is press-only and, in a dialog, action-free; drop
  // the paired release here, once, for every panel (overlays included).
  if (k.mouseRightRelease !== undefined) return
  // An in-flight session switch OWNS the input: the target session is being
  // opened and is about to replace everything on screen, so keys are ignored
  // (no half-applied draft/command in the session that is being replaced).
  // Ctrl+C stays available as the single escape hatch — it exits the process,
  // and in raw mode the key path IS the exit path, so swallowing it would make
  // a long harness open look like a hard hang with no way out.
  // While a session is being opened, every key is swallowed: the harness blocks
  // this thread, so keystrokes would only pile up and land later.
  if (store.sessionLoading !== null && !(k.ctrl === true && (k.char ?? '') === 'c')) return
  // A running manual compaction owns Esc: the harness's cancellation signal is
  // the only way out of a summary that keeps generating. Dialogs keep their own
  // Esc (the panel is asked first) so an open /help still closes normally.
  if (store.compactionActive && store.panel === 'conversation'
    && (k.escape === true || k.mouseRightPress !== undefined)) {
    store.cancelCompaction()
    return
  }
  // ── TERMINAL TOO SMALL: the conversation surface is a two-row notice, so
  //    NOTHING that belongs to it may act (no key at all — see the note below). Without this gate the panel was
  //    invisible but live: `store.panel` still routed keys to a hidden approval
  //    dock, whose default choice is "Allow once" — so Enter approved a
  //    permission prompt the user could not see (measured: `settle(2)` on Enter),
  //    and on the hero a blind Enter submitted a real (paid) turn while `/export`
  //    could write a file. Fullscreen dialogs (/help, /sessions, /models, …) are
  //    genuinely VISIBLE at any height, so their keys stay live — only the
  //    conversation surface and the overlay docks it embeds are gated.
  const activePanel = tui.panels.byId(store.panel)
  const onConversationSurface = activePanel === undefined
    || activePanel.mode !== 'fullscreen'
    || store.panel === 'conversation'
  if (onConversationSurface && store.surfaceTooSmall) {
    // EVERYTHING is dropped here — keys, mouse, wheel, bracketed paste, and
    // Ctrl+C too — before any panel sees it, so nothing can act on input the
    // user cannot see. There is deliberately NO in-app escape hatch: quitting
    // would not remove the cause (a re-launch at the same height shows this very
    // notice again), so the notice's job is to say "make the terminal taller" —
    // and it is the only thing on screen. (User decision, 2026-09-13.)
    return
  }
  // A DIALOG never EXITS on a right-click (user call, 2026-09-14). It used to mean
  // Esc in every popup (2026-09-09), so a stray right-click — which is also the
  // terminal's own paste/context gesture — threw away an open popup or a
  // half-typed API key; only Esc (and Ctrl+C) leave a dialog now. Since
  // 2026-09-15 the press is handed to the dialog, where a text input pastes the
  // clipboard on SHIFT+right-click (clipboard.ts) — the only way to get that
  // gesture while this app has mouse tracking on. A PLAIN right-click stays
  // inert (the user's call: too easy to trigger by accident).
  // Either way the branch RETURNS, so the press can never reach the conversation
  // surface, and its paired release is swallowed at the top of this function.
  // The compaction cancel above stays: that is the conversation surface, not a
  // dialog, and it is an escape hatch.
  if (store.panel !== 'conversation' && k.mouseRightPress !== undefined) {
    // Let the dialog paste with it (and stay open); never fall through.
    tui.panels.byId(store.panel)?.handleKey?.(k, store)
    return
  }
  // A dialog LIST owns the mouse ONLY inside its own box. A hover or a wheel tick
  // anywhere else — the transcript visible around/behind the dialog — is consumed
  // and does nothing: it used to move the highlighted row, scroll the list, and on
  // click CONFIRM it (a left-click on the background resumed a session in
  // /sessions). The click half is gated inside each dialog, after
  // `store.mouseRelease` has finalized the transcript selection.
  //
  // The scope is "a list box is registered", NOT every non-conversation panel:
  // approval/question/plan-review route the pointer themselves (hover highlight,
  // wheel → transcript scroll) and register no list box, so an unconditional gate
  // would silently kill their mouse handling.
  if (outsideOpenDialogList(store.panel, k.mouseMove ?? k.wheelUp ?? k.wheelDown)) return
  const def = tui.panels.byId(store.panel) ?? tui.panels.byId('conversation')
  def?.handleKey?.(k, store)
}

/** Captures render-phase errors from the panel tree (e.g. a layout computation
 *  throwing on unexpected data). React treats such errors as recoverable and
 *  prints them in ways that bypass the log hooks (bun writes to fd 2 natively;
 *  Ink drops 'The above error occurred' frames), so the boundary is what puts
 *  them into `~/.dsh/qialike.log` via `logError('render', ...)`. */
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
  // While a request is being assembled the harness produces no session events
  // of its own (that silence IS the phase), so nothing would re-render and the
  // elapsed clock would sit still. This 250 ms ticker keeps it honest — and a
  // tick firing is itself the proof that the loop is free, which is what gates
  // the clock in the first place (see `preparingRequestStatusText`).
  const preparing = store.preparingRequest
  React.useEffect(() => {
    if (!preparing) return
    const ticker = setInterval(() => store.tickPreparingRequest(), 250)
    return () => clearInterval(ticker)
  }, [preparing])
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

/**
 * The sandbox mode the harness would actually enforce for a session.
 *
 * A view-side scan of `snapshotEvents()` is not enough: a NEWLY seeded session's
 * `sandbox/mode` lives in seed events the snapshot does not carry, so the status
 * bar would claim the TUI's default (workspace-write) while the session log —
 * and every confined call — says something else. The policy service is the same
 * authority `confine()` resolves through: request override, then the session's
 * last logged mode, then the deployment default.
 *
 * @param ctx - the plugin context carrying the sandbox policy service.
 * @param session - the session to resolve for, or undefined for the default.
 * @returns the effective mode, or undefined without the service (the caller then
 *   keeps its view-side value).
 */
function effectiveSandboxMode(ctx: Context, session: unknown): SandboxMode | undefined {
  const policy = ctx.get('sandboxPolicy') as
    | { resolve(request?: { session?: unknown }): { mode?: SandboxMode } }
    | undefined
  try {
    return session === undefined ? policy?.resolve().mode : policy?.resolve({ session }).mode
  } catch {
    return undefined // a tree without the policy service: keep the view-side value
  }
}

/**
 * One line naming the repository overlay bin.ts applied (or skipped), or
 * undefined when there is none. The layer is applied with no prompt, so this is
 * the only thing standing between "silent" and "visible".
 * @returns the notice text, or undefined.
 */
function projectOverlayNotice(): string | undefined {
  const raw = process.env.QIALIKE_PROJECT_OVERLAY
  if (raw === undefined || raw === '') return undefined
  try {
    const info = JSON.parse(raw) as { file?: unknown; rows?: unknown; skipped?: unknown }
    const file = typeof info.file === 'string' ? info.file : '(unknown)'
    if (info.skipped === true) return `repo overlay IGNORED (--no-project-overlay): ${file}`
    const rows = typeof info.rows === 'number' ? info.rows : 0
    return `repo overlay applied: ${file} (${rows} row(s)) — \`qialike --dump-config\` shows every row`
  } catch {
    return undefined // a malformed value must not break a launch
  }
}

export function apply(ctx: Context, config: Config): void {
  // Surface services for this plugin tree and every panel plugin: the store
  // (UI state) and the `tui` aggregate (panel/command registration, notify).
  ctx.provide('tuiStore', store)
  ctx.provide('tui', tui)
  // Declare the `qialike-update` settings namespace (`auto: true | false | "notify"`).
  // Registered from THIS plugin rather than from a plugin of its own: the updater
  // is not a Cordis child plugin — it must also run outside the tree
  // (`qialike upgrade`) — so this is one registration call, not a new row in
  // cordis.patch.yml. It runs here, during boot, so the automatic check that the
  // launcher schedules afterwards can read the user's choice.
  registerUpdateSettings(ctx)
  // The repository overlay is applied without asking: name it in the status bar
  // (long flash, visible on the hero) and leave a line in the transcript.
  const overlayNotice = projectOverlayNotice()
  if (overlayNotice !== undefined) {
    store.setRepoOverlayNotice(overlayNotice)
    store.flashStatus(`⚠ ${overlayNotice}`, 20_000)
    store.append('status', `⚠ ${overlayNotice}`, true)
  }
  // A fresh session takes its mode from the deployment default, which an overlay
  // can change: adopt it now so the chip does not claim the TUI's own default
  // while every confined call uses something else (the session's durable mode
  // replaces this at attach/switch time).
  store.adoptPermission(effectiveSandboxMode(ctx, undefined))
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runtime: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = { exit }

  // Error log: crash / unhandled errors and React/Ink warnings land in
  // `~/.dsh/qialike.log` (and stderr). Best-effort; never throws.
  initErrorLog()
  process.on('uncaughtException', (error) => {
    // The FILE keeps the stack; the terminal gets ONE line, queued through the
    // notice channel so it survives the alternate screen. `logError`'s stderr
    // mirror is not enough here: this handler runs with the UI mounted, so the
    // mirror lands in the buffer and is discarded on the way out — the same
    // silent disappearance P2 fixed for the resume path.
    logErrorFileOnly('uncaughtException', error)
    postExitNotice(`qialike: uncaught exception: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
  // FATAL in THIS launcher, despite not exiting here: bin.ts installs the
  // harness's fail-loud handler, which writes the stack to stderr and then exits
  // on the first unhandled rejection (the F1 root cause, documented in the test
  // plan). Both that write and logError's mirror land in the alternate screen and
  // are discarded, so the reason must be queued like any other fatal one; the
  // stack stays in the file. Should a future host NOT exit, the queued line is
  // simply written at the next exit — late, never lost.
  process.on('unhandledRejection', (reason) => {
    logErrorFileOnly('unhandledRejection', reason)
    postExitNotice(`qialike: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`)
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
      // "allow always": a tool the user approved with `a` this
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

  // Three tool fences, strongest first. `read-only` denies commands that would
  // modify the filesystem, carrying the `[sandbox: …]` marker the model surfaces
  // for a `sandbox_permissions` escalation (which routes to the approval answerer
  // above). The secrets read guard then refuses reads of `.env`-family files,
  // `.git` internals, and the credential document — a confidentiality rule, so
  // it is mode-independent and its reason says no escalation lifts it. Finally,
  // when the mounted executor applies NO kernel confinement — a host whose shell
  // reports no `sandboxMode`, such as Windows before the ACL restricted-token
  // runner could be bundled — every shell call is asked instead of running
  // unapproved: without it the host would advertise `workspace-write` while the
  // shell ignored it, and no denial would ever fire to trigger the escalation
  // path.
  // fs mutations are fenced separately by the (pure-JS) fs-sandbox row. The
  // shell rules live in `bash-policy.ts` and the read rule in `read-policy.ts`,
  // so each stays pure and independently testable.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    return readOnlyBashDecision(exec, store.permission)
      ?? blockedReadDecision(exec)
      ?? unconfinedShellAskDecision(exec, {
        permission: store.permission,
        // The capability fact, not `process.platform`: an executor that applies
        // no kernel confinement reports `undefined`, so this gate lights up
        // exactly where a shell would otherwise run unconfined, and a host that
        // later ships a confining executor stops asking with no change here.
        shellConfines: ctx.get('shell')?.sandboxMode !== undefined,
      })
      ?? next()
  })

  // P2-A: a mounted boundary is not necessarily a COMPLETE one, and the harness
  // publishes the distinction only with a settled shell result
  // (`result.sandbox.enforcement`) — `ctx.get('shell')?.sandboxMode` says a
  // boundary exists, not how far it reaches. Announce `partial` once per session
  // so the mode label is never read as full confinement.
  let announcedSandboxEnforcement: string | undefined
  ctx.on('tools/post-execute', async (_exec, result, next) => {
    const value = result.value as { sandbox?: { mode?: unknown; enforcement?: unknown } } | undefined
    const notice = partialEnforcementNotice(value?.sandbox)
    if (notice !== undefined && notice !== announcedSandboxEnforcement) {
      announcedSandboxEnforcement = notice
      store.append('status', notice, true)
    }
    return next()
  })

  void start(ctx, config, io).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // FILE ONLY: the terminal gets ONE clean line below. The stderr mirror would
    // otherwise put the stack in front of it, and a launch that cannot honour
    // the requested session is a user-facing error, not a crash to debug (F4/F5).
    logErrorFileOnly('start', error)
    // The reason must reach the terminal in BOTH shapes of this failure. Before
    // Ink mounts there is no alternate screen, so a direct write is visible; once
    // the read-only first screen has painted, the buffer IS up, and anything
    // written before the exit handler's `\x1b[?1049l` is discarded with it (P2:
    // an attach-stage failure used to vanish exactly like that). The channel
    // queues the notice and the exit sequence writes it after the leave.
    postExitNotice(`qialike: ${message}\n`)
    store.append('status', `TUI load failure: ${message}`, false)
    requestExit(io, 1)
  })
}


/** The async session lifetime, started from `apply` and owned by this plugin. */
async function start(ctx: Context, config: Config, io: TuiIo): Promise<void> {
  // Boot-phase timing (启动解码段停摆诊断): the harness session open (resume/
  // create) synchronously decodes + parses the whole durable log BEFORE
  // qialike's own chunked resume runs, and on a giant log that decode shows
  // up as seconds-long `[stall]` gaps with no intermediate marker. Logging the
  // phase boundaries here separates "decode+open" from "history fold" cost.
  const bootT0 = Date.now()
  // ── main-thread liveness heartbeat ─────────────────────────────────────────
  // A synchronous wedge (a giant session's resume replay/fold, a pathological
  // layout pass…) blocks the WHOLE event loop, so even the render watchdog
  // below (which only fires while an agent is running) can never log it. This
  // unref'd 1s beat measures whether the loop keeps servicing timers at all:
  // when the first tick after a block runs it records the gap in
  // ~/.dsh/qialike.log ([stall]) for diagnosis. Armed BEFORE the launch
  // create/resume so a boot-time wedge is captured too.
  //
  // `QIALIKE_STALL_MS` lowers the threshold for measurement runs (default 4 s):
  // the default hides a few-hundred-ms boot block, and `[frame] slow gap` cannot
  // stand in for this — it is computed from layout-memo intervals, so an idle
  // screen logs a "gap" too, while a genuine block inside a single long task is
  // only visible here (session/optimization-plan.md §8.8). The beat INTERVAL has
  // to shrink with the threshold (the gap between two ticks is the interval
  // itself), so the threshold is kept at least twice the interval.
  const stallMs = (() => {
    const n = Number(process.env.QIALIKE_STALL_MS ?? Number.NaN)
    return Number.isFinite(n) && n > 0 ? n : 4000
  })()
  const beatMs = Math.min(1000, Math.max(50, Math.floor(stallMs / 2)))
  const stallThreshold = Math.max(stallMs, beatMs * 2)
  let lastBeat = Date.now()
  const heartbeat = setInterval(() => {
    const now = Date.now()
    const gap = now - lastBeat
    if (gap > stallThreshold) {
      const shown = gap < 1000 ? `${gap}ms` : `${(gap / 1000).toFixed(1)}s`
      logErrorFileOnly('stall', `main loop blocked for ${shown} (no timer callback for ${gap}ms)`)
    }
    lastBeat = now
  }, beatMs)
  heartbeat.unref?.()
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
  logErrorFileOnly('boot', `phases: loader+factory ready ms=${Date.now() - bootT0}`)
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  /** The model this session runs under: the persisted default. */
  let selection = defaultModel.currentSelection()
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

  // Explicit `--resume <id>` wins; otherwise `qialike resume` (positional) — or
  // the opt-in `resume_last` default — continues the session the user was last
  // working in within this directory. The picker probes for the newest session
  // WITH content and skips empty sessions (created and exited without a
  // message), so it continues the last actual work rather than a blank
  // transcript. A BARE launch does none of this: it opens the New Session
  // placeholder on the hero (see `DEFAULT_RESUME_LAST = false` in config.ts).
  //
  // The registry's factory registration can land a short moment AFTER the
  // loader reports quiescence (late service-availability waves during boot);
  // create/resume throws "no agent factory registered" before any side effect
  // when it has not landed yet. Launching the session must tolerate that
  // transient gap, so the establish attempt retries with a bounded window.
  let handle: AgentHandle | undefined
  let resumed = false
  /** Wall-clock when the launch began. In the S2-2b read-only path the attach
   *  is DEFERRED until the user's first submit, so `now - openT0` is "launch →
   *  attached" (it includes the whole read period) and must NOT be read as the
   *  attach duration — that is `attachT0` inside {@link attachNow}. Measured
   *  mistake (2026-09-12): using this as the attach number produced a bogus
   *  "1.9 s fixed + 45 ms/decoded MB" model. */
  const openT0 = Date.now()
  const resumeId = config.resume
  const establish = async (): Promise<{ handle?: AgentHandle; resumed: boolean }> => {
    let nextHandle: AgentHandle | undefined
    let nextResumed = false
    if (resumeId !== undefined) {
      try {
        // A session that another process is appending to often false-positives
        // as "corrupt" (torn record on a zstd frame seam); retry briefly so a
        // TRANSIENT failure is absorbed instead of reported.
        announceOversizedResume(config.workspace, resumeId)
        nextHandle = await withResumeCorruptRetry(
          () => agents.resume({ resumeSessionId: SessionId(resumeId), agentOptions, setup }),
          { retries: 3, waitMs: 400 },
        )
        nextResumed = true
      } catch (error) {
        // A requested resume that still fails after the retries is FATAL: the
        // launch must never hand the user a fresh session they did not ask for
        // (they would type into it believing they had continued the old one).
        // The reason is printed on the plain terminal by the caller.
        throw new Error(describeResumeFailure(error instanceof Error ? error.message : String(error)))
      }
    } else if (config.resumeNewest === true || resolveResumeLast()) {
      // `qialike resume` (explicit mode) or the `resume_last` opt-in: continue
      // the newest session WITH CONTENT → the launch lands directly in the
      // conversation view (docked), never on the hero.
      try {
        nextHandle = await autoResumeNewest(ctx, agents, config.workspace, agentOptions, setup)
        nextResumed = nextHandle !== undefined
        // The EXPLICIT mode is a request, not a preference: with nothing to
        // resume it must say so instead of quietly starting fresh. The opt-in
        // keeps falling back to the hero (that is what "resume_last" means).
        if (!nextResumed && config.resumeNewest === true) {
          throw new Error(`resume: no session with content in ${config.workspace} — nothing to resume (\`qialike\` starts a new one)`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(message.startsWith('resume:') ? message : describeResumeFailure(message))
      }
    }
    // A requested resume that FAILED must fall back to a genuinely fresh
    // session (and stay visibly `resumed: false` so the failure is surfaced) —
    // never silently land the user on some other blank session.
    const resumeAttempted = resumeId !== undefined || config.resumeNewest === true || resolveResumeLast()
    if (nextHandle === undefined && !resumeAttempted) {
      // Flat launch (the default): REUSE this workspace's unused New Session
      // placeholder when one exists (web parity — no empty-session pile-up),
      // otherwise create one. Either way the launch shows the hero screen.
      try {
        const { inspection, headers } = await blankReuseSource(ctx, config.workspace)
        const reused = await findReusableBlank(inspection, headers, config.workspace, undefined)
        if (reused !== undefined) {
          nextHandle = await withResumeCorruptRetry(
            () => agents.resume({ resumeSessionId: reused, agentOptions, setup }),
            { retries: 2, waitMs: 250 },
          )
          nextResumed = true
        }
      } catch {
        // Listing/inspection/open failure falls back to a fresh session.
      }
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
  // ── S2 phase 1: first screen from the durable log, before the attach ───────
  // `agents.resume()` below decodes the whole log synchronously and blocks this
  // thread, so nothing can be painted until it returns. For an explicit
  // `--resume <id>` we already know WHICH log to read, so mount the UI, paint
  // the newest events ourselves (paintFileFirstScreen), make sure that frame
  // really reached the terminal, and only then pay for the attach. The docked
  // chrome + `Load session:` banner appear immediately instead of a hero that
  // sits there for ~2.4 s (session/optimization-plan.md §2 S2).
  // Default ON: paint the file-first screen for a `--resume <id>` launch, or for
  // the auto-resume pick (`qialike resume` / `resume_last`) once its target is
  // known. `QIALIKE_NO_FAST_FIRST_SCREEN=1` (or the opt-in var set to 0/false)
  // returns to the attach-first boot for A/B and for a one-line rollback.
  const fastFirstEnabled = !/^(1|true|yes|on)$/i.test(process.env.QIALIKE_NO_FAST_FIRST_SCREEN ?? '')
    && !/^(0|false|no|off)$/i.test(process.env.QIALIKE_FAST_FIRST_SCREEN ?? '')
  const autoResumeWanted = config.resumeNewest === true || resolveResumeLast()
  let fileFirstId = resumeId
  if (fastFirstEnabled && fileFirstId === undefined && autoResumeWanted) {
    // Same candidate rule the attach itself will use (autoResumeCandidates), so
    // the painted screen can never belong to a different session than the one
    // about to be opened.
    const heads = await autoResumeCandidates(ctx, config.workspace)
    // Prefer the session `autoResumeNewest` will open (its HEAD-confident,
    // non-blank pick). When the probe cannot classify anything — which is what a
    // GIANT log looks like: its first zstd frame is 7.4 MB, far past the probe
    // budget, so `facts` is undefined — fall back to the most-recently-used
    // candidate, because that is the one the attach's leftover loop opens first.
    // A wrong guess is harmless: a blank/empty target folds to zero items and
    // `paintFileFirstScreen` paints nothing.
    fileFirstId = (heads?.find((entry) => entry.facts?.confident === true && !entry.facts.blank)
      ?? heads?.[0])?.header.id
  }
  const fastFirstScreen = fastFirstEnabled && fileFirstId !== undefined
  /** First event of the tail phase 1 painted from the durable log; the attach's
   *  fold keeps those rows instead of rebuilding the transcript (S2-2a). */
  let paintedTailStart: number | undefined

  // ── agent-independent core commands, registered BEFORE the attach ──────────
  // These four + the /help panel touch only our Store/panels — never the agent
  // — so they must exist in the READ-ONLY view too. Registering them after the
  // attach (as they used to be) meant an unregistered command fell through
  // `filteredCommands` to `store.submitMessage`, so typing `/exit` or `/help`
  // while read-only paid the whole 1.9–4.3 s attach before doing anything.
  // `/compact` (needs the live agent) stays in the post-attach block.
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
  tui.commands.register({ name: 'clear', hint: 'clear the transcript', run: () => { abortResumeFold(); store.clear() } })
  tui.commands.register({ name: 'exit', hint: 'quit qialike', run: () => { requestExit(io, 0) } })
  // `/upgrade` runs the launcher mode in a CHILD process. Calling the updater here
  // would run a multi-megabyte download and swap the running binary on this event
  // loop — the interface would freeze for the whole download.
  const installUpdate = (): void => {
    const child = spawn(process.execPath, ['upgrade'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let received = ''
    const collect = (chunk: Buffer | string): void => { received += String(chunk) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', () => { tui.notify('update failed: could not start the updater') })
    child.on('exit', (code) => {
      const lines = received.split('\n').map((line) => line.trim()).filter((line) => line !== '')
      if (lines.length === 0) {
        // Silence means "already newest" (or a policy skip); say so rather than
        // leaving the notice above hanging.
        tui.notify(code === 0 ? 'qialike is already the newest version' : 'update failed')
        return
      }
      for (const line of lines) tui.notify(line)
    })
  }
  /**
   * The Windows `/upgrade`: check, then HINT in the status line, never install.
   *
   * Windows cannot replace a running `.exe` and has no bash for the installer, so
   * the launcher refuses to install there (and the startup check says so too). What
   * this adds is the answer to "is there something newer?" in the place the user is
   * already looking: the update hint (hero row / docked status bar), plus the two
   * download URLs as ordinary transcript notices, because a status line cannot carry
   * two 85-character links.
   *
   * Deliberately NOT a dialog: the user asked for a hint, and a fullscreen panel would
   * interrupt whatever they were typing on the frame the check returns.
   */
  const checkUpdateOnWindows = (): void => {
    const child = spawn(process.execPath, ['upgrade', '--check', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let received = ''
    const collect = (chunk: Buffer | string): void => { received += String(chunk) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', () => { tui.notify('update check failed: could not start the updater') })
    child.on('exit', () => {
      const report = parseUpdateReport(received)
      if (report === undefined) {
        tui.notify('update check failed: no answer from the updater')
        return
      }
      const version = report.newest
      if (version === null) {
        store.clearUpdateHint()
        tui.notify('could not check for a newer qialike (no network?)')
        return
      }
      if (!isNewerAvailable(report)) {
        // The hint is a claim about the CURRENT release; a check that finds nothing
        // newer has to retract it rather than leave a stale line up.
        store.clearUpdateHint()
        tui.notify('qialike is already the newest version')
        return
      }
      const offer = { installed: report.installed, version, urls: report.downloads }
      store.noteUpdate(offer)
      for (const line of updateNoticeLines(offer)) tui.notify(line)
    })
  }
  tui.commands.register({
    name: 'upgrade',
    hint: 'check for a newer qialike (installs it where that is possible)',
    run: () => {
      tui.notify('checking for a newer qialike…')
      // Non-Windows keeps the pre-existing flow byte for byte: the launcher installs
      // the release itself (or refuses an unmanaged copy), and its lines are relayed.
      // The hint path is Windows-only by requirement, so Linux/macOS behaviour — and
      // with it the verified silent patch install — cannot be disturbed here.
      if (process.platform !== 'win32') { installUpdate(); return }
      checkUpdateOnWindows()
    },
  })

  // ── S2-2b: mount the UI and take input BEFORE the blocking attach ──────────
  // `agents.resume()` decodes the whole durable log on this one thread and
  // cannot be interrupted. Phase 1 (S2-1) already paints the newest events
  // straight from the log; S2-2b additionally keeps the app INTERACTIVE in the
  // window between that first screen and the attach, so scrolling, search,
  // export and selection work while the harness open is still unpaid. The
  // attach is then triggered ON DEMAND — the first submit, an agent-dependent
  // slash command, or (opt-in) an idle window — and only that trigger pays the
  // ~2 s. A user who only reads never pays it (session/optimization-plan.md
  // §2 S2 ③). The whole block is inert when the file-first screen did not paint
  // (a bare launch, a failed probe, the kill switch): the attach then runs
  // first, exactly as before.
  let mountedApp: ReturnType<typeof render> | undefined
  // Live terminal width: Bun/Node emit 'resize' on process.stdout and update
  // `columns`; Ink only re-renders the DOM, so we drive a reactive Store size.
  const onResize = (): void => {
    store.setSize(process.stdout.columns ?? 80, process.stdout.rows ?? 24)
    if (process.env.QIALIKE_DEBUG_WIDTH === '1') {
      process.stderr.write(`[qialike] width ${process.stdout.columns ?? 80}\n`)
    }
  }
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
  /** Mount Ink, enable raw mode / mouse tracking, and take over resize + stdin
   *  EXACTLY ONCE. Phase 1 calls it before painting the file-first screen (Ink
   *  must exist before a frame can be produced); the attach-first path calls it
   *  at the same point as before, after the session is open. */
  const mountUi = (): ReturnType<typeof render> => {
    if (mountedApp !== undefined) return mountedApp
    const app = render(<App />)
    mountedApp = app
    inkMounted = true
    // Enable raw mode so the terminal owns no input processing.
    if (typeof process.stdin.setRawMode === 'function' && process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    // Enable SGR mouse tracking so the terminal sends press/drag/release/wheel
    // events to the app. The stdin decoder turns wheel bytes (64/65) into
    // wheelUp/wheelDown → `store.scrollLines` (rolls the transcript), and
    // press/drag/release into the in-app selection handlers. This takes over
    // the terminal's NATIVE selection and wheel scrollback, which the
    // full-screen surface replaces (the transcript scrolls in-app; qialike
    // draws its own selection). Restored in the exit handler below.
    if (process.stdout.isTTY) {
      // SGR + any-motion (hover + drag), plus BRACKETED PASTE: the composer's
      // image-drag-in path listens for `k.paste` (stdin.ts parses `ESC[200~ …
      // ESC[201~`), and a terminal only emits those markers after the app asks
      // for them — without `?2004h` a dragged image arrives as plain text and
      // the attachment never triggers.
      process.stdout.write('\x1b[?1006h\x1b[?1003h\x1b[?2004h')
    }
    process.stdout.on('resize', onResize)
    process.stdin.on('data', onStdin)
    // Calibrate ambiguous glyph widths against the real terminal (CPR/ESC[6n)
    // so rows align for THIS terminal's fonts: measure while idle, re-layout
    // once a width lands. Deferred whenever the agent is busy so probing never
    // contends with streaming frames or typed input.
    initCharWidthCalibration({
      isBusy: () => store.running || store.paused,
      onWidthsChanged: () => store.bumpWidths(),
    })
    // Restore the terminal on exit. This handler is registered after every
    // other exit-time writer (log.ts's stderr mirror of `qialike exited`, Ink's
    // signal-exit unmount frame), so writing the leave sequence here makes it
    // the process's LAST visible terminal output: everything written before it
    // lands in the alternate screen buffer and is discarded when the buffer is
    // switched back, leaving no qialike residue above the shell prompt. (One
    // harmless `\x1b[?25h` cursor-show may still follow: restore-cursor
    // registers an afterexit hook that unconditionally re-shows the cursor —
    // invisible by design, and the cursor being visible is the correct end
    // state anyway.)
    process.once('exit', () => {
      if (typeof process.stdin.setRawMode === 'function' && process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
      // BOTH terminal-restore writes are synchronous. The exit phase only
      // guarantees ordering for sync writes (a Windows TTY is async, and so is a
      // POSIX pipe), and `post-exit-notice` writes the notice synchronously: a
      // sync notice would otherwise be able to overtake an async leave and vanish
      // with the alternate buffer — exactly the P2 failure it exists to prevent.
      try {
        if (process.stdout.isTTY) writeSync(1, '\x1b[?1006l\x1b[?1003l\x1b[?2004l') // disable mouse tracking + bracketed paste
      } catch { /* ignore */ }
      process.stdout.off('resize', onResize)
      process.stdin.off('data', onStdin)
      // Ink's own final frame (unmount's onRender) must not be queued behind the
      // synchronous leave below: on a Windows TTY (and on a POSIX pipe) stdout
      // writes are async, so that frame would be overtaken and left as residue on
      // the restored normal screen. The patched frame writer honours this hook by
      // writing synchronously; only frames from here on (i.e. the unmount one) take
      // that path, so ordinary rendering keeps its queued writes.
      ;(globalThis as { __dshTuiSyncFrameWriter?: (frame: string) => void }).__dshTuiSyncFrameWriter =
        (frame: string): void => { writeSync(1, frame) }
      void app.unmount()
      // `?2026l` first: every frame is wrapped in the synchronized-output mode
      // (see `__dshFrameEnvelope` in the build), and a terminal left inside it
      // would hold its buffer and look frozen. Each frame closes the mode in the
      // same write, so this is a belt for the exit path only.
      try { writeSync(1, '\x1b[?2026l\x1b[0 q\x1b[?25h\x1b[?1049l') } catch { /* ignore */ }
    })
    // Registered AFTER the leave writer above, so every notice queued through
    // the channel is written once the alternate screen is gone — the only place
    // a fatal reason can still be read (P2; see `post-exit-notice.ts`).
    armPostExitNotices(flushPostExitNotices)
    return app
  }

  /** True while phase 1's log-backed view is on screen and the harness attach
   *  has not been paid for yet. Input stays LIVE in this state. */
  let readOnly = false
  /** Full inputs (messages or `/command` lines) the user handed us while the
   *  read-only view was up; replayed through the normal Enter path once the
   *  setup is complete (see the replay at the end of `start()`). */
  const pendingInputs: string[] = []
  let attachAttempt: Promise<void> | undefined
  /** Opened by the first trigger that pays the attach, so the read-only path can
   *  suspend `start()` until then (and no longer). Rejects with the attach's own
   *  error so a failed open surfaces instead of hanging the boot. */
  let releaseAttachGate: (() => void) | undefined
  let failAttachGate: ((error: unknown) => void) | undefined
  const attachGate = new Promise<void>((resolve, reject) => {
    releaseAttachGate = resolve
    failAttachGate = reject
  })
  // On the attach-first path nobody awaits the gate, but `attachNow` still
  // rejects it on a failed open — keep that from surfacing as an unhandled
  // rejection (the read-only path's own gate await still sees it).
  void attachGate.catch(() => { /* surfaced by the read-only awaiter when present */ })
  /** Trigger the (synchronous, blocking) harness open. Idempotent: the first
   *  caller pays it, every later caller awaits the same promise. */
  const attachNow = (): Promise<void> => {
    attachAttempt ??= (async (): Promise<void> => {
      if (readOnly) {
        // This IS the moment the user pays for the open, so say so — and make
        // sure the labelled frame reached the terminal before the thread is
        // taken (the banner's seconds would otherwise freeze at 0.0s).
        store.setReadOnlyHistoryMarker(false)
        store.beginSessionLoading({ id: fileFirstId ?? '', startedAt: Date.now() })
        store.beginSessionLoadStep('attaching', 0)
        await paintBeforeBlock()
      }
      // The launch create/resume must tolerate the registry's factory
      // registration landing a moment after the loader reports quiescence:
      // create/resume throws "no agent factory registered" before any side
      // effect when it has not landed yet (see `establish` above).
      // The real attach bracket: opened AFTER the banner frame was flushed, so
      // it measures the harness decode+parse (`[stall]`) and not the deferred
      // read-only window. See `openT0`.
      const attachT0 = Date.now()
      for (;;) {
        try {
          const result = await establish()
          handle = result.handle
          resumed = result.resumed
          // qialike and the web share the session store under
          // ~/.dsh/sessions/<cwd-encoded>/, but the web groups sessions by
          // workspaceId. A qialike session is created with `meta.cwd` only, so
          // the harness never attaches it and the web lists it under
          // "Ungrouped". Attach this session to the workspace that owns
          // `config.workspace` (when one exists — e.g. the web-created
          // "deepseek" workspace) so it groups under the SAME workspace instead
          // of Ungrouped. Best-effort: a path or registry mismatch must never
          // break the TUI boot.
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
      // The retry loop above either assigns `handle` (then breaks) or throws
      // once the factory deadline passes; TypeScript cannot see past the
      // try/catch, so assert the assignment here instead of reaching for a
      // non-null assertion.
      if (handle === undefined) {
        throw new Error('tui-runtime: agent handle was not established')
      }
      logErrorFileOnly('boot',
        `phases: session open (decode+attach) ms=${Date.now() - attachT0} resumed=${resumed} `
        + `sinceLaunch=${Date.now() - openT0}ms`)
    })()
    attachAttempt.then(() => releaseAttachGate?.(), (error) => failAttachGate?.(error))
    return attachAttempt
  }
  /** Defer one full input (message or `/command` line) until the attach lands:
   *  queue it, tell the user, and pay the open now. */
  const deferForAttach = (text: string): void => {
    pendingInputs.push(text)
    store.append('status',
      `Attaching session — this will be sent as soon as it is ready: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`, true)
    store.flashStatus('Attaching session…', 8_000)
    void attachNow()
  }
  // A requested `--resume <id>` whose log is not there cannot be honoured, and
  // the launch must SAY SO rather than quietly starting a fresh session (F4).
  // Checked BEFORE the UI mounts, so the reason lands on the plain terminal.
  if (resumeId !== undefined && sessionLogBytes(config.workspace, resumeId) === undefined) {
    process.stderr.write(`qialike: session "${resumeId}" not found in ${config.workspace}`
      + ' (no readable session log) — nothing to resume; run `qialike` for a new session\n')
    requestExit(io, 1)
    return
  }
  if (fastFirstScreen && fileFirstId !== undefined) {
    // The sidebar is painted in this phase too, and its footer's last line is
    // the workspace path: without this it rendered EMPTY until the attach
    // (measured: `qialike resume` showed only the two version lines in the
    // read-only view; `/sessions` → switch made the path appear).
    store.setWorkspace(config.workspace)
    store.setSize(process.stdout.columns ?? 80, process.stdout.rows ?? 24)
    // Leaves the hero (a plain launch's placeholder) and paints the docked
    // chrome with the load banner: the transcript has somewhere to appear.
    store.beginSessionLoading({ id: fileFirstId, startedAt: Date.now() })
    mountUi()
    const painted = await paintFileFirstScreen(store, config.workspace, fileFirstId)
    if (painted !== null) {
      paintedTailStart = painted.tailStart
      logErrorFileOnly('boot', `phases: file-first screen painted ms=${painted.ms} (attach still pending)`)
      await waitForFirstPaint()
      // S2-2b: the transcript is on screen and the open is still unpaid. Leave
      // the load state (which suppresses every key) and enter the read-only
      // phase: the docked chrome stays, input is live, the attach happens on
      // the first trigger.
      store.endSessionLoading()
      store.beginReadOnlySession(fileFirstId)
      store.setReadOnlyHistoryMarker(true)
      readOnly = true
      store.append('status', READ_ONLY_HINT, true)
      // The oversize warning rides stdout BEFORE Ink mounts on the attach-first
      // path (see announceOversizedResume); phase 1 already mounted, and a raw
      // `\n` would scroll the frame, so the warning is silenced there. Surface
      // it as a transcript row instead — otherwise S2-2b would hide the one
      // hint that explains the multi-second freeze the first submit is about to
      // pay (measured: attach ≈ 1.9 s fixed + ~45 ms per decoded MB).
      const oversize = oversizedResumeWarning(sessionLogBytes(config.workspace, fileFirstId))
      if (oversize !== undefined) store.append('status', oversize, true)
      // First submit / agent-dependent command → pay the attach now and replay
      // the input through the normal Enter path afterwards.
      store.submitMessage = (text) => { deferForAttach(text) }
      store.beforeCommand = (name, text) => {
        if (!ATTACH_DEFERRED_COMMANDS.has(name)) return true
        deferForAttach(text)
        return false
      }
      // Optional idle-window warm-up (`QIALIKE_ATTACH_IDLE_MS`): pay the open
      // while the user is reading and not typing, so a later submit is instant.
      // OFF by default — the S2 goal is that a user who only reads never pays
      // (session/optimization-plan.md §2 S2 ③).
      const idleMs = Number(process.env.QIALIKE_ATTACH_IDLE_MS ?? Number.NaN)
      if (Number.isFinite(idleMs) && idleMs > 0) {
        const timer = setTimeout(() => { void attachNow() }, idleMs)
        timer.unref?.()
      }
    }
  }
  if (readOnly) {
    // The read-only view is up: the setup below (and the harness open it
    // assumes) must NOT run until the user asks for it. `attachNow` is
    // reachable only through the triggers installed above, so this waits for
    // the first one — and a user who only reads never fires it.
    await attachGate
  } else {
    await attachNow()
  }
  // `attachNow()` either assigned `handle` or threw; TypeScript cannot see
  // through the closure, so re-assert the assignment to narrow the type here.
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
    // Resume the history into the transcript: small logs fold in one pass,
    // giant logs paint the recent tail first and fold the older ranges in the
    // background (see resumeHistoryIntoStore) — the launch must never block
    // its first frame on a very long durable log.
    // S2-2c attribution (`QIALIKE_DEBUG_RESUME=1`): all of this runs
    // SYNCHRONOUSLY right after the attach returns, on the submit path since
    // S2-2b, and every step scans the FULL stored log. `[resume] attach-sync`
    // splits the block so the next fix targets the real term, not a guess.
    const tSync = Date.now()
    const launchSnapshot = agent.session.snapshotEvents()
    const tSnap = Date.now()
    // The chip shows the session's DURABLE mode (what the harness's own backends
    // enforce), not a fresh default: otherwise a resumed read-only session would
    // claim "Workspace Write" while every write is refused. S2-2b exception: if
    // the user cycled the chip while READ-ONLY, the session did not exist to
    // record it on (the panel stamps `store.session`, a stub then) — stamp that
    // explicit choice durably here instead of overwriting it with the log's.
    if (store.readOnlyPermissionPicked) {
      try { setSandboxMode(agent.session, store.permission) } catch { /* best-effort */ }
    } else {
      store.adoptPermission(effectiveSandboxMode(ctx, agent.session) ?? lastSandboxMode(launchSnapshot))
    }
    store.settleReadOnlyPermission()
    const tPerm = Date.now()
    resumeHistoryIntoStore(store, agent.session, launchSnapshot, paintedTailStart)
    const tFold = Date.now()
    // Backfill the sidebar title from the in-memory log: the launch session
    // may predate this process (its session/title event never reached a live
    // listener here) and the disk-cache prewarm runs on a delay. The SAME
    // snapshot tells whether the session is an unused blank (web parity: the
    // launch reuses the workspace's blank session rather than creating one).
    const snapshot = launchSnapshot
    rememberFoldedTitle(sessionId, snapshot)
    const tTitle = Date.now()
    rememberBlank(sessionId, foldSessionBlank(snapshot))
    const tBlank = Date.now()
    if (debugResumeFold) {
      logErrorFileOnly('resume',
        `attach-sync snapshot=${tSnap - tSync}ms permission=${tPerm - tSnap}ms foldSync=${tFold - tPerm}ms `
        + `title=${tTitle - tFold}ms blank=${tBlank - tTitle}ms total=${tBlank - tSync}ms events=${snapshot.length}`)
    }
    // Oversized session: recommend the harness's OWN compaction (suggestion
    // only — the TUI never compacts behind the user's back). Appended AFTER
    // the fold, because `beginHistory` replaces the item list wholesale.
    if (snapshot.length >= COMPACT_HINT_EVENTS) {
      const hint = compactHintText(snapshot.length)
      store.append('status', hint, true)
      store.flashStatus(hint, 10_000)
    }
  } else {
    rememberBlank(sessionId, true) // freshly created: unused New Session
  }
  // S2: the attach + authoritative fold are done, so the launch's load banner
  // (raised by phase 1 to have a docked slot for the first screen) is over.
  if (fastFirstScreen) store.endSessionLoading()
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
  store.setModelLabel(modelLabel, hasKey ? (savedEffort === undefined ? '' : reasoningEffortName(savedEffort)) : '', hasKey)
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
        store.setModelLabel('not set', '', false)
        return
      }
      // Prefer the built-in DeepSeek route over a same-brand sibling, so the
      // composer and `current:` stop showing the hidden provider's family.
      const fallback = visible.find((p) => p.provider === 'deepseek-official') ?? visible[0]
      store.modelsSaveAction(
        fallback.provider,
        fallback.models[0]?.id ?? 'deepseek-flash',
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
        // Bounded HEAD probes answer title+blank for the common case (see
        // session-head.ts); `inspect()` remains the fallback for the rest.
        setHeadTitleProbe((header) => {
          const facts = probeSessionHead(header.cwd ?? config.workspace, String(header.id))
          return facts === undefined ? undefined : { ...facts }
        })
        await prewarmTitles(persistence, listRowHeaders(await persistence.list()))
      } catch {
        // Prewarm is best-effort; a failing list must not disturb the session.
      }
    })()
  }, 500).unref()

  // Did the current turn produce any assistant TEXT (any step)? A max-tokens
  // turn-end with zero body text is a silent stall (the 8k output budget was
  // spent on reasoning) that the UI must explain instead of leaving Idle bare.
  let textSinceThisTurn = false

  /** Apply one model delta to the streaming transcript. */
  const applyModelDelta = (chunk: { type?: string; text?: string } | undefined): void => {
    if (chunk === undefined) return
    // Reasoning is shown as a collapsed Think block; text streams as the
    // answer. Tool-call deltas are dropped (the settled tool/call row renders).
    if (chunk.type === 'reasoning-delta') store.streamReasoning(chunk.text ?? '')
    else if (chunk.type === 'text-delta') store.streamText(chunk.text ?? '')
  }

  const handleLiveEvent = (session: { id: string }, event: SessionEvent): void => {
    if (session.id === sessionId) sessionEventCount += 1
    if (debugLayoutEvents) { eventsThisWindow += 1; if (session.id === sessionId) eventsForSession += 1 }
    // P0 probe: the gap submit → first live event is where a giant session's
    // context assembly (harness side, same thread) shows up.
    if (pendingSubmitProbe !== null && session.id === sessionId) {
      pendingSubmitProbe.noteFirstEvent()
      if (event.type === 'turn/end') {
        logErrorFileOnly('submit', pendingSubmitProbe.logLabel())
        pendingSubmitProbe = null
        ;(globalThis as AssemblyProbeSeam).__dshSubmitProbe = undefined
      }
    }
    if (session.id !== sessionId) return
    // Liveness beat: any live event means the run is active, so the status bar
    // can show "Ns since last event" even across silent model stretches.
    store.markActivity()
    // The durable `assistant/chunk` event carries one model delta. The legacy
    // type is handled BEFORE the switch so the switch keeps its per-event
    // narrowing.
    const rawType = (event as unknown as { type: string }).type
    if (rawType === 'assistant/chunk') {
      store.endPreparingRequest()
      applyModelDelta((event as unknown as { data?: { chunk?: { type?: string; text?: string } } }).data?.chunk)
    }
    switch (event.type) {
      case 'assistant/message': {
        store.endPreparingRequest()
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
          pendingSubmitProbe?.noteStepStart(data.turn, data.step)
        }
        // A fresh step begins with the model computing (reasoning deltas flip
        // the phase to `thinking` as they arrive).
        store.setRunPhase('working')
        // The harness assembles this step's request SYNCHRONOUSLY right after
        // this event — measured 4-6 s on a 1.45 M-event session. Label it and
        // make sure the labelled frame reaches the terminal before the block;
        // the state is cleared by the step's first content event below.
        store.beginPreparingRequest()
        // Flush the labelled frame before the assembly takes the thread; the
        // state is cleared by this step's first content event (below) or by
        // turn/end, so a bare flush needs no cleanup of its own.
        void paintBeforeBlock()
        break
      }
      // Between steps the model is computing the next one; keep the phase
      // honest so a silent gap reads as "working", never as Idle.
      case 'step/end': {
        const data = event.data as { turn?: number; step?: number }
        pendingSubmitProbe?.noteStepEnd(data.turn ?? -1, data.step ?? -1)
        store.setRunPhase('working')
        break
      }
      // Turn bookkeeping for the max-tokens stall hint (C2H): reset the
      // text-produced flag on a fresh turn; explain a silent ceiling hit.
      case 'turn/start': {
        textSinceThisTurn = false
        // First turn: this session stops being an unused "New Session"
        // placeholder (web parity: blank flips false at turn/start).
        rememberBlank(sessionId, false)
        break
      }
      case 'turn/end': {
        store.endPreparingRequest()
        const turn = (event.data as { turn?: number }).turn ?? 0
        // Turn tail (web parity): the paths this turn WROTE, listed before the
        // turn's closing notice so the notice stays the last word on the turn.
        store.fileTurnEnd(turn)
        // Every ending is either explained or deliberately quiet — see the
        // module. `stepped` is read off this turn's own step keys: an ending
        // that never reached a model call is the one that used to look like a
        // hang, because nothing at all was rendered for it.
        const notice = turnEndNotice(
          (event.data as { reason?: TurnEndReasonLike }).reason,
          {
            textProduced: textSinceThisTurn,
            stepped: [...stepStartAt.keys()].some((key) => key.startsWith(`${turn}:`)),
          },
        )
        if (notice !== undefined) store.append('status', notice, true)
        // A turn just finished: the title service may have appended its
        // session/title event during the run. The session/title case above
        // only fires for events this listener sees, so fold the live log when
        // the cache still has no title for the current session (a no-op once
        // one exists). Runs at most once per turn until a title is cached.
        if (sessionDisplayTitle(sessionId) === undefined) {
          rememberFoldedTitle(sessionId, agent.session.snapshotEvents())
          store.notifyTitles()
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
      // Tool calls/results shown inline as icon + name rows; the
      // result also closes the tool's wall-time bucket (FIFO per turn:step).
      case 'tool/call': {
        store.endPreparingRequest()
        const data = event.data as { turn?: number; step?: number; callId?: string; name?: string; arguments?: string }
        const key = `${data.turn}:${data.step}`
        const queue = toolCallsAt.get(key) ?? []
        queue.push(Date.now())
        toolCallsAt.set(key, queue)
        store.toolCall(event.data.name, data.arguments)
        // Files-changed ledger (web parity): remember what this call would write;
        // only a successful result turns it into a listed path.
        if (data.callId !== undefined) store.fileCall(data.turn ?? 0, data.callId, event.data.name, data.arguments)
        break
      }
      case 'tool/result': {
        const data = event.data as { turn?: number; step?: number; message?: { content?: unknown; source?: { callId?: string } } }
        const key = `${data.turn}:${data.step}`
        const started = toolCallsAt.get(key)?.shift()
        if (started !== undefined) store.accrueTool(Date.now() - started)
        const { text, error } = toolResultDisplay(data.message)
        store.toolResult({ ok: !error, text })
        const callId = data.message?.source?.callId
        if (callId !== undefined) store.fileResult(callId, error)
        break
      }
      // The session title (first-task summary) folds in the harness
      // session-title service; remember it so the /sessions and /resume lists
      // never need to re-read the log for this session.
      case 'session/title': {
        rememberTitle(sessionId, event.data.title)
        store.notifyTitles()
        break
      }
      // Manual `/compact` lifecycle (the TUI's own status bar follows these).
      // `compaction/start` lands AFTER the harness's synchronous range walk, so
      // the status bar is already showing `selecting older history…` by then.
      case 'compaction/start': {
        store.noteCompactionPhase('summarizing')
        break
      }
      case 'compaction/summary': {
        store.noteCompactionPhase('committing')
        // Facts for the CHECKPOINT row that lands in the very next event (the
        // harness appends `compaction/summary` and the replacement
        // `user/message` back to back). The summary TEXT itself is taken from
        // that message, so only the counts/model need carrying over.
        const data = event.data as {
          shadowedSeqs?: readonly unknown[]
          shadowedTokenCount?: number
          provider?: string
          model?: string
        }
        pendingCompactionFacts = {
          ...data.shadowedSeqs === undefined ? {} : { items: data.shadowedSeqs.length },
          ...data.shadowedTokenCount === undefined ? {} : { tokens: data.shadowedTokenCount },
          ...data.provider === undefined ? {} : { provider: data.provider },
          ...data.model === undefined ? {} : { model: data.model },
        }
        break
      }
      case 'compaction/end': {
        // The durable close carries the harness's own failure chain (e.g.
        // "summary is not smaller than the shadowed content (…)"): keep it in
        // the log, and let the human-facing row come from the thrown error so
        // the two never disagree.
        const failure = (event.data as { error?: unknown }).error
        if (failure !== undefined) logErrorFileOnly('compact', `compaction/end error: ${String(failure)}`)
        pendingCompactionFacts = undefined
        break
      }
      // Non-user user/message = injected context (e.g. the system prompt),
      // rendered as a "Context injection" notice like dsh web — EXCEPT a
      // compaction checkpoint, which gets its own disclosure row (web parity:
      // the summary is readable, and the row states what it replaced).
      case 'user/message': {
        const source = event.data.source as { kind?: string; plugin?: string } | undefined
        if (source?.kind === 'user') break
        if (isCompactionCheckpoint(source)) {
          const summary = compactionCheckpointSummary(flattenContentText(event.data.content))
          const facts: CompactionRowFacts = {
            ...pendingCompactionFacts ?? {},
            ...summary === undefined ? {} : { summary },
          }
          pendingCompactionFacts = undefined
          store.appendCompaction(facts)
          break
        }
        const label = source?.kind === 'plugin' && source.plugin ? source.plugin : (source?.kind ?? 'context')
        store.append('status', `Context injection · ${label}`)
        break
      }
      default:
    }
  }

  ctx.on('session/event', (session, event: SessionEvent) => { handleLiveEvent(session, event) })

  store.append('status', 'Ready. Enter to send · Ctrl+C clears the input · /exit quits.', true)

  // `/compact` needs the live agent (registered here, after the attach); the
  // agent-INDEPENDENT core commands were registered before the read-only branch
  // (see `registerAgentFreeCommands`) so that in the read-only view `/exit`,
  // `/help`, `/think` and `/clear` run instead of falling through to
  // `submitMessage` — which would pay the whole attach just to quit or read help.
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

  store.submitMessage = (text) => {
    // P0 instrumentation (submit-path stall): the harness's prompt assembly and
    // the TUI's own layout both run on this ONE thread, so "提交后停滞明显" has
    // to be attributed with numbers, not guesses. Marks: submit → followup
    // returned → first live event → turn end (the followup call itself may
    // block inside the harness).
    const submitT0 = Date.now()
    let markFollowup = 0
    let markFirstEvent = 0
    const memory = process.memoryUsage()
    const eventCount = (): number => sessionEventCount
    pendingSubmitProbe = {
      startedAt: submitT0,
      events: eventCount(),
      heapMb: Math.round(memory.heapUsed / 1024 / 1024),
      steps: [],
      logLabel: (): string => {
        const first = markFirstEvent === 0 ? -1 : markFirstEvent - submitT0
        const follow = markFollowup === 0 ? -1 : markFollowup - submitT0
        const assembly = pendingSubmitProbe === null
          ? ''
          : pendingSubmitProbe.steps.map((st) => (st.streamAt === 0 ? '?' : `${st.streamAt - st.startedAt}`)).join(',')
        return `submit chars=${text.length} events=${eventCount()} heap=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB `
          + `followup=${follow}ms firstEvent=${first}ms assembly=[${assembly}]ms`
      },
      noteFollowup: () => { if (markFollowup === 0) markFollowup = Date.now() },
      noteFirstEvent: () => { if (markFirstEvent === 0) markFirstEvent = Date.now() },
      noteStepStart: (turn, step) => {
        pendingSubmitProbe?.steps.push({
          turn, step, cold: coldNextRequest, startedAt: Date.now(),
          streamAt: 0, bytes: -1, messages: -1, chunkAt: 0, fetchAt: 0, retries: 0,
        })
      },
      noteRequest: (bytes, messages) => {
        const cur = pendingSubmitProbe?.steps.at(-1)
        if (cur === undefined) return
        if (cur.streamAt === 0) {
          cur.streamAt = Date.now()
          cur.bytes = bytes
          cur.messages = messages
          // The payload string exists: the synchronous assembly is OVER, and
          // everything from here to the first chunk is the provider. Relabel the
          // status bar with the measured cost (see
          // `waitingForModelStatusText`) so the model wait stops reading as
          // request preparation.
          store.noteAssemblyElapsed(cur.streamAt - cur.startedAt)
        } else {
          cur.retries += 1
        }
        coldNextRequest = false // this request warmed the harness's caches
      },
      noteFetch: () => {
        const cur = pendingSubmitProbe?.steps.at(-1)
        if (cur !== undefined && cur.fetchAt === 0) cur.fetchAt = Date.now()
      },
      noteFirstChunk: () => {
        const cur = pendingSubmitProbe?.steps.at(-1)
        if (cur !== undefined && cur.chunkAt === 0) cur.chunkAt = Date.now()
      },
      noteStepEnd: (turn, step) => {
        const cur = pendingSubmitProbe?.steps.findLast((st) => st.turn === turn && st.step === step)
        if (cur === undefined || cur.streamAt === 0) return
        logErrorFileOnly('assembly',
          `turn=${cur.turn} step=${cur.step} cold=${cur.cold ? 1 : 0} `
          + `stepToStream=${cur.streamAt - cur.startedAt}ms assemblyMs=${cur.streamAt - cur.startedAt} `
          + `streamToChunk=${cur.chunkAt === 0 ? -1 : cur.chunkAt - cur.streamAt}ms `
          + `serializeMs=${cur.fetchAt === 0 ? -1 : cur.fetchAt - cur.streamAt} `
          + `bytes=${cur.bytes} msgs=${cur.messages} retries=${cur.retries}`)
      },
    }
    ;(globalThis as AssemblyProbeSeam).__dshSubmitProbe = pendingSubmitProbe
    // Local first-submit flip (web parity): the hero leaves on this frame,
    // ahead of the harness round-trip that records the real turn/start.
    store.markPromptAttempted()
    if (store.inputHistory.at(-1) !== text) {
      store.inputHistory.push(text)
      if (store.inputHistory.length > 100) store.inputHistory.shift()
    }
    store.setPaused(false) // any new message resumes; the model decides what to do
    // A compaction holds waking input: the harness queues this message and
    // starts it once the summary settles, so say that instead of looking stuck.
    if (store.compactionActive) store.noteCompactionQueued()
    store.append('user', text)
    touchSession(sessionId)
    // A dragged/pasted image becomes an image content block beside the text.
    const image = store.composerImage
    const content: ContentBlock[] = [{ type: 'text', text }]
    if (image !== null) content.push({ type: 'image', attachment: image.ref })
    // Paint the "working" frame BEFORE the harness takes the thread: the
    // followup call returns fast, but the turn's first request is assembled
    // synchronously right after, and no frame can be produced during it. The
    // state clears on the step's first content event (below), on a failed
    // submit, or on the window's own safety deadline — armed by
    // `beginPreparingRequest` and re-armed for the provider phase by
    // `noteAssemblyElapsed`, so this call site owns no timer of its own.
    store.beginPreparingRequest()
    void (async (): Promise<void> => {
      await paintBeforeBlock()
      try {
        agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
      } catch (error) {
        store.endPreparingRequest()
        logErrorFileOnly('submit', error)
        return
      }
      pendingSubmitProbe?.noteFollowup()
    })()
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
    void providerConfigured(ctx, provider).then(ok => store.setModelLabel(ok ? `${providerName} · ${modelName}${effortSuffix}` : 'not set', ok ? effortDisplay : '', ok))
    store.append('status', `models: ${providerName} · ${modelName}${effortSuffix}`, true)
  }
  // Ctrl+T / Alt+T: cycle the current model's reasoning effort through its
  // declared levels (wraps); the save path
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
        store.setModelLabel('not set', '', false)
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
        const model = fallback?.models[0]?.model ?? 'deepseek-flash'
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
    // The `/new` command: start a brand-new session in place. The harness
    // persists every session durably (write-behind on session/event), so the
    // old one stays reachable from /sessions / --resume after it is torn
    // down here.
    // Leaving the hero belongs to the COMMAND, not to the switch below: the
    // session `/new` lands on is blank (the reused empty one, or a fresh id),
    // and blankness is exactly what the hero predicate keys on — without this
    // the command answered with the hero screen the user had just asked to
    // leave, and its early return for an already-blank session switched nothing
    // at all. `resumeSessionAction` has always called it; the `leaveHero` doc
    // names `/new` for the same reason.
    store.leaveHero()
    abortResumeFold() // a chunked resume filling the old transcript is moot now
    if (store.running) {
      try { agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch { /* best-effort */ }
    }
    void (async (): Promise<void> => {
      try {
        // Web parity: an unused blank session is REUSED instead of minting a
        // new id, so "new session, never used" cannot pile up empty files.
        if (sessionBlank(sessionId) === true) {
          store.append('status', 'already on a new (unused) session', true)
          return
        }
        let reused: SessionId | undefined
        try {
          const { inspection, headers } = await blankReuseSource(ctx, config.workspace)
          reused = await findReusableBlank(inspection, headers, config.workspace, sessionId)
        } catch {
          // Listing/inspection failure falls back to creating a fresh id.
        }
        // Open the next agent BEFORE tearing the old one down: a failed
        // open leaves the current session untouched.
        const next = reused !== undefined
          ? await agents.resume({ resumeSessionId: reused, agentOptions, setup })
          : await agents.create({
            sessionId: SessionId(`session-${randomUUID()}`),
            meta: { cwd: config.workspace },
            agentOptions,
            setup,
          })
        // The new session starts from the mode the user has chosen (the chip):
        // a fresh log has no `sandbox/mode` of its own, and without this stamp a
        // chip reading "Read Only" would not fence filesystem writes at all.
        try { setSandboxMode(next.agent.session, store.permission) } catch { /* best-effort */ }
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
        // A fresh session has no events yet, so this is a no-op today; it
        // covers a future where /new switches onto an already-titled session.
        const snapshot = agent.session.snapshotEvents()
        rememberFoldedTitle(sessionId, snapshot)
        // Still blank: nothing has run in it yet (rememberBlank keeps the new
        // row showing as the reuse-able "New Session" placeholder).
        rememberBlank(sessionId, foldSessionBlank(snapshot))
        store.append('status', reused !== undefined
          ? `New session ${sessionId} in ${config.workspace} (reused empty session)`
          : `New session ${sessionId} in ${config.workspace}`, true)
      } catch (error) {
        store.append('status', `new: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    })()
  }
  store.resumeSessionAction = (id) => {
    store.leaveHero()
    // The /sessions dialog's Enter: switch to the selected persisted session
    // in place, exactly like the launch auto-resume (agents.resume + history
    // replay). The target is resumed BEFORE the old agent is disposed, so a
    // failed load leaves the current session untouched.
    if (String(id) === String(sessionId)) {
      store.append('status', `already on session ${sessionId}`, true)
      return
    }
    abortResumeFold() // a previous chunked resume must not feed the next session
    if (store.running) {
      try { agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch { /* best-effort */ }
    }
    // ── Loading state (P1) ─────────────────────────────────────────────────
    // Paint a banner BEFORE touching the harness: opening a session decodes its
    // whole log inside `agents.resume` (no progress API, and on giant logs it
    // can block the one JS thread — measured `session open … ms=8907`), while
    // the /sessions panel is already closed and the old transcript is on
    // screen. The banner + a live elapsed counter is the honest feedback; the
    // frame is flushed before the blocking call (see paintBeforeBlock).
    const startedAt = Date.now()
    const picked = store.sessionsDialog.find((row) => String(row.id) === String(id))
    store.beginSessionLoading({
      id: String(id),
      title: picked?.title,
      bytes: sessionLogBytes(picked?.cwd ?? config.workspace, String(id)),
      startedAt,
    })
    const ticker = setInterval(() => store.tickSessionLoading(), 250)
    void (async (): Promise<void> => {
      const tOpen = Date.now()
      // P0 probe: 100 ms ticks during the harness open tell us whether it
      // yields to the event loop (the banner's seconds would then tick) or
      // blocks it outright (the banner simply holds).
      let ticks = 0
      const probe = setInterval(() => { ticks += 1 }, 100)
      try {
        await paintBeforeBlock()
        const next = await withResumeCorruptRetry(
          () => agents.resume({ resumeSessionId: SessionId(id), agentOptions, setup }),
          { retries: 3, waitMs: 400 },
        )
        const openMs = Date.now() - tOpen
        clearInterval(probe)
        // Phase ① done — the elapsed is known only NOW (the open blocks the
        // loop, so the dialog cannot show a live clock for it).
        store.beginSessionLoadStep('attaching', openMs)
        const tDispose = Date.now()
        const old = handle
        if (old === undefined) return
        try { await old.dispose() } catch (error) { logError('resume: disposing the old session failed', error) }
        const disposeMs = Date.now() - tDispose
        handle = next
        agent = next.agent
        sessionId = agent.session.id
        sessionRef.current = sessionId
        store.setSession(agent.session)
        void attachSessionToWorkspace(ctx, config.workspace, agent.session.id)
        touchSession(sessionId)
        resetSessionStats()
        const tFold = Date.now()
        store.beginSessionLoadStep('tail', disposeMs)
        // P2①: the snapshot below is also what the title/blank fold uses, so it
        // is taken once here and handed to the fold instead of twice.
        const switchSnapshot = agent.session.snapshotEvents()
        store.adoptPermission(effectiveSandboxMode(ctx, agent.session) ?? lastSandboxMode(switchSnapshot))
        resumeHistoryIntoStore(store, agent.session, switchSnapshot)
        const foldMs = Date.now() - tFold
        store.beginSessionLoadStep('index', foldMs)
        // P0 (extended): the post-switch steps are split out — a giant log's
        // remaining cost sits somewhere in here, and guessing is not allowed.
        const tSnap = Date.now()
        const snapshot = switchSnapshot
        const snapMs = Date.now() - tSnap
        const tTitle = Date.now()
        rememberFoldedTitle(sessionId, snapshot)
        const titleMs = Date.now() - tTitle
        const tBlank = Date.now()
        rememberBlank(sessionId, foldSessionBlank(snapshot))
        const blankMs = Date.now() - tBlank
        store.beginSessionLoadStep('ready', snapMs + titleMs + blankMs)
        if (snapshot.length >= COMPACT_HINT_EVENTS) {
          store.append('status', compactHintText(snapshot.length), true)
          store.flashStatus(compactHintText(snapshot.length), 10_000)
        }
        logErrorFileOnly('resume',
          `switch session=${sessionId} open=${openMs}ms openTicks=${ticks} dispose=${disposeMs}ms `
          + `foldSync=${foldMs}ms snapshot=${snapMs}ms title=${titleMs}ms blank=${blankMs}ms `
          + `events=${snapshot.length} total=${Date.now() - startedAt}ms`)
        store.setRunning(false)
        store.setPaused(false)
        // The title cache may not have seen this session (its session/title
        // event can have landed while the user was elsewhere): the fold above
        // refreshed it from the SAME snapshot (one materialization, one blank
        // scan), so the sidebar shows the title immediately (web parity).
        store.append('status',
          `Session ${sessionId} in ${config.workspace} (resumed · ${snapshot.length} events in ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`, true)
      } catch (error) {
        clearInterval(probe)
        logErrorFileOnly('resume',
          `switch session=${id} FAILED open=${Date.now() - tOpen}ms openTicks=${ticks} total=${Date.now() - startedAt}ms`)
        // Fail loud in BOTH places: a one-line reason in the status bar (what
        // the user is looking at while the dialog/progress was up) and the full
        // explanation as a transcript row (the status bar cannot wrap).
        store.failSessionLoad(sessionLoadErrorText(error))
        store.append('status', describeResumeFailure(error), true)
      } finally {
        clearInterval(probe)
        clearInterval(ticker)
        store.endSessionLoading()
      }
    })()
  }
  store.setWorkspace(config.workspace)
  ctx.on('agent/status', (payload: { agent: { id: SessionId }; status: 'idle' | 'running' }) => {
    if (payload.agent.id !== sessionId) return
    if (payload.status === 'running') store.lastEscTime = 0 // fresh turn: clear a stale single-Esc window
    store.setRunning(payload.status === 'running')
  })
  // Live model deltas, in-process. Harness 0.1.5 removed the durable
  // `assistant/chunk` events the transcript used to stream from: the deltas now
  // arrive as `agent/assistant-stream` frames (start/chunk/end, attempt id and
  // dense index) and only the settled `assistant/message`/`assistant/attempt`
  // reaches the session log. The old host/client two-process split subscribed
  // here and forwarded each chunk to the client; with that split removed the
  // subscription lives in this process, filtered to the session being shown (the same filter the
  // `agent/status` subscription above uses), so the transcript still streams
  // token by token and the "preparing the request…" label clears on the first
  // delta.
  ctx.on('agent/assistant-stream', (payload: {
    agent: { id: SessionId }
    frame: { type?: string; chunk?: { type?: string; text?: string } }
  }) => {
    if (payload.agent.id !== sessionId) return
    if (payload.frame?.type !== 'chunk') return
    pendingSubmitProbe?.noteFirstChunk()
    store.endPreparingRequest()
    applyModelDelta(payload.frame.chunk)
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

  // S2: phase 1 may already have mounted the UI to paint the file-first screen
  // (see the boot block above) — `mountUi` is idempotent, so this never mounts a
  // second Ink root; on the attach-first path it is where the app comes up.
  mountUi()

  // S2-2b: the session is attached and the full command set is registered, so
  // replay whatever the user handed us while the read-only view was up —
  // through the NORMAL Enter path, so a queued `/compact` runs as the command
  // it is instead of being sent as text. `beforeCommand` goes away with the
  // read-only phase (a later session switch has its own load gate).
  store.beforeCommand = undefined
  if (pendingInputs.length > 0) {
    const replay = pendingInputs.splice(0, pendingInputs.length)
    for (const text of replay) {
      store.setInput(text)
      handleKey({ return: true })
    }
    store.setInput('')
  }
  await agent.whenIdle()
}

/** Order `resume` candidates by ACTIVITY — the session's log mtime — falling
 *  back to creation time when two logs share a timestamp. Pure so the rule is
 *  testable: `resume` must continue the session the user was last WORKING in, not
 *  the one most recently created (the two differ as soon as an older session is
 *  still in use — a daily driver next to freshly made throwaways).
 *  @param candidates - one entry per session, with both timestamps.
 *  @returns the same entries, newest activity first. */
export function orderResumeCandidates<T extends { readonly createdAt: number; readonly activeAt: number }>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((a, b) => (b.activeAt - a.activeAt) || (b.createdAt - a.createdAt))
}

/** The session the positional `resume` continues: the one with the most RECENT
 *  ACTIVITY (log mtime; creation time breaks ties).
 *
 *  Content is deliberately NOT a criterion: `resume` means "open the session I was
 *  last working in", and if that session happens to still be an unused blank, that
 *  is the session to open (in the conversation view — the hero is a launch-only
 *  screen). Requiring content used to fall back to an older session the user was
 *  not working in. A directory whose log is missing or unreadable is the only kind
 *  skipped, because nothing can be served from it.
 *  @param workspace - the workspace whose sessions to search.
 *  @returns the session id, or undefined when there is nothing to open. */
async function mostRecentlyActiveSession(workspace: string): Promise<string | undefined> {
  try {
    const dir = join(dshHomePath('sessions'), projectKey(workspace))
    const entries = readdirSync(dir, { withFileTypes: true })
    const candidates: { id: string; createdAt: number; activeAt: number }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const logPath = resolveSessionLogPath(join(dir, entry.name))
      if (logPath === undefined) continue
      const header = await new SessionLogReader(logPath).header()
      // The directory name is the encoded id; the header carries the CREATION
      // time, the file's mtime the last ACTIVITY (any writer updates it: this
      // process, another window, or `dsh web`). `resume` means "the session I was
      // just working in", so activity wins.
      const createdAt = typeof header?.createdAt === 'number' ? header.createdAt : 0
      let activeAt = createdAt
      try { activeAt = statSync(logPath).mtimeMs } catch { /* keep createdAt */ }
      candidates.push({ id: entry.name, createdAt, activeAt })
    }
    return orderResumeCandidates(candidates)[0]?.id
  } catch (error) {
    logErrorFileOnly('resume', `newest session lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
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
 * card dock: one question at a time inside the card, answers accumulated,
 * and the whole batch submits once every question is answered — then return
 * the human's answers. Options are single-select by default; a question the
 * caller flags `multiSelect` paints `[x]`/`[ ]` boxes whose checks Space /
 * digits / a click toggle and Enter commits. Both kinds offer a typeable
 * "Other" row whose editor opens inline under the option list — no second
 * dialog.
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
        picks: questions.map(() => []),
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
 * The inputs `findReusableBlank` needs for one workspace: the session rows and
 * the `inspect` capability it folds to a blank bit.
 *
 * Both come from the persistence service when the running composition can
 * answer, and from the session files otherwise. The files are not a corner
 * case: harness 0.1.3 replaced `SessionPersistence.inspect` with the handle
 * API, so a 0.1.5 composition lists rows but has NO `inspect` — reading only
 * the service made every blank-reuse path silently skip and mint a fresh empty
 * session per launch (`sessionInspector` owns that fallback).
 * @param ctx - the runtime context (sessionPersistence).
 * @param workspace - the workspace whose sessions to consider.
 * @returns the candidate rows and the `inspect` adapter.
 */
async function blankReuseSource(
  ctx: Context,
  workspace: string,
): Promise<{ inspection: SessionTitlesPersistence; headers: readonly SessionHeaderLike[] }> {
  const persistence = ctx.get('sessionPersistence') as {
    list?: (signal?: AbortSignal) => Promise<readonly unknown[]>
    inspect?: (id: SessionId) => Promise<{ events: readonly unknown[] }>
  } | undefined
  const inspection = sessionInspector(persistence, workspace)
  if (persistence?.list === undefined) {
    return { inspection, headers: await listSessionFiles(workspace) }
  }
  try {
    return { inspection, headers: listRowHeaders(await persistence.list()) }
  } catch {
    // A failing service list must not cost the reuse its candidate rows (nor
    // block the launch): the file-backed listing is the same data source the
    // /sessions dialog falls back to.
    return { inspection, headers: await listSessionFiles(workspace) }
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
/**
 * Candidate sessions for the auto-resume picker, most-recently-used first and
 * with the cheap HEAD facts already probed.
 *
 * Shared by {@link autoResumeNewest} (which resumes the first one with content)
 * and the launch's file-first screen (`QIALIKE_NO_FAST_FIRST_SCREEN`), so the
 * screen can only ever be painted for the session the attach is about to open —
 * two copies of this rule could show one session's tail and then attach another.
 * @param ctx - the runtime context (sessionPersistence list).
 * @param cwd - the workspace whose sessions to consider.
 * @returns the ordered candidates, or undefined when the list is unavailable.
 */
async function autoResumeCandidates(
  ctx: Context,
  cwd: string,
): Promise<Array<{ header: SessionHeaderLike; facts: ReturnType<typeof probeSessionHead> }> | undefined> {
  const persistence = ctx.get('sessionPersistence') as { list?: (signal?: AbortSignal) => Promise<readonly unknown[]> } | undefined
  if (persistence?.list === undefined) return undefined
  let list: readonly SessionHeaderLike[]
  try {
    list = listRowHeaders(await persistence.list())
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
  // Cheap HEAD probe first (web parity: the host decides `blank` from ~1 KB and
  // never opens a log to ask whether it has content). Resuming every candidate
  // to test it — the old behavior — decoded the WHOLE log per candidate, which
  // on a 1.4M-event session is seconds per attempt.
  return candidates.map((h) => ({ header: h, facts: probeSessionHead(cwd, String(h.id)) }))
}

async function autoResumeNewest(
  ctx: Context,
  agents: { resume(options: ResumeAgentOptions): Promise<AgentHandle> },
  cwd: string,
  agentOptions: { provider: string; model: string },
  setup: (agentCtx: Context) => void,
): Promise<AgentHandle | undefined> {
  const heads = await autoResumeCandidates(ctx, cwd)
  if (heads === undefined) return undefined
  const firstWithContent = heads.find((entry) => entry.facts !== undefined && entry.facts.confident && !entry.facts.blank)
  if (firstWithContent !== undefined) {
    // Oversized target: say WHY the next seconds are quiet, BEFORE the blocking
    // open.
    announceOversizedResume(cwd, firstWithContent.header.id)
    const handle = await withResumeCorruptRetry(
      () => agents.resume({ resumeSessionId: firstWithContent.header.id, agentOptions, setup }),
      { retries: 2, waitMs: 250 },
    )
    const hasUserContent = handle.agent.session.snapshotEvents().some(
      (event) => event.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'user',
    )
    if (hasUserContent) return handle
    await handle.dispose() // probe said content, the log disagrees → fall through
  }
  // Web parity: when no session has content, REUSE the newest unused blank
  // instead of creating yet another empty session (bounded to one blank per
  // workspace); older empties are disposed as before.
  let blankHandle: AgentHandle | undefined
  // Only blanks (and logs the probe could not classify) reach this loop; the
  // newest blank is kept as the reusable placeholder (web parity). A log the
  // HEAD probe could not classify is often a GIANT one (its first zstd frame is
  // bigger than the probe budget), so this loop — not the branch above — is
  // where an oversized session usually gets opened; warn here too.
  const leftover = heads
    .filter((entry) => entry.facts?.confident !== true || entry.facts.blank)
    .map((entry) => entry.header)
  for (const header of leftover) {
    try {
      // Retry a concurrent-write false "corrupt" read before skipping to the
      // next candidate (the newest session is often the one still being
      // appended to by the process that owns it).
      announceOversizedResume(cwd, header.id)
      const handle = await withResumeCorruptRetry(
        () => agents.resume({ resumeSessionId: header.id, agentOptions, setup }),
        { retries: 2, waitMs: 250 },
      )
      const hasUserContent = handle.agent.session.snapshotEvents().some(
        (event) => event.type === 'user/message'
          && (event.data as { source?: { kind?: string } }).source?.kind === 'user',
      )
      if (hasUserContent) {
        if (blankHandle !== undefined) await blankHandle.dispose()
        return handle
      }
      if (blankHandle === undefined) blankHandle = handle // newest empty: reusable blank
      else await handle.dispose() // older empty: skip to the next newest
    } catch {
      // Unresumable session (corrupt/unreadable): skip it.
    }
  }
  return blankHandle
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
 * The reasoning text carried by one 0.1.5 embedded assistant stream.
 *
 * The stream is the harness's `AssistantStreamRecord[]` (raw `chunk` records
 * plus packed `text-chunks`/`reasoning-chunks`/`tool-call-chunks` runs); the
 * harness's `expandAssistantStream` is the validating way to walk it. Only
 * reasoning deltas are returned: the settled message already carries the answer
 * text, exactly as the transcript treats the legacy `assistant/chunk` events.
 * Malformed or absent streams yield '' (a corrupt tail must not kill a resume).
 * @param stream - the event's `data.stream`, of unknown shape.
 * @returns the concatenated reasoning deltas, in order.
 */
function reasoningTextFromStream(stream: unknown): string {
  if (!Array.isArray(stream) || stream.length === 0) return ''
  let text = ''
  try {
    for (const entry of expandAssistantStream(stream as never)) {
      const chunk = (entry as { chunk?: { type?: string; text?: string } }).chunk
      if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') text += chunk.text
    }
  } catch {
    return ''
  }
  return text
}

/**
 * Fold a persisted session's event log into transcript rows, mirroring what
 * the live `session/event` listener renders — except assistant text comes from
 * the settled `assistant/message` events (streaming chunks are dropped) and
 * the whole result is produced in one pass so a resumed session replays
 * instantly instead of chunk-by-chunk.
 *
 * Exported for `tests/files-changed.test.ts`, which folds the durable event
 * shapes a REAL log carries (a turn's `tool/call` + `tool/result` + `turn/end`)
 * and asserts the turn-tail row — the resume path has no other seam to test.
 * @param events - the resumed session's full event log.
 * @param stats - optional bottom-bar stats accumulator; when given, each event
 * is folded into it during the same walk so a caller can also obtain the
 * session stats without a second pass over the log (see
 * {@link foldSessionReplay}).
 * @returns the transcript rows and the latest step list.
 */
export function foldHistoryEvents(events: readonly SessionEvent[], stats?: SessionStatsFolding): { items: TranscriptItem[]; steps: StepItem[] } {
  const items: TranscriptItem[] = []
  let key = 0
  let steps: StepItem[] = []
  // Counts/model of the last `compaction/summary` seen while walking the log,
  // consumed by the checkpoint message that immediately follows it (mirrors the
  // live listener's `pendingCompactionFacts`).
  let foldCompactionFacts: CompactionRowFacts | undefined
  /** Append reasoning text, merging into a trailing reasoning row (the same rule
   *  as `store.streamReasoning`, so resume and live render identically). */
  const pushReasoning = (delta: string): void => {
    if (delta === '') return
    const tail = items.at(-1)
    if (tail !== undefined && tail.kind === 'reasoning') {
      items[items.length - 1] = { ...tail, text: tail.text + delta }
    } else {
      items.push({ key: key += 1, kind: 'reasoning', text: delta })
    }
  }
  // The turn-tail "Files changed" ledger for THIS replay: the same rules the
  // live path applies (see `files-changed.ts`), folded over the log so a resumed
  // session shows the rows its turns produced.
  const filesChanged = new FilesChangedLedger()
  for (const event of events) {
    stats?.observe(event)
    // TWO vocabularies reach this fold and both must render:
    // - a 0.1.2 log stores one durable `assistant/chunk` event per delta;
    // - 0.1.5 folds the deltas into the message/attempt event's own `stream`
    //   (`assistant/message` / `assistant/attempt`) and dropped
    //   `assistant/chunk` from the session event union entirely.
    // Handling the legacy type outside the switch keeps the switch's typing
    // (and therefore its per-event narrowing) valid under either harness.
    const rawType = (event as unknown as { type: string }).type
    if (rawType === 'assistant/chunk') {
      const chunk = (event as unknown as { data?: { chunk?: { type?: string; text?: string } } }).data?.chunk
      if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') pushReasoning(chunk.text)
      continue
    }
    if (rawType === 'assistant/attempt') {
      // A model attempt that committed no surface message (failed/retried/
      // cancelled): only its reasoning is visible in the transcript.
      pushReasoning(reasoningTextFromStream((event as unknown as { data?: { stream?: unknown } }).data?.stream))
      continue
    }
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source as { kind?: string; plugin?: string } | undefined
        if (source?.kind === 'user') {
          const text = flattenContentText(event.data.content)
          if (text !== '') items.push({ key: key += 1, kind: 'user', text })
        } else if (isCompactionCheckpoint(source)) {
          // Web parity: a checkpoint becomes an expandable disclosure row (with
          // the summary the model wrote) instead of a generic context notice —
          // same row as the live path, because it is built from the same durable
          // events.
          const summary = compactionCheckpointSummary(flattenContentText(event.data.content))
          items.push({
            key: key += 1,
            kind: 'compaction',
            text: summary ?? '',
            compaction: {
              ...foldCompactionFacts ?? {},
              ...summary === undefined ? {} : { summary },
            },
          })
          foldCompactionFacts = undefined
        } else {
          const label = source?.kind === 'plugin' && source.plugin ? source.plugin : (source?.kind ?? 'context')
          items.push({ key: key += 1, kind: 'status', text: `Context injection · ${label}`, dim: true })
        }
        break
      }
      case 'compaction/summary': {
        const data = event.data as {
          shadowedSeqs?: readonly unknown[]
          shadowedTokenCount?: number
          provider?: string
          model?: string
        }
        foldCompactionFacts = {
          ...data.shadowedSeqs === undefined ? {} : { items: data.shadowedSeqs.length },
          ...data.shadowedTokenCount === undefined ? {} : { tokens: data.shadowedTokenCount },
          ...data.provider === undefined ? {} : { provider: data.provider },
          ...data.model === undefined ? {} : { model: data.model },
        }
        break
      }
      case 'assistant/message': {
        // assistant/message carries `{ turn, step, message }` (unlike
        // user/message, whose data IS the message). 0.1.5 also embeds the
        // attempt's exact timed stream here; its reasoning deltas rebuild the
        // same Think rows the legacy per-delta events used to produce.
        pushReasoning(reasoningTextFromStream((event.data as { stream?: unknown }).stream))
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
        const argsRaw = (event.data as { arguments?: string }).arguments
        const callData = event.data as { turn?: number; callId?: string; name?: string }
        if (callData.callId !== undefined) {
          filesChanged.call(callData.turn ?? 0, callData.callId, event.data.name, argsRaw)
        }
        // Replay the plan block exactly as the live listener appended it
        // (same `arguments` source; see the live 'tool/call' case above).
        if (event.data.name === EXIT_PLAN_TOOL) {
          const plan = extractPlanMarkdown(argsRaw)
          if (plan !== undefined) items.push({ key: key += 1, kind: 'plan', text: plan })
        }
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
        const resultMessage = (event.data as { message?: { content?: unknown; source?: { callId?: string } } }).message
        const { text, error } = toolResultDisplay(resultMessage)
        if (resultMessage?.source?.callId !== undefined) filesChanged.result(resultMessage.source.callId, error)
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
      case 'turn/end': {
        // Turn tail (web parity): the paths this turn WROTE, in the same
        // position the live path appends them (after the turn's rows).
        const paths = filesChanged.flush((event.data as { turn?: number }).turn ?? 0)
        if (paths.length > 0) items.push({ key: key += 1, kind: 'status', text: filesChangedLine(paths), dim: true })
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

// ── chunked resume (giant sessions): tail-first fast start ──────────────────
// A very long durable log folded synchronously blocks the first frame for
// seconds (a 123k-event session measured here). When the log is large the
// resume folds ONLY the newest tail for the first paint, marks the older part
// with a leading progress row, then folds the remaining ranges in background
// slices (each a setTimeout yield) that are prepended at the front of the
// transcript. Session stats fold separately in ONE chronological pass (per-step
// timing is order-sensitive). Any newer resume / /new / /clear aborts the
// background work (see abortResumeFold) — the transcript is replaced wholesale
// by the next load anyway, so an in-flight slice can only be dropped.
let resumeFoldAbort: AbortController | null = null

/** Background-fold idle scheduling. History folding shares the ONE main thread
 *  with the live session stream: between slices we always yield a beat, and
 *  while the agent is running with events still arriving (markActivity
 *  refreshes {@link Store.lastActivityAt}) the fold HOLDS the next slice and
 *  only continues during quiet gaps, so a folding slice never starves the
 *  live turn's layout/render (the "main loop blocked" stalls on giant
 *  sessions). */
/** Extra, state-change-only diagnostics for the older-history driver
 *  (`QIALIKE_DEBUG_RESUME=1`) — off by default so a long resume cannot flood
 *  `qialike.log` with one line per slice. */
const debugResumeFold = /^(1|true|yes|on)$/i.test(process.env.QIALIKE_DEBUG_RESUME ?? '')

const RESUME_FOLD_YIELD_MS = 16
const RESUME_FOLD_HOLD_MS = 200
const RESUME_FOLD_QUIET_GAP_MS = 150

/** Older-history window bound (优化4): while the user reads the live tail the
 *  resume keeps at most this many older-history items loaded; slices dropped
 *  beyond it land on an eviction stack and are re-folded on demand when the
 *  user scrolls back to the top, so very long sessions never hold their whole
 *  history in the transcript. Sessions whose older history fits under the cap
 *  load exactly as before (marker removed once event 0 is reached). */
export const RESUME_OLDER_ITEM_CAP = 4000

/** Older-history items kept loaded while the reader stays at the live tail.
 *
 *  P2③ (viewport-bounded retention): the transcript layout walks EVERY loaded
 *  item on every frame, so a fixed 4000-item window makes each frame cost
 *  O(4000 items) even on a 30-row terminal — one of the 4-6s wedges measured
 *  around a submit. The cap therefore scales with the VIEWPORT (12 rows of
 *  history per terminal row, floored at 400 so scrolling back stays smooth and
 *  capped at the historical maximum). Everything evicted this way is
 *  re-foldable on demand (see the fold driver's evicted stack), and the status
 *  bar/transcript marker tells the reader how to bring it back.
 *  @param rows - terminal rows (terminal height).
 *  @returns the item cap for that height. */
export function olderItemCap(rows: number): number {
  // Diagnostic override for the retention A/B (`QIALIKE_OLDER_CAP=2000|4000|8000`):
  // it changes only HOW MANY older items stay loaded, never the layout or
  // scroll semantics, so an A/B can measure whether the window size is what
  // makes frames expensive. Unset (the default) keeps the viewport formula.
  const override = Number(process.env.QIALIKE_OLDER_CAP ?? '')
  if (Number.isFinite(override) && override >= 200) return Math.min(20000, Math.round(override))
  if (!Number.isFinite(rows) || rows <= 0) return RESUME_OLDER_ITEM_CAP
  // Measured regression report: a 400-item floor made the fold driver
  // fold-and-evict in bulk (820k events evicted across 147 slices in one run)
  // because the tail window could never hold what it kept folding — pure waste,
  // since the retention size is NOT what makes frames slow (the layout probes
  // showed zero >200ms passes). The floor is therefore generous (≈40 rows of
  // history per terminal row, never below 2000): small enough that a huge
  // session is not held in full, large enough that the driver stops discarding
  // everything it folds.
  return Math.max(2000, Math.min(RESUME_OLDER_ITEM_CAP, Math.round(rows * 40)))
}

/** Bytes of one persisted session's durable log (the HIGHEST generation present:
 *  `session.vN.jsonl[.zstd]`, falling back to the v0 name), best-effort — the
 *  banner shows it so the user can tell "big log" from "small log" BEFORE the wait. */
function sessionLogBytes(cwd: string, id: string): number | undefined {
  try {
    const path = resolveSessionLogPath(sessionDir(cwd, SessionId(id)))
    if (path !== undefined) return statSync(path).size
  } catch { /* unreadable -> no size in the banner */ }
  return undefined
}

/** Wait until the frame carrying the loading banner has actually reached the
 *  terminal.
 *
 *  A blocking harness session-open would otherwise swallow the banner: Ink
 *  renders on a later tick, so the store update alone paints nothing before
 *  the thread is taken. The patched frame writer stamps
 *  `globalThis.__dshTuiLastFlushAt` on every flush, so we can wait for the
 *  NEXT flush (bounded — never stall the switch itself). */
async function paintBeforeBlock(timeoutMs = 150): Promise<void> {
  // `notify()` only SCHEDULES a render; a flush observed immediately after it
  // can still be the PREVIOUS frame (e.g. a fold-driven repaint). Give React a
  // tick to commit and Ink a frame to produce before waiting for the flush —
  // otherwise a labelled frame is "confirmed" by a stale one and the label never
  // reaches the terminal before the harness block (measured: the label frame
  // only surfaced 5.4 s later, after the block).
  await sleepFor(16)
  const host = globalThis as { __dshTuiLastFlushAt?: number }
  const before = host.__dshTuiLastFlushAt ?? 0
  const t0 = Date.now()
  for (;;) {
    if ((host.__dshTuiLastFlushAt ?? 0) > before) return
    if (Date.now() - t0 >= timeoutMs) return
    await sleepFor(8)
  }
}

/** Event-rate probe (`QIALIKE_DEBUG_LAYOUT=1`): counts `session/event`
 *  emissions so a multi-second freeze can be attributed to (or cleared of) an
 *  event storm hitting the TUI listener — the harness emits nothing while it
 *  recomputes internally, so a flat counter during a freeze proves the block is
 *  not ours. */
const debugLayoutEvents = /^(1|true|yes|on)$/i.test(process.env.QIALIKE_DEBUG_LAYOUT ?? '')
let eventsThisWindow = 0
let eventsForSession = 0
let eventRateAt = 0
export function eventRateTick(): void {
  if (!debugLayoutEvents) return
  const now = Date.now()
  if (eventRateAt === 0) { eventRateAt = now; return }
  if (now - eventRateAt < 2000) return
  logErrorFileOnly('events', `window=${Math.round((now - eventRateAt) / 1000)}s all=${eventsThisWindow} session=${eventsForSession}`)
  eventsThisWindow = 0
  eventsForSession = 0
  eventRateAt = now
}

/** Largest session size (events) for which the TUI still recommends running
 *  `/compact` (the TUI only SUGGESTS it — never runs it behind the user's back).
 *
 *  Recalibrated 2026-09-12 from the measured cost model (session/optimization-
 *  plan.md §8.11): the old 200 000 was DEAD — by the model that is multi-GB of
 *  retained heap, so the hint could only fire after the process had already run
 *  out of memory. The line now sits at the heaviest session actually measured:
 *  26 126 events / 20.9 MiB compressed / **~726 MB heap / 1.3 GB peak RSS /
 *  ~4.3 s open**. 25 000 events ≈ 17–21 MiB on these logs. */
export const COMPACT_HINT_EVENTS = 25_000

/** Durable log size above which `resume` warns BEFORE opening (the harness
 *  decodes the whole log synchronously inside `agents.resume`, so the user
 *  otherwise stares at the splash for seconds with no idea why). */
export const OVERSIZED_LOG_BYTES = 5 * 1024 * 1024

/** ── measured session cost model (session/optimization-plan.md §8.11) ────────
 *  Three real sessions, compressed → decoded JSON → retained heap:
 *    0.83 MiB →  3 MiB →  ~126 MB total  (900 events)
 *    8.07 MiB → 45 MiB →  353–362 MB     (12 560 events)   [delta +258 MB]
 *   20.88 MiB → 92 MiB →  725–726 MB     (26 126 events)   [delta +601 MB]
 *  Fits `heap ≈ 6 × decoded MB + 100 MB` within ~6 %, with decoded ≈ compressed
 *  × 5 (the measured ratio spans 3.6–5.6). The retained heap is the HARNESS's
 *  deep-frozen `this.log` — `snapshotEvents()` shares the event objects, so the
 *  plugin side only holds an array shell; these numbers cannot be improved
 *  plugin-side (measured, §8.11).
 *
 *  Used ONLY to make the size warnings quantitative — never to gate behaviour.
 *  Deliberately NO time estimate: attach is ~0.16 ms per STORED EVENT (measured
 *  0.151–0.166 ms across the three logs), but only the compressed byte size is
 *  at hand here, and bytes-per-event varied 0.57–0.82 KiB across them — a
 *  byte→seconds conversion would carry that ~1.4x spread. (An earlier note in
 *  this file claimed the open time varied 2.0–7.8 s for one log size; that
 *  spread was a timing bug — the bracket started at launch and swallowed the
 *  S2-2b read-only window — fixed in `attachNow`.) */
export const DECODED_PER_COMPRESSED = 5
export const HEAP_MB_PER_DECODED_MB = 6
export const HEAP_FLOOR_MB = 100

/** Retained-heap estimate (MB) for opening a session whose durable log is
 *  `logBytes` compressed. Pure so the measured points are pinned by tests. */
export function estimatedSessionHeapMb(logBytes: number): number {
  const decodedMb = (logBytes / 1048576) * DECODED_PER_COMPRESSED
  return Math.round(HEAP_MB_PER_DECODED_MB * decodedMb + HEAP_FLOOR_MB)
}

/** `342 MB` / `1.4 GB` — the memory half of the size warning. */
function formatMemoryMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

/** One line shown (synchronously, splash-style) before opening a large session.
 *  Pure so it is unit-tested. The memory figure is the measured model above —
 *  the number the user actually pays, which the raw log size does not show.
 *
 *  The cure named here is `/new` only: measured, `agents.resume()` costs
 *  ~0.16 ms per STORED event and compaction only APPENDS (a real log with 47
 *  `compaction/summary` events still carries `seq:0`), so `/compact` does not
 *  make opening faster — it shrinks what the model is sent, not this log. */
export function oversizedResumeNotice(bytes: number): string {
  const size = formatByteSize(bytes)
  const memory = formatMemoryMb(estimatedSessionHeapMb(bytes))
  return `qialike: resuming a large session (${size} log, ~${memory} memory) — opening it can take a while; `
    + '/new continues in a fresh, small log (/compact shrinks the model context, not this log)'
}

/** The warning to show for a durable log of `bytes` (undefined when the log is
 *  unknown or small enough to open promptly). Pure so it is unit-tested. */
export function oversizedResumeWarning(bytes: number | undefined): string | undefined {
  if (bytes === undefined || bytes < OVERSIZED_LOG_BYTES) return undefined
  return oversizedResumeNotice(bytes)
}

/** Sessions already announced, so a candidate loop that opens several sessions
 *  (auto-resume retries) cannot print the same warning twice. */
const announcedOversized = new Set<string>()

/** True once Ink owns the screen. S2-2b can mount the UI before the attach
 *  (the read-only view), so a raw stdout line written afterwards would scroll
 *  the painted frame out of place — the boot-time stdout warnings stand down
 *  and the load banner carries the information instead. */
let inkMounted = false

/** Warn (once per session) on the tty BEFORE a session is opened, when its
 *  durable log is big enough that the harness's synchronous decode will hold
 *  the thread for seconds.
 *
 *  The warning rides the same channel as the boot splash: it is written
 *  straight to stdout because Ink is not mounted yet, and the first frame
 *  repaints over it. Best-effort by design — a non-tty (piped/CI) launch stays
 *  quiet, and an unreadable log simply skips the hint.
 * @param cwd - the session's working directory (locates the durable log).
 * @param id - the session that is about to be opened.
 */
function announceOversizedResume(cwd: string, id: SessionId | string): void {
  const key = String(id)
  if (announcedOversized.has(key)) return
  announcedOversized.add(key)
  if (process.stdout.isTTY !== true) return
  // With the UI already mounted (S2-2b read-only view) a raw `\n`-terminated
  // line would scroll Ink's frame; the load banner states the size instead.
  if (inkMounted) return
  const warning = oversizedResumeWarning(sessionLogBytes(cwd, key))
  if (warning === undefined) return
  try {
    process.stdout.write(`\x1b[90m${warning}\x1b[0m\n`)
  } catch { /* best-effort: a closed stdout must not break the launch */ }
}

/** Facts behind one compaction-checkpoint DISCLOSURE row.
 *
 *  Web parity (`client/ui-chat` `CompactionItem`): the row names the compaction
 *  and states how much history it replaced, and expanding it shows the summary
 *  the model wrote. The TUI gets the summary from the checkpoint message itself
 *  (the harness frames it between the `<compacted-summary>` tags) and the counts
 *  from the paired `compaction/summary` event. */
export interface CompactionRowFacts {
  /** Summary markdown (undefined when the checkpoint message carried none). */
  readonly summary?: string
  /** Shadowed history items (`shadowedSeqs.length`). */
  readonly items?: number
  /** Shadowed tokens (`shadowedTokenCount`). */
  readonly tokens?: number
  /** Provider route that wrote the summary. */
  readonly provider?: string
  /** Model that wrote the summary. */
  readonly model?: string
}

/** Marker the harness's `compactCheckpointSource()` writes: a compaction
 *  checkpoint is a `user/message` whose source is this plugin provenance. */
export function isCompactionCheckpoint(source: { kind?: unknown; plugin?: unknown } | undefined): boolean {
  return source?.kind === 'plugin' && source.plugin === 'compact'
}

/** The summary markdown embedded in a compaction checkpoint message.
 *
 *  The harness frames the checkpoint as `preamble + <compacted-summary>…`, so
 *  the reader-facing summary is recoverable from the durable message alone —
 *  no correlation with the `compaction/summary` event is required (which is why
 *  a resumed log shows the same row as the live stream).
 *  @param text - the checkpoint message's flattened text.
 *  @returns the summary markdown, or undefined when the message carried none. */
export function compactionCheckpointSummary(text: string): string | undefined {
  const open = '<compacted-summary>'
  const close = '</compacted-summary>'
  const from = text.indexOf(open)
  if (from < 0) return undefined
  const body = text.slice(from + open.length)
  const to = body.indexOf(close)
  const summary = (to < 0 ? body : body.slice(0, to)).trim()
  return summary === '' ? undefined : summary
}

/** One-line collapsed/expanded header for a compaction row.
 *
 *  Shared by the renderer AND the text-row mirror used for scroll/selection
 *  geometry, so the two can never disagree on the row's content (the same rule
 *  the tool rows follow). Wording mirrors the harness command result
 *  (`Compacted N history items (~X tokens).`) with the token count shortened the
 *  way the footer does, because a transcript row is one line.
 *  @param facts - the checkpoint's facts.
 *  @param expanded - disclosure state (drives the leading `-`/`+`).
 *  @returns the header line. */
export function compactionRowHeader(facts: CompactionRowFacts, expanded: boolean): string {
  const mark = expanded ? '-' : '+'
  if (facts.items !== undefined && facts.tokens !== undefined) {
    return `${mark} Compaction · Compacted ${facts.items} history items (~${formatCompactTokens(facts.tokens)} tokens)`
  }
  if (facts.items !== undefined) return `${mark} Compaction · Compacted ${facts.items} history items`
  if (facts.summary !== undefined) return `${mark} Compaction · older history folded into a summary`
  return `${mark} Compaction · older history folded (summary not in this log)`
}

/** One-line suggestion shown for an oversized session (transcript + status
 *  bar). Pure so it is unit-tested.
 *
 *  Both cures are named WITH their real effect (measured, §8.11): `/compact`
 *  shrinks the assembled context (turns), `/new` starts a fresh, small log
 *  (which is what makes opening fast again — compaction only appends). */
export function compactHintText(events: number): string {
  const millions = events >= 1_000_000 ? `${(events / 1_000_000).toFixed(1)}M` : `${Math.round(events / 1000)}k`
  return `Large session (${millions} events) — /compact keeps turns fast; /new starts a fresh, small log`
}

/** One step's assembly timeline (S0 probe). Timestamps are `Date.now()` marks
 *  taken while the single thread runs the step in order, so the deltas are the
 *  real synchronous costs:
 *   - `startedAt`   : our `step/start` handler (the harness emits it right
 *                     before it assembles the request),
 *   - `streamAt`    : the LLM adapter's stream call = **assembly end**
 *                     (`prepareRequest` + `systemPrompt.project` + `buildRequest`),
 *   - `chunkAt`     : the first streamed chunk = **network TTFT**. */
interface SubmitProbeStep {
  turn: number
  step: number
  cold: boolean
  startedAt: number
  streamAt: number
  bytes: number
  messages: number
  chunkAt: number
  /** Adapter's fetch call = after the payload was serialized. */
  fetchAt: number
  retries: number
}
/** In-flight submit probe (P0 diagnostics + S0 assembly timeline). */
interface SubmitProbe {
  startedAt: number
  events: number
  heapMb: number
  steps: SubmitProbeStep[]
  logLabel: () => string
  noteFollowup: () => void
  noteFirstEvent: () => void
  noteStepStart: (turn: number, step: number) => void
  noteRequest: (bytes: number, messages: number) => void
  noteFetch: () => void
  noteFirstChunk: () => void
  noteStepEnd: (turn: number, step: number) => void
}
let pendingSubmitProbe: SubmitProbe | null = null

/** The LLM adapter lives in a separate module (which the bundler can load as a
 *  second copy), so the in-flight probe is ALSO published on globalThis: the
 *  adapter reads that object directly, which works across module copies (the
 *  same seam the frame writer uses: `__dshTuiLastFlushAt`). */
type AssemblyProbeSeam = {
  __dshSubmitProbe?: { noteRequest: (bytes: number, messages: number) => void; noteFetch: () => void }
}

/** Counts/model of the `compaction/summary` event whose replacement
 *  `user/message` (the checkpoint) has not arrived yet — the harness appends
 *  the two back to back, so the disclosure row can carry real numbers instead
 *  of guessing them from `sourceEventSeqs`. */
let pendingCompactionFacts: CompactionRowFacts | undefined

/** Live count of the CURRENT session's events (P2②): reading it must never
 *  call `snapshotEvents()` — on a 1.4M-event session that materializes/copies a
 *  huge array, and the submit probe used to do it twice per submit. Seeded from
 *  the snapshot the resume path already holds, then incremented per live event. */
let sessionEventCount = 0

/** Last long-running activity (diagnostic): the panel's slow-frame probe prints
 *  it so a multi-second freeze says what the loop was doing when frames
 *  stopped. Cheap enough to call at every suspicious site; off unless
 *  `QIALIKE_DEBUG_LAYOUT=1` gates the consumer. */
let activityLabel = 'idle'
export function noteActivity(label: string): void { activityLabel = `${label}@${Date.now()}` }
export function describeActivity(): string { return activityLabel }

function sleepFor(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/** How many newest durable events phase 1 folds for the first screen (S2).
 *  `SessionLogReader.readTail` is frame-granular, and this log's frame layout
 *  makes the choice cheap: it returns 851 events (36 ms decode) for 1 000-6 000
 *  and jumps to the WHOLE 12 282-event log (347 ms) above that, because the log
 *  holds one 7.4 MB frame followed by ~449 small ones (.scan/tail-window-probe.ts). */
const FIRST_SCREEN_EVENTS = Number(process.env.QIALIKE_FIRST_SCREEN_EVENTS ?? 1_500)

/**
 * S2 phase 1: paint the newest events of a `--resume` session STRAIGHT FROM THE
 * DURABLE LOG, before the harness attaches.
 *
 * `agents.resume()` decodes the whole log synchronously inside the harness
 * (measured 1 795-1904 ms on this session) and blocks the thread it runs on, so
 * today the UI cannot exist until it is done. The log is a concatenation of
 * independent zstd frames, so the tail can be decoded by ourselves in ~70 ms
 * (measured: head probe 18 ms + reader open 18 ms + `readTail(1500)` 36 ms +
 * fold ~32 ms) — the same events the harness would hand us, just without
 * waiting for it. The transcript then paints while the attach still runs.
 *
 * Everything here is best-effort: any failure returns null and the caller keeps
 * the previous boot path (attach first), so a corrupt or missing log cannot break
 * the launch.
 * @param store - the TUI store to paint into.
 * @param cwd - the session's workspace (project key).
 * @param id - the session id to resume.
 * @returns the event/item counts and elapsed ms, or null when nothing was painted.
 */
async function paintFileFirstScreen(store: Store, cwd: string, id: string): Promise<{ events: number; items: number; ms: number; tailStart: number } | null> {
  const t0 = Date.now()
  try {
    const path = resolveSessionLogPath(sessionDir(cwd, SessionId(id)))
    if (path === undefined) return null
    const reader = new SessionLogReader(path)
    const tail = await reader.readTail(FIRST_SCREEN_EVENTS)
    if (tail.events.length === 0) return null
    // The reader returns durable log records; the fold is written against the
    // harness event union but deliberately handles the durable-only vocabulary
    // (`assistant/chunk`, packed rows) — it is what resume replays either way.
    const events = tail.events as unknown as readonly SessionEvent[]
    const folded = foldHistoryEvents(events)
    if (folded.items.length === 0) return null
    store.adoptPermission(lastSandboxMode(events))
    store.beginHistory(folded.items, folded.steps, tail.startSeq)
    const ms = Date.now() - t0
    logErrorFileOnly('resume',
      `first screen from file: events=${tail.events.length} startSeq=${tail.startSeq} items=${folded.items.length} ms=${ms}`)
    return { events: tail.events.length, items: folded.items.length, ms, tailStart: tail.startSeq }
  } catch (error) {
    // Best-effort: the launch falls back to the attach-first path below.
    logErrorFileOnly('resume', `first screen from file failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** Wait until the frame writer has really flushed a frame (the patched writer
 *  stamps `__dshTuiLastFlushAt` on every write), so a blocking harness call that
 *  follows cannot swallow the first screen we just painted. Bounded: a terminal
 *  that never flushes must not delay the attach. */
async function waitForFirstPaint(capMs = 1_200): Promise<boolean> {
  const g = globalThis as unknown as { __dshTuiLastFlushAt?: number }
  const start = Date.now()
  while (Date.now() - start < capMs) {
    await sleepFor(10)
    if ((g.__dshTuiLastFlushAt ?? 0) >= start) return true
  }
  return false
}

function abortResumeFold(): void {
  resumeFoldAbort?.abort()
  resumeFoldAbort = null
}

/** Resume one agent's session history into the store without freezing the
 *  first frame on giant logs (see the block above). Small logs keep the
 *  original single-pass fold; large logs paint the recent tail synchronously
 *  (fast), then continue folding older ranges in the background.
 *  @param store - the transcript store.
 *  @param session - the resumed agent session (durable log snapshot source).
 *  @param preloaded - the snapshot the caller already took (it also answers the
 *  title/blank questions), so the events are never materialized twice. */
/** Event count above which the FULL stats pass is skipped (P2①, user call A):
 *  a 1.4M-event session would spend seconds scanning every event for numbers the
 *  status bar shows in one line — the loaded window answers well enough, and the
 *  status bar marks the difference instead of pretending it is exact. */
export const STATS_FULL_SCAN_MAX = 200_000

function resumeHistoryIntoStore(
  store: Store,
  session: { id: string; snapshotEvents(): readonly SessionEvent[] },
  preloaded?: readonly SessionEvent[],
  paintedTailStart?: number,
): void {
  // P2①: the caller usually already holds the snapshot (it folds title/blank
  // from it); taking it again would materialize a second 1.4M-event array.
  const events = preloaded ?? session.snapshotEvents()
  sessionEventCount = events.length
  const t0 = Date.now()
  // S2-2a: when the launch painted this session's tail STRAIGHT FROM THE LOG
  // (phase 1), that tail is already on screen. Rebuilding the transcript from
  // the harness snapshot would replace ~5 100 rows in one Ink commit — measured
  // 1.2 s of blocked main loop after the attach — so keep those rows and fold
  // the older events in yielded slices below, exactly like the giant-log path.
  const keepPaintedTail = paintedTailStart !== undefined && paintedTailStart > 0 && paintedTailStart <= events.length
  const plan = keepPaintedTail
    ? { mode: 'chunked' as const, tailStart: paintedTailStart, olderRanges: planOlderRanges(safeBoundaries(events), paintedTailStart) }
    : planResumeFold(events)
  const planTail = plan.mode === 'chunked' ? events.length - plan.tailStart : events.length
  logErrorFileOnly('resume',
    `fold mode=${plan.mode} events=${events.length}${plan.mode === 'chunked' ? ` tail=${planTail} olderRanges=${plan.olderRanges.length}` : ''}`)
  if (plan.mode === 'fast') {
    // Small history: the original one-pass fold + full stats, exactly as
    // before this change.
    const replay = foldSessionReplay(events)
    store.loadHistory(replay.items, replay.steps)
    store.setStats(replay.stats)
    logErrorFileOnly('resume', `fast session=${session.id} events=${events.length} items=${replay.items.length} ms=${Date.now() - t0}`)
    return
  }
  // A `fast` plan paints everything in one pass, so reaching here means the
  // plan is `chunked` and there IS older history to fold.
  if (plan.mode !== 'chunked') return
  abortResumeFold()
  const abort = new AbortController()
  resumeFoldAbort = abort
  // The synchronous first frame: fold only the newest tail (already cut at a
  // safe boundary), show it with a leading "loading older history" marker. A
  // painted tail (S2-2a) is skipped: those rows — and the marker — are already
  // in the store, and re-folding them only to throw them away is what cost 1.2 s.
  let bestSteps: StepItem[] = []
  if (keepPaintedTail) {
    logErrorFileOnly('resume',
      `painted tail kept: tailStart=${plan.tailStart} olderRanges=${plan.olderRanges.length} (no transcript rebuild)`)
  } else {
    const tail = foldHistoryEvents(tailSlice(plan, events))
    store.beginHistory(tail.items, tail.steps, plan.tailStart)
    // Steps: the tail usually carries the newest todo/write, but a recent tail
    // may contain none — then the latest step list lives in the newest OLDER
    // slice (the first one processed below).
    bestSteps = tail.steps
  }
  const t1 = Date.now()
  void (async (): Promise<void> => {
    try {
      // Session stats need chronological order (per-step timing pairs
      // step/start with step/end), so they fold in ONE full pass here instead
      // of across the out-of-order display slices; bounded into slices so the
      // pass never blocks the thread for a whole giant log at once.
      const stats = createSessionStatsFolding()
      const statsFullScan = events.length <= STATS_FULL_SCAN_MAX
      store.setStatsWindowOnly(!statsFullScan)
      if (statsFullScan) {
        const statsSlice = 50_000
        for (let i = 0; i < events.length; i += statsSlice) {
          if (abort.signal.aborted) return
          const end = Math.min(i + statsSlice, events.length)
          for (let j = i; j < end; j++) stats.observe(events[j]!)
          if (end < events.length) await sleepFor(RESUME_FOLD_YIELD_MS)
        }
      }
      // ── Windowed older-history driver (优化3 idle scheduling + 优化4 on-demand) ──
      // `plan.olderRanges` is chronological (oldest → newest). Slices are
      // folded newest-first and each result prepended in front of the
      // already-painted history, so the transcript under the marker stays
      // newest-first. `foldedNewestFirst` mirrors that order; eviction pops
      // from its END (chronological OLDEST, the items directly under the
      // marker) and pushes onto `evictedOldestFirst` (also oldest-first), so
      // slices dropped while the user reads the live tail can be re-folded on
      // demand when the user scrolls back to the top.
      const ranges = plan.olderRanges
      const foldedNewestFirst: { from: number; to: number; items: number }[] = []
      const evictedOldestFirst: { from: number; to: number; items: number }[] = []
      let cursor = ranges.length - 1 // next ORIGINAL slice to fold (newest-unfolded first)
      // Unique older-event accounting: loaded = total − not-yet-folded − evicted.
      let unfoldedEv = plan.tailStart
      let evictedEv = 0
      const progress = (): void => {
        store.setHistoryProgress(Math.max(0, plan.tailStart - unfoldedEv - evictedEv), plan.tailStart)
      }
      const foldRange = async (from: number, to: number): Promise<void> => {
        // P2③ part 2: attribute a wedge to the SLICE that caused it (a slice can
        // hide one enormous tool body), with the heap before/after so a major GC
        // pause is distinguishable from real packing work.
        const foldT0 = debugResumeFold ? Date.now() : 0
        const heapBefore = debugResumeFold ? process.memoryUsage().heapUsed : 0
        // Window stats (P2①, mode A): the slices we fold anyway are observed
        // here, so an oversized session pays ONE bounded pass per slice instead
        // of a full 1.4M-event scan up front.
        const slice = events.slice(from, to)
        if (!statsFullScan) for (const event of slice) stats.observe(event)
        noteActivity(`fold slice ${from}-${to} events=${to - from}`)
        const chunk = foldHistoryEvents(slice)
        if (chunk.items.length > 0) {
          noteActivity(`prepend ${chunk.items.length} items`)
          store.prependHistory(chunk.items)
          foldedNewestFirst.push({ from, to, items: chunk.items.length })
        }
        if (bestSteps.length === 0 && chunk.steps.length > 0) bestSteps = chunk.steps
        if (debugResumeFold) {
          const ms = Date.now() - foldT0
          if (ms > 200) {
            const heapAfter = process.memoryUsage().heapUsed
            logErrorFileOnly('fold',
              `slow slice=${from}-${to} events=${to - from} items=${chunk.items.length} ms=${ms} `
              + `heapBefore=${Math.round(heapBefore / 1024 / 1024)}MB heapAfter=${Math.round(heapAfter / 1024 / 1024)}MB `
              + `heapDelta=${Math.round((heapAfter - heapBefore) / 1024 / 1024)}MB`)
          }
        }
      }
      /** Fold one slice — an original range first (they are chronologically
       *  OLDER than anything evicted), then an evicted slice nearest to the
       *  still-loaded content. Returns false when there is nothing left. */
      const stepFold = (): Promise<boolean> | boolean => {
        let from = 0
        let to = 0
        if (cursor >= 0) {
          const range = ranges[cursor]!
          from = range[0]
          to = range[1]
          cursor -= 1
          unfoldedEv -= to - from
        } else if (evictedOldestFirst.length > 0) {
          const rec = evictedOldestFirst.pop()!
          from = rec.from
          to = rec.to
          evictedEv -= to - from
        } else {
          return false
        }
        const done = foldRange(from, to)
        progress()
        if (done instanceof Promise) return done.then(() => true)
        return true
      }
      const nearTop = (): boolean => !store.followTail && store.layoutScroll <= Math.max(1, store.layoutViewport)
      /** While the user reads the live tail, drop the oldest loaded older
       *  slices once more than {@link RESUME_OLDER_ITEM_CAP} are held (memory
       *  bound for very long sessions); the dropped ranges land on the
       *  evicted stack and are re-folded near the top on demand. */
      const evictOverCap = (): boolean => {
        let over = store.loadedOlder - olderItemCap(store.rows)
        if (over <= 0 || foldedNewestFirst.length === 0) return false
        const popped: { from: number; to: number; items: number }[] = []
        let droppedItems = 0
        while (droppedItems < over && foldedNewestFirst.length > 0) {
          const rec = foldedNewestFirst.pop()!
          popped.push(rec)
          droppedItems += rec.items
        }
        const trimmed = store.trimOlderFront(Math.max(0, store.loadedOlder - droppedItems))
        if (trimmed > 0) {
          // popped is already chronological-oldest-first; older content goes to
          // the FRONT of the evicted stack.
          evictedOldestFirst.unshift(...popped)
          for (const rec of popped) evictedEv += rec.to - rec.from
          progress()
          return true
        }
        // Nothing was trimmed: restore the popped records untouched. The caller
        // MUST NOT retry in a tight loop — this is the shape of a hang (see the
        // no-progress guard below), so report failure and let it rest.
        for (let i = popped.length - 1; i >= 0; i--) foldedNewestFirst.push(popped[i]!)
        return false
      }
      let lastLoopState = ''
      /** Set once the tail window has filled (cap reached / an eviction was
       *  needed). While the reader stays at the live tail the driver then RESTS
       *  instead of folding more: anything it folded next would be evicted on
       *  the following iteration, and the evicted ranges are exactly as cheap to
       *  fold on demand when the reader scrolls up. Measured before this guard:
       *  `evictedEv=757,661` — **53% of the 1.43M folded events were folded and
       *  thrown away**, the resume's fold ran ~130 s and kept the process at
       *  24-39% CPU for minutes after opening a giant session. Cleared whenever
       *  the reader leaves the tail, so scrolling up resumes folding. */
      let tailWindowFilled = false
      /** Consecutive iterations that changed nothing (belt and braces against a
       *  future no-progress path: an unguarded `continue` in this loop takes the
       *  only JS thread and kills keyboard/mouse input outright). */
      let stalled = 0
      let lastProgressKey = ''
      for (;;) {
        // Diagnostic (gated: `QIALIKE_DEBUG_RESUME=1`), logged only when the
        // driver's STATE changes — never 1 Hz spam while resting. It exists
        // because the "bar stuck at 98%" report had to be measured, not guessed.
        if (debugResumeFold) {
          const state = `cursor=${cursor} evicted=${evictedOldestFirst.length} `
            + `loadedOlder=${store.loadedOlder >= RESUME_OLDER_ITEM_CAP ? 'cap' : store.loadedOlder} `
            + `followTail=${store.followTail} nearTop=${nearTop()} running=${store.running}`
          if (state !== lastLoopState) {
            lastLoopState = state
            logErrorFileOnly('resume',
              `older loop ${state} unfolded=${unfoldedEv} evictedEv=${evictedEv} `
              + `done=${Math.max(0, plan.tailStart - unfoldedEv - evictedEv)}`)
          }
        }
        if (abort.signal.aborted) return
        // Idle scheduling (优化3): while the live turn is running with events
        // still arriving, hold — the fold must never compete with live
        // layout/render on the one thread.
        if (store.running && Date.now() - store.lastActivityAt < RESUME_FOLD_QUIET_GAP_MS) {
          await sleepFor(RESUME_FOLD_HOLD_MS)
          continue
        }
        // Trim over-cap older while the user stays at the live tail. The yield
        // is mandatory: this branch used to `continue` with no await, so an
        // eviction that could not get under the cap spun the thread forever.
        if (store.followTail && store.loadedOlder > olderItemCap(store.rows)) {
          store.setHistoryHolding(true)
          tailWindowFilled = true
          const trimmed = evictOverCap()
          if (!trimmed) {
            logErrorFileOnly('resume',
              `evict made no progress (loadedOlder=${store.loadedOlder} cap=${olderItemCap(store.rows)} `
              + `pending=${foldedNewestFirst.length}); resting instead of spinning`)
          }
          await sleepFor(RESUME_FOLD_YIELD_MS)
          continue
        }
        // Done when every original slice and every evicted slice is loaded.
        if (cursor < 0 && evictedOldestFirst.length === 0) break
        // Pacing (优化4): at the tail we keep only a bounded window of older
        // history; in the middle of the transcript we do not grow older
        // content ABOVE the viewport (inserting it would shift what the user
        // is reading) — older loads happen near the top and at the tail.
        if (store.followTail) {
          // At the live tail we keep a BOUNDED window (RESUME_OLDER_ITEM_CAP)
          // and REST. Two cases must both rest, or the loop churns:
          //   · the window is full (loadedOlder ≥ cap), or
          //   · every original slice is folded and the only work left is what
          //     was EVICTED to keep the window bounded — re-folding that here
          //     pushes straight back over the cap, so the driver would cycle
          //     fold → evict → fold … forever (measured: `done` oscillating
          //     ±500 events around 98.4% with `evicted=5`, CPU spinning, and
          //     the readout looking permanently stuck).
          // Resting shows an honest readout; folding resumes when the reader
          // scrolls back up (nearTop → followTail false).
          // The viewport rule (M6.3): once the painted transcript already fills
          // the terminal, the reader needs NOTHING older for what is on screen —
          // and the tail is painted before this loop starts, so a giant session
          // rests here on the first iteration instead of folding ~900k events
          // over ~22 s (measured, with a progress bar parked in the status row and
          // those events held in memory). Scrolling up clears `followTail` and
          // folding resumes, which is the on-demand behaviour M2 intended.
          const viewportFilled = store.getItems().length >= store.rows
          if (tailWindowFilled
            || viewportFilled
            || store.loadedOlder >= olderItemCap(store.rows)
            || (cursor < 0 && evictedOldestFirst.length > 0)) {
            store.setHistoryHolding(true)
            // Loaded as much as this view needs: report it ONCE and drop the
            // progress indicator (it comes back if the reader scrolls up).
            store.settleHistoryLoad(Math.max(0, plan.tailStart - unfoldedEv - evictedEv))
            // The tail already fills the viewport, so nothing older is needed for
            // what the reader is looking at: remove the marker ROW too, or a
            // finished background fold keeps a "Older history: …% events" line on
            // screen that reads as "still loading" (reported twice from the real
            // terminal). Scrolling up clears `followTail` and folding resumes with
            // the marker re-inserted by the driver.
            if (viewportFilled && store.olderLoading) store.finishHistory()
            await sleepFor(RESUME_FOLD_HOLD_MS)
            continue
          }
        } else {
          // Reader left the live tail: folding is wanted again.
          tailWindowFilled = false
          if (!nearTop()) {
            store.setHistoryHolding(true)
            await sleepFor(RESUME_FOLD_HOLD_MS)
            continue
          }
        }
        // Fold one slice, then always breathe between slices (even an 8 ms
        // slice back-to-back with the live stream can starve a frame).
        store.setHistoryHolding(false)
        store.unsettleHistoryLoad()
        const progressKey = `${cursor}|${evictedOldestFirst.length}|${store.loadedOlder}|${unfoldedEv}`
        if (progressKey === lastProgressKey) stalled += 1
        else { stalled = 0; lastProgressKey = progressKey }
        if (stalled > 5) {
          logErrorFileOnly('resume', `fold driver made no progress for ${stalled} iterations (${progressKey}); resting`)
          stalled = 0
          await sleepFor(RESUME_FOLD_HOLD_MS)
          continue
        }
        if (!(await stepFold())) break
        await sleepFor(RESUME_FOLD_YIELD_MS)
      }
      if (abort.signal.aborted) return
      store.settleHistoryLoad(events.length)
      store.finishHistory()
      store.setSteps(bestSteps)
      store.setStats(stats.snapshot())
      logErrorFileOnly('resume', `chunked session=${session.id} events=${events.length} items=${store.getItems().length} older=${plan.tailStart} firstFrameMs=${t1 - t0} totalMs=${Date.now() - t0}`)
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      logErrorFileOnly('resume', `background fold failed: ${message}`)
    } finally {
      if (resumeFoldAbort === abort) resumeFoldAbort = null
    }
  })()
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

/** Phase of one in-flight manual `/compact`.
 *
 *  `selecting` is the phase BEFORE the harness writes `compaction/start`: the
 *  engine walks the session surface to pick a compactable range, and on a
 *  1.45 M-event session that walk held the only JS thread for **4.04 s**
 *  (measured: `[stall] no timer callback for 4041ms`, with the durable
 *  `compaction/start` record landing 49 ms before the stall line). It is a
 *  phase, not a progress bar: nothing can be painted during it. */
export type CompactionPhase = 'selecting' | 'summarizing' | 'committing'

/** Live state of an in-flight manual `/compact`. */
export interface CompactionState {
  /** Epoch ms the command was accepted (drives the elapsed seconds). */
  readonly startedAt: number
  readonly phase: CompactionPhase
  /** Summary output counted so far (tokens). */
  readonly tokens: number
  /** True while `tokens` is an estimate; false once the provider reported usage. */
  readonly estimated: boolean
  /** Output budget the harness sent for the summary (`GenerateOptions.maxTokens`,
   *  from the compaction config — 8192 by default). */
  readonly budget?: number
  /** User messages the harness is holding until the compaction settles. */
  readonly queued: number
}

/** Compact token counts for the status bar (`950`, `1.2k`, `8.2k`). */
export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1000) return String(Math.round(tokens))
  return `${(tokens / 1000).toFixed(1)}k`
}

/** One-line status-bar text for an in-flight `/compact`.
 *
 *  Honesty rules mirror `Load session:`: the elapsed seconds appear only once
 *  the 250 ms ticker actually fired (proof the loop is alive), and the token
 *  counter appears only once the summary stream has produced something. The
 *  `selecting` phase — the harness's synchronous range walk — carries NO clock
 *  at all, because that walk is exactly what freezes the loop.
 *  @param state - the in-flight compaction.
 *  @param now - current epoch ms (injectable for tests).
 *  @param ticked - whether the ticker fired since the command started.
 *  @returns the status-bar string. */
export function compactionStatusText(state: CompactionState, now: number, ticked: boolean): string {
  const queued = state.queued > 0 ? ` · ${state.queued} queued` : ''
  if (state.phase === 'selecting') return `Compacting:  selecting older history…${queued}`
  if (state.phase === 'committing') {
    const secs = ticked ? ` · ${Math.max(0, (now - state.startedAt) / 1000).toFixed(1)}s` : ''
    return `Compacting:  committing…${secs}${queued}`
  }
  const counted = state.tokens > 0
    ? ` · ${state.estimated ? '~' : ''}${formatCompactTokens(state.tokens)}`
      + `${state.budget === undefined ? '' : `/${formatCompactTokens(state.budget)}`} tokens`
    : ''
  const secs = ticked ? ` · ${Math.max(0, (now - state.startedAt) / 1000).toFixed(1)}s` : ''
  return `Compacting:  summarizing${counted}${secs}${queued}`
}

/** One-line status text for a FAILED `/compact`.
 *
 *  The harness classifies the failure, but its per-code sentence (mirrored
 *  verbatim from `dsh-command-compact`) is generic by design; the CONCRETE
 *  reason lives in the error message — e.g. `summary is not smaller than the
 *  shadowed content (8123 estimated framed tokens >= 5120)` for the shrink
 *  refusal, or `no credential for provider route "…"` for a missing key.
 *  Showing only the generic sentence hid that reason from the reader (a real
 *  report: two `/compact` runs failed for 14 s and said nothing useful), so
 *  both are shown, with the reason clipped to keep it a status line.
 *  @param error - whatever `compactNow` threw.
 *  @param cancelled - whether OUR abort signal was the cause (the harness
 *    rethrows the raw abort reason verbatim instead of classifying it, so a
 *    user-cancelled run arrives as e.g. `The operation was aborted.` and would
 *    otherwise read as an unexplained failure — measured in a real terminal).
 *  @returns the status text. */
export function compactionFailureText(error: unknown, cancelled = false): string {
  if (cancelled) return COMPACTION_FAILURE_TEXT.cancelled
  const raw = error instanceof Error ? error.message : String(error)
  const reason = (raw.split('\n')[0] ?? '').trim()
  const clip = reason.length > 240 ? `${reason.slice(0, 239)}…` : reason
  if (error instanceof ManualCompactionError) {
    const base = COMPACTION_FAILURE_TEXT[error.code]
    // A cancellation needs no reason: the only thing the abort produces here is
    // the runtime's own artifact (`abort@[native code]` from the fetch seam),
    // which would read as noise next to the harness's sentence.
    if (error.code === 'cancelled') return base
    return clip === '' || base.includes(clip) ? base : `${base} — ${clip}`
  }
  return `compaction: ${clip === '' ? 'unknown error' : clip}`
}

/** One manual `/compact` request: run the harness compaction seam on the live
 *  agent and report the outcome the way the harness `/compact` command does.
 *
 *  The status bar follows the run: `selecting older history…` (pre-painted,
 *  because the harness's range walk blocks the loop for seconds), then
 *  `summarizing · ~N/8.2k tokens · Ns` driven by the compaction-tagged LLM
 *  stream (see `TuiLlmAdapter.stream`), then `committing…`. Esc aborts through
 *  the harness's own cancellation signal. */
async function compact(ctx: Context, agent: unknown): Promise<void> {
  const compaction = ctx.get('compaction') as
    | { compactNow?: (agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId: string) => Promise<CompactionResult | null> }
    | undefined
  if (compaction?.compactNow === undefined) {
    store.append('status', 'compaction service unavailable', true)
    return
  }
  if (store.compactionActive) {
    // One manual compaction at a time (the harness would answer `busy` anyway).
    store.flashStatus('Compaction is already running', 4000)
    return
  }
  const controller = new AbortController()
  const rowsBefore = store.getItems().length
  store.beginCompaction(Date.now())
  store.setCompactionCancel(() => controller.abort())
  const ticker = setInterval(() => store.tickCompaction(), 250)
  try {
    // The harness selects the compactable range and assembles the summary
    // request SYNCHRONOUSLY, and only then writes `compaction/start`. The
    // pre-paint therefore has to happen here, before the call: waiting for the
    // event would leave the seconds-long walk with nothing on screen.
    await paintBeforeBlock()
    const result = await compaction.compactNow(
      // The live agent (agent-loop's Agent) implements the compaction contract
      // (runMaintenance + session + options) even though the public dsh-agent
      // type only exposes `id`, so the seam's own context type is asserted here.
      agent as ManualCompactAgentContext,
      controller.signal,
      `tui-${randomUUID()}`,
    )
    // A successful run already landed a checkpoint DISCLOSURE row (same counts,
    // plus the summary) — repeating it as a status line would say the same thing
    // twice. The status line stays for the outcomes that have no checkpoint
    // (nothing to compact, failure) and as a fallback if the live event never
    // reached this session's listener.
    const landed = store.getItems().slice(rowsBefore).some((item) => item.kind === 'compaction')
    if (result === null) store.append('status', 'No compactable history yet.', true)
    else if (!landed) {
      store.append('status',
        `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`, true)
    }
    logErrorFileOnly('compact', result === null
      ? 'compact: no compactable history'
      : `compact: compacted items=${result.shadowedSeqs.length} tokens=${result.shadowedTokenCount} row=${landed}`)
  } catch (error) {
    logErrorFileOnly('compact', error)
    store.append('status', compactionFailureText(error, controller.signal.aborted), true)
  } finally {
    clearInterval(ticker)
    store.setCompactionCancel(null)
    store.endCompaction()
  }
}
