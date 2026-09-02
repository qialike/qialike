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

/** In-memory title cache; disk is loaded lazily on first use. */
const memoryCache = new Map<string, TitleCacheEntry>()
let diskLoaded = false

/** Absolute path of the dsh-tui title cache file. */
function cachePath(): string {
  return dshHomePath('dsh-tui-titles.json')
}

/** Load the disk cache once; a missing/unparsable file yields an empty map. */
function ensureDiskLoaded(): void {
  if (diskLoaded) return
  diskLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const candidate = entry as { title?: unknown; auto?: unknown; user?: unknown; savedAt?: unknown }
      // Legacy entries stored the plain title; treat them as the auto title.
      if (typeof candidate.title === 'string' && candidate.title.trim() !== '') {
        memoryCache.set(id, { auto: candidate.title, savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : 0 })
        continue
      }
      const next: TitleCacheEntry = { savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : 0 }
      if (typeof candidate.auto === 'string' && candidate.auto.trim() !== '') next.auto = candidate.auto
      if (typeof candidate.user === 'string' && candidate.user.trim() !== '') next.user = candidate.user
      memoryCache.set(id, next)
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
    for (const [id, entry] of memoryCache) document[id] = entry
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(document, null, 2) + '\n')
  } catch {
    // best-effort
  }
}

/** The effective title for display: user rename wins over the auto title. */
function titleOf(id: SessionId): string | undefined {
  const entry = memoryCache.get(String(id))
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
  const entry = memoryCache.get(key)
  if (entry !== undefined && entry.user !== undefined) return
  memoryCache.set(key, { ...entry, auto: trimmed, savedAt: Date.now() })
  persistDiskCache()
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
  const entry = memoryCache.get(key)
  if (trimmed === '') {
    if (entry?.user !== undefined) {
      if (entry.auto !== undefined) memoryCache.set(key, { auto: entry.auto, savedAt: Date.now() })
      else memoryCache.delete(key)
      persistDiskCache()
    }
    return
  }
  memoryCache.set(key, { ...entry, user: trimmed, savedAt: Date.now() })
  persistDiskCache()
}

/**
 * Forget a session's cached title (called after the session is deleted).
 * @param id - the deleted session id.
 */
export function forgetTitle(id: SessionId): void {
  ensureDiskLoaded()
  if (memoryCache.delete(String(id))) persistDiskCache()
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
      const inspection = await persistence.inspect(header.id)
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
export async function prewarmTitles(
  persistence: SessionTitlesPersistence,
  headers: readonly SessionHeaderLike[],
): Promise<void> {
  ensureDiskLoaded()
  await foldMissingTitles(persistence, headers)
}

// ── pinned sessions (Ctrl+F in the /sessions dialog) ────────────────────────

/** In-memory pinned id set; disk loaded lazily. */
const pinned = new Set<string>()
let pinnedLoaded = false

/** Absolute path of the pinned-sessions file. */
function pinnedPath(): string {
  return dshHomePath('dsh-tui-pinned.json')
}

/** Load the pinned set once; a missing/unparsable file yields an empty set. */
function ensurePinnedLoaded(): void {
  if (pinnedLoaded) return
  pinnedLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(pinnedPath(), 'utf8')) as unknown
    if (Array.isArray(parsed)) {
      for (const id of parsed) if (typeof id === 'string') pinned.add(id)
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
    writeFileSync(path, JSON.stringify([...pinned], null, 2) + '\n')
  } catch {
    // best-effort
  }
}

/** Whether a session is pinned (pinned sessions sort to the top). */
export function isPinned(id: SessionId): boolean {
  ensurePinnedLoaded()
  return pinned.has(String(id))
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
  if (pinned.has(key)) pinned.delete(key)
  else pinned.add(key)
  persistPinned()
  return pinned.has(key)
}
