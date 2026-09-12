/**
 * Session-title lookup for the session lists (`/resume`, `/sessions`).
 *
 * The harness base bundle mounts `session-title` + `session-title-llm`
 * (`dsh-session-title`, `dsh-session-title-first-prompt-llm`): after a
 * session's first eligible human message, a deterministic fallback title
 * (leading words of that message) is appended as a `session/title` event, then
 * an LLM provider may fold in a more polished title. Titles are session-log
 * events, so they persist with the session (write-behind) and survive
 * restarts — including sessions switched away by `/new`.
 *
 * This module makes those titles available to the TUI lists cheaply. The
 * runtime feeds every live `session/title` event into a title cache (memory +
 * `$DSH_HOME/dsh-tui-titles.json`) at zero read cost, and the list lookup
 * renders from that cache immediately, inspecting persisted logs in the
 * background only for sessions the cache has not seen. A title is written once
 * (during a session's first turn) and then frozen, so the cache stays
 * authoritative across restarts without re-reading every session log.
 *
 * @module @yourname/dsh-tui-app/session-titles
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { lastActivity } from './session-activity.ts'
import type { SessionSummary } from './index.tsx'

/** One row of the persisted-session store (as returned by `list`). */
export interface SessionHeaderLike {
  readonly id: SessionId
  readonly cwd?: string
  readonly createdAt?: number
}

/**
 * Normalize one `sessionPersistence.list()` row to the flat header shape the UI
 * uses. Harness 0.1.5 wraps every row as `{ header, revision, sizeBytes }`
 * (`SessionPersistenceSnapshot`); earlier compositions returned the header
 * object itself. Without this unwrap the `/sessions` picker filtered EVERY row
 * out — `h.cwd === workspace` was always false — so the dialog reported "no
 * sessions in this directory" (and Ctrl+R rename / Ctrl+D delete, which need a
 * highlighted row, were unreachable).
 * @param row - one element of `list()`'s result, of unknown shape.
 * @returns the flat header, or undefined when the row carries no usable id.
 */
export function listRowHeader(row: unknown): SessionHeaderLike | undefined {
  if (row === null || typeof row !== 'object') return undefined
  const wrapped = (row as { header?: unknown }).header
  const candidate = (wrapped !== null && typeof wrapped === 'object' ? wrapped : row) as {
    id?: unknown
    cwd?: unknown
    createdAt?: unknown
  }
  const id = candidate.id
  if (typeof id !== 'string' && (id === null || typeof id !== 'object')) return undefined
  return {
    id: id as SessionId,
    ...typeof candidate.cwd === 'string' ? { cwd: candidate.cwd } : {},
    ...typeof candidate.createdAt === 'number' ? { createdAt: candidate.createdAt } : {},
  }
}

/** {@link listRowHeader} over a whole `list()` result. */
export function listRowHeaders(rows: readonly unknown[]): SessionHeaderLike[] {
  const out: SessionHeaderLike[] = []
  for (const row of rows) {
    const header = listRowHeader(row)
    if (header !== undefined) out.push(header)
  }
  return out
}

/** The slice of `sessionPersistence` this module needs. */
export interface SessionTitlesPersistence {
  inspect(id: SessionId): Promise<{ events: readonly unknown[] }>
}

/** A cached title with its write timestamp (used for pruning). A user rename
 *  (Ctrl+R) is stored separately from the auto title and wins for display. */
interface TitleCacheEntry {
  /** Auto title (harness session/title events, folded from the log). */
  auto?: string
  /** User rename (Ctrl+R), authoritative over `auto`. */
  user?: string
  savedAt: number
}

/**
 * Mutable module state.
 *
 * IMPORTANT: the SEA build compiles each panel entry (index.tsx, the
 * conversation panel, the sessions panel, …) as its OWN esbuild bundle, so
 * top-level state in this file would be duplicated per bundle: a title written
 * through the runtime entry's copy would never reach the sidebar / session-list
 * copies (each keeps its own empty memory cache after one disk load) until a
 * restart re-read the disk cache. All mutable state therefore lives on ONE
 * object anchored to the process global — every bundle copy runs in the same
 * realm — so every consumer reads and writes the same caches.
 */
interface TitleState {
  /** In-memory title cache; disk is loaded lazily on first use. */
  map: Map<string, TitleCacheEntry>
  diskLoaded: boolean
  /** In-memory pinned id set; disk loaded lazily. */
  pinSet: Set<string>
  pinLoaded: boolean
  /** In-memory blank-session bits (web parity, NOT persisted): true = the
   *  session has no `turn/start` yet, so it is an unused "New Session"
   *  placeholder. Absent = unknown (callers treat it as non-blank). */
  blank: Map<string, boolean>
}

const STATE_KEY = Symbol.for('dsh-tui.session-titles.state')
const shared: TitleState = (() => {
  const holder = globalThis as unknown as Record<symbol, TitleState | undefined>
  let state = holder[STATE_KEY]
  if (state === undefined) {
    state = {
      map: new Map<string, TitleCacheEntry>(),
      diskLoaded: false,
      pinSet: new Set<string>(),
      pinLoaded: false,
      blank: new Map<string, boolean>(),
    }
    holder[STATE_KEY] = state
  }
  return state
})()

/** Absolute path of the dsh-tui title cache file. */
function cachePath(): string {
  return dshHomePath('dsh-tui-titles.json')
}

/** Load the disk cache once; a missing/unparsable file yields an empty map. */
function ensureDiskLoaded(): void {
  if (shared.diskLoaded) return
  shared.diskLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const candidate = entry as { title?: unknown; auto?: unknown; user?: unknown; savedAt?: unknown }
      // Legacy entries stored the plain title; treat them as the auto title.
      if (typeof candidate.title === 'string' && candidate.title.trim() !== '') {
        shared.map.set(id, { auto: candidate.title, savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : 0 })
        continue
      }
      const next: TitleCacheEntry = { savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : 0 }
      if (typeof candidate.auto === 'string' && candidate.auto.trim() !== '') next.auto = candidate.auto
      if (typeof candidate.user === 'string' && candidate.user.trim() !== '') next.user = candidate.user
      shared.map.set(id, next)
    }
  } catch {
    // Missing or malformed cache file -> cold start.
  }
}

/** Persist the cache atomically (best-effort; an unwritable home must not crash). */
function persistDiskCache(): void {
  const path = cachePath()
  try {
    const document: Record<string, TitleCacheEntry> = {}
    for (const [id, entry] of shared.map) document[id] = entry
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(document, null, 2) + '\n')
  } catch {
    // best-effort
  }
}

/** The effective title for display: user rename wins over the auto title. */
function titleOf(id: SessionId): string | undefined {
  const entry = shared.map.get(String(id))
  return entry?.user ?? entry?.auto
}

/**
 * Remember the auto session title (the runtime calls this on every live
 * `session/title` event). A user rename is never overwritten.
 * @param id - the session id.
 * @param title - the normalized title text.
 */
export function rememberTitle(id: SessionId, title: string): void {
  ensureDiskLoaded()
  const key = String(id)
  const trimmed = title.trim()
  if (trimmed === '') return
  const entry = shared.map.get(key)
  if (entry !== undefined && entry.user !== undefined) return
  shared.map.set(key, { ...entry, auto: trimmed, savedAt: Date.now() })
  persistDiskCache()
}

/**
 * Remember a session's folded title when its live `session/title` event may
 * have been missed. Titles generate asynchronously (fallback after the first
 * eligible message, then an optional LLM provider pass); a title event that
 * lands while the user has switched to another session is dropped by the
 * current-session event filter, and nothing else re-reads the log for the
 * switched-away session — so the cache can stay empty for a session that
 * already has a title. Switching back folds the in-memory event log (zero
 * I/O) and fills the gap. A user rename is never overwritten.
 * @param id - the session id.
 * @param events - the session's event log (typically the in-memory snapshot).
 */
export function rememberFoldedTitle(id: SessionId, events: readonly unknown[]): void {
  const folded = foldSessionTitle(events as readonly SessionEvent[])?.title
  if (folded !== undefined) rememberTitle(id, folded)
}

/**
 * Rename a session (Ctrl+R in the /sessions dialog). The name is stored in
 * the local title cache (survives restarts); an empty name clears the user
 * rename and falls back to the auto title. The harness session log is not
 * touched.
 * @param id - the session id.
 * @param title - the new display title, or '' to clear the rename.
 */
export function renameTitle(id: SessionId, title: string): void {
  ensureDiskLoaded()
  const key = String(id)
  const trimmed = title.trim()
  const entry = shared.map.get(key)
  if (trimmed === '') {
    if (entry?.user !== undefined) {
      if (entry.auto !== undefined) shared.map.set(key, { auto: entry.auto, savedAt: Date.now() })
      else shared.map.delete(key)
      persistDiskCache()
    }
    return
  }
  shared.map.set(key, { ...entry, user: trimmed, savedAt: Date.now() })
  persistDiskCache()
}

/**
 * Forget a session's cached title (called after the session is deleted).
 * @param id - the deleted session id.
 */
export function forgetTitle(id: SessionId): void {
  ensureDiskLoaded()
  shared.blank.delete(String(id))
  if (shared.map.delete(String(id))) persistDiskCache()
}

/** Drop a deleted session's PIN too: `forgetTitle`/`forgetActivity` were called
 *  on delete but the pin set was not, so `dsh-tui-pinned.json` kept the id of a
 *  session that no longer exists — an entry that can never match again (ids are
 *  UUIDs) and only grows the file. */
export function forgetPin(id: SessionId): void {
  ensurePinnedLoaded()
  if (shared.pinSet.delete(String(id))) persistPinned()
}

// ── blank ("New Session") sessions — web parity ──────────────────────────────

/** The message-producing event types: the conversation itself. */
const CONVERSATION_TYPES = new Set<string>(['user/message', 'assistant/message', 'tool/result'])

/** Fold whether a session log is still BLANK — an unused "New Session"
 *  placeholder rather than history.
 *
 *  The harness list projection flips blank on the first `turn/start`, and that is
 *  right for the harness's own sessions … but a log can carry a REAL conversation
 *  with no turn markers: a `/fork` child's seed deliberately drops them (see
 *  `fork-seed.ts`), and any future seed-based flow can too. Judging such a
 *  session "blank" was not cosmetic — it showed the hero over a full transcript on
 *  `dsh-tui resume`, and the SAME bit drives `/new`'s blank adoption
 *  (`findReusableBlank`) and `/sessions`' blank hiding, so a real conversation
 *  could be adopted as the new placeholder and hidden from the list.
 *  @param events - the session's durable events.
 *  @returns true when the session has neither started a turn nor produced any
 *    message. */
export function foldSessionBlank(events: readonly unknown[]): boolean {
  for (const event of events) {
    const type = (event as { type?: unknown }).type
    if (type === 'turn/start') return false
    if (typeof type === 'string' && CONVERSATION_TYPES.has(type)) return false
  }
  return true
}

/** Record one session's blank bit (live `turn/start` flips it false forever). */
export function rememberBlank(id: SessionId, blank: boolean): void {
  shared.blank.set(String(id), blank)
}

/** The known blank bit: an explicit record, else `false` once a title exists
 *  (a title implies content), else `undefined` (unknown — callers treat an
 *  unknown row as ordinary history, never hiding it). */
export function sessionBlank(id: SessionId): boolean | undefined {
  ensureDiskLoaded()
  const known = shared.blank.get(String(id))
  if (known !== undefined) return known
  return titleOf(id) === undefined ? undefined : false
}

/** Hide every UNUSED "New Session" placeholder except the selected one — the
 *  web Workspace-browser rule ("shows only the selected blank entry"). Keeps
 *  ordinary history untouched and is a no-op while the current session is the
 *  blank itself.
 *  @param rows - summaries newest-first.
 *  @param currentId - the selected session, or undefined.
 *  @returns the rows to display. */
export function hideUnselectedBlanks(
  rows: readonly SessionSummary[],
  currentId: SessionId | undefined,
): SessionSummary[] {
  return rows.filter((row) => row.blank !== true || currentId === undefined || String(row.id) === String(currentId))
}

/**
 * Find a reusable blank session for `cwd` (web parity: "New Session reuses a
 * blank one targeting the same workspace"), newest activity first. Titled
 * sessions are skipped (content); untitled candidates are inspected and their
 * blank bit recorded. Bounded to the newest `limit` candidates.
 * @param persistence - sessionPersistence service (inspect).
 * @param headers - rows from `persistence.list()`.
 * @param cwd - the workspace directory the blank must belong to.
 * @param excludeId - a session id never to reuse (the current one).
 * @param limit - maximum candidate logs to inspect (default 20).
 * @returns the reusable blank id, or undefined when none exists.
 */
export async function findReusableBlank(
  persistence: SessionTitlesPersistence,
  headers: readonly SessionHeaderLike[],
  cwd: string,
  excludeId: SessionId | undefined,
  limit = 20,
): Promise<SessionId | undefined> {
  ensureDiskLoaded()
  const candidates = headers
    .filter((h) => h.cwd === cwd && (excludeId === undefined || String(h.id) !== String(excludeId)))
    .sort((a, b) => (lastActivity(b.id) ?? b.createdAt ?? 0) - (lastActivity(a.id) ?? a.createdAt ?? 0))
    .slice(0, limit)
  for (const header of candidates) {
    if (sessionBlank(header.id) === false) continue
    if (titleOf(header.id) !== undefined) {
      rememberBlank(header.id, false)
      continue
    }
    try {
      const inspection = await persistence.inspect(header.id)
      const blank = foldSessionBlank(inspection.events)
      rememberBlank(header.id, blank)
      if (blank) return header.id
    } catch {
      // Unreadable candidate: leave unknown and try the next one.
    }
  }
  return undefined
}

/**
 * The effective display title of one session (user rename wins over the auto
 * title) — the single-row read used by the right-sidebar session line; the
 * /sessions list still reads through listWithTitles. Cache-only (never
 * inspects the session log); undefined when untitled or the cache is absent.
 * @param id - the session id.
 * @returns the display title, or undefined when none is cached.
 */
export function sessionDisplayTitle(id: SessionId): string | undefined {
  ensureDiskLoaded()
  return titleOf(id)
}

/** Label for one session: `标题 · @时间`, or just `@时间` when untitled. */
function labelOf(header: SessionHeaderLike, title: string | undefined): string {
  const time = header.createdAt === undefined ? '' : `@${new Date(header.createdAt).toLocaleString()}`
  const trimmed = title?.trim()
  if (trimmed === undefined || trimmed === '') return time
  return time === '' ? trimmed : `${trimmed} · ${time}`
}

/** Build sorted summaries for the given headers with the given title lookup.
 *  Most-recently-used first (last activity, then creation time). */
function buildRows(
  headers: readonly SessionHeaderLike[],
  titleOf: (id: SessionId) => string | undefined,
): SessionSummary[] {
  const rows = headers.map((header) => ({
    summary: {
      id: header.id,
      title: titleOf(header.id),
      label: labelOf(header, titleOf(header.id)),
      cwd: header.cwd,
      createdAt: header.createdAt,
      blank: sessionBlank(header.id) === true,
    },
    createdAt: header.createdAt,
  }))
  rows.sort((a, b) => {
    const activityA = lastActivity(a.summary.id) ?? 0
    const activityB = lastActivity(b.summary.id) ?? 0
    if (activityA !== activityB) return activityB - activityA
    return (b.createdAt ?? 0) - (a.createdAt ?? 0)
  })
  return rows.map(({ summary }) => summary)
}

/**
 * Fold titles for the newest 40 cache-missing sessions into the cache. Only
 * the newest sessions matter: the lists are newest-first and callers cap them
 * (e.g. slice(0, 40)), so older sessions keep their time label.
 * @param persistence - sessionPersistence service (inspect).
 * @param headers - rows from `persistence.list()`.
 */
async function foldMissingTitles(
  persistence: SessionTitlesPersistence,
  headers: readonly SessionHeaderLike[],
): Promise<void> {
  const hasTitle = (id: SessionId): boolean => titleOf(id) !== undefined
  const toInspect = [...headers]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, 40)
    .filter((h) => !hasTitle(h.id))
  await Promise.all(toInspect.map(async (header): Promise<void> => {
    try {
      // Cheap path first: the head probe answers BOTH title and blank for the
      // sessions whose facts land early (a 26 MB log costs one bounded read
      // instead of a whole-log decode).
      const head = headTitleProbe?.(header)
      if (head !== undefined && head.confident) {
        if (head.title !== undefined) rememberTitle(header.id, head.title)
        rememberBlank(header.id, head.blank)
        return
      }
      const inspection = await persistence.inspect(header.id)
      // Same pass learns the blank bit (one inspect serves both facts).
      rememberBlank(header.id, foldSessionBlank(inspection.events))
      const title = foldSessionTitle(inspection.events as readonly SessionEvent[])?.title
      if (title !== undefined) rememberTitle(header.id, title)
    } catch {
      // Unreadable session log: leave the time-only label.
    }
  }))
}

/**
 * Session summaries for the /resume and /sessions lists, newest first.
 *
 * Renders immediately from the title cache (no session-log reads), then folds
 * missing titles in the background and reports the enriched list through
 * `onUpdated` — so the dialog opens instantly and titles appear as they are
 * folded. An unreadable log degrades to its time label rather than failing the
 * whole list.
 * @param persistence - sessionPersistence service (inspect).
 * @param headers - rows from `persistence.list()`.
 * @param onUpdated - optional callback with the fully enriched list (invoked
 *   asynchronously after background folding finishes).
 * @returns summaries from the cache, ready to render immediately.
 */
export async function listWithTitles(
  persistence: SessionTitlesPersistence,
  headers: readonly SessionHeaderLike[],
  onUpdated?: (rows: SessionSummary[]) => void,
): Promise<SessionSummary[]> {
  ensureDiskLoaded()
  if (headers.some((h) => titleOf(h.id) === undefined)) {
    void foldMissingTitles(persistence, headers).then(() => {
      if (onUpdated !== undefined) onUpdated(buildRows(headers, titleOf))
    })
  }
  return buildRows(headers, titleOf)
}

/**
 * Warm the title cache in the background (called shortly after launch): fold
 * missing titles for the newest persisted sessions so the first `/sessions` /
 * `/resume` open is already fully titled.
 * @param persistence - sessionPersistence service (inspect).
 * @param headers - rows from `persistence.list()`.
 */
/** Per-session HEAD probes resolved by the caller (see `session-head.ts`): a
 *  title usually lands EARLY, so a bounded head read replaces a full-log decode
 *  for the common case (web parity: summaries come from bounded probes). */
export type HeadTitleProbe = (header: SessionHeaderLike) => { title?: string; blank: boolean; confident: boolean } | undefined

let headTitleProbe: HeadTitleProbe | null = null

/** Install the head-probe hook (the runtime sets it at boot). */
export function setHeadTitleProbe(probe: HeadTitleProbe | null): void {
  headTitleProbe = probe
}

export async function prewarmTitles(
  persistence: SessionTitlesPersistence,
  headers: readonly SessionHeaderLike[],
): Promise<void> {
  ensureDiskLoaded()
  await foldMissingTitles(persistence, headers)
}

// ── pinned sessions (Ctrl+F in the /sessions dialog) ────────────────────────

/** Absolute path of the pinned-sessions file. */
function pinnedPath(): string {
  return dshHomePath('dsh-tui-pinned.json')
}

/** Load the pinned set once; a missing/unparsable file yields an empty set. */
function ensurePinnedLoaded(): void {
  if (shared.pinLoaded) return
  shared.pinLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(pinnedPath(), 'utf8')) as unknown
    if (Array.isArray(parsed)) {
      for (const id of parsed) if (typeof id === 'string') shared.pinSet.add(id)
    }
  } catch {
    // Missing or malformed file -> empty set.
  }
}

/** Persist the pinned set (best-effort). */
function persistPinned(): void {
  const path = pinnedPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify([...shared.pinSet], null, 2) + '\n')
  } catch {
    // best-effort
  }
}

/** Whether a session is pinned (pinned sessions sort to the top). */
export function isPinned(id: SessionId): boolean {
  ensurePinnedLoaded()
  return shared.pinSet.has(String(id))
}

/**
 * Toggle a session's pinned state (Ctrl+F in the /sessions dialog). Pinned
 * sessions survive restarts and sort to the top of the list.
 * @param id - the session id.
 * @returns the new pinned state.
 */
export function togglePin(id: SessionId): boolean {
  ensurePinnedLoaded()
  const key = String(id)
  if (shared.pinSet.has(key)) shared.pinSet.delete(key)
  else shared.pinSet.add(key)
  persistPinned()
  return shared.pinSet.has(key)
}
