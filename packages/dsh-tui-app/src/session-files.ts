/**
 * Direct session-file deletion for the `/sessions` dialog.
 *
 * The harness persistence layer exposes no session-delete API (checked:
 * `SessionPersistence` and the jsonl backend), so deleting a history session
 * removes its on-disk artifact directly. The jsonl backend stores sessions at
 * `dshHomePath('sessions')/<projectKey(cwd)>/<encodeSegment(id)>/session.jsonl`
 * (plus optional `.zstd`); `list()` scans those directories, so a removed
 * directory disappears from `/sessions` and auto-resume.
 *
 * The path-encoding rules are reimplemented here from
 * `dsh-session-persistence-jsonl/src/format.ts` (lossy human-readable project
 * key, `~XXXX` escapes). Only ever delete sessions that are NOT the live one —
 * the write-behind coordinator still holds the live session's file open.
 *
 * @module @yourname/dsh-tui-app/session-files
 */

import { existsSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionLogReader, type DurableEvent } from './log-frames.ts'
import type { SessionHeaderLike } from './session-titles.ts'

/** True for characters the jsonl backend keeps verbatim in path segments. */
function isSafeSegmentChar(ch: string): boolean {
  return ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
}

/** Escape one character the harness way: `~XXXX` (uppercase hex). */
function escapeSegmentChar(ch: string): string {
  return `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * Reimplement `projectKey(cwd)` from dsh-session-persistence-jsonl: separators
 * collapse to one `-`, safe chars stay, everything else becomes `~XXXX`, then
 * the whole key is wrapped in `--…--`.
 * @param cwd - the session's working directory.
 * @returns the filesystem-safe project directory name.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) return '--root--'
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i]!
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (isSafeSegmentChar(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += escapeSegmentChar(ch)
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Reimplement `encodeSegment(id)` from dsh-session-persistence-jsonl for a
 * session id (typically `session-<uuid>`, which is already safe).
 * @param id - the session id.
 * @returns the filesystem-safe segment name.
 */
export function encodeSegment(id: SessionId): string {
  const raw = String(id)
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    out += isSafeSegmentChar(ch) ? ch : escapeSegmentChar(ch)
  }
  return out
}

/**
 * The on-disk directory owning one persisted session.
 * @param cwd - the session's working directory (header cwd).
 * @param id - the session id.
 * @returns the absolute session directory path.
 */
export function sessionDir(cwd: string, id: SessionId): string {
  return join(dshHomePath('sessions'), projectKey(cwd), encodeSegment(id))
}

/**
 * Permanently delete one persisted session's directory (and therefore its
 * entry in `list()`). Best-effort: the caller surfaces failures as status.
 * @param cwd - the session's working directory (header cwd).
 * @param id - the session id to delete.
 */
export async function deleteSession(cwd: string, id: SessionId): Promise<void> {
  await rm(sessionDir(cwd, id), { recursive: true, force: true })
}

/**
 * The harness's canonical log filename: `session.jsonl[.zstd]` is generation 0,
 * `session.vN.jsonl[.zstd]` is generation N (N ≥ 1). Harness 0.1.5 writes the
 * CURRENT generation (`session.v3.jsonl.zstd`) and never moves or deletes the
 * older ones, so a reader that hardcodes `session.jsonl.zstd` silently shows a
 * STALE transcript (and, for a session written only by the new harness, the
 * wrong file entirely).
 */
const SESSION_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/

/**
 * The log file the harness itself would read out of `dir`: the numerically
 * highest generation present, preferring `.zstd` when both encodings of that
 * generation exist. Unreadable directories and directories without a canonical
 * log yield undefined.
 * @param dir - one session's directory.
 * @returns the absolute path, or undefined when no generation exists.
 */
export function resolveSessionLogPath(dir: string): string | undefined {
  let names: readonly string[]
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  let best: { name: string; version: number; zstd: number } | undefined
  for (const name of names) {
    const match = SESSION_LOG_NAME.exec(name)
    if (match === null) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    const zstd = match[2] === '.zstd' ? 1 : 0
    if (best === undefined || version > best.version || (version === best.version && zstd > best.zstd)) {
      best = { name, version, zstd }
    }
  }
  return best === undefined ? undefined : join(dir, best.name)
}

/**
 * The path a reader should open for one session, falling back to the v0 name
 * when the directory holds no log yet (a session that exists only in memory,
 * e.g. immediately after `/new`).
 * @param cwd - the session's working directory (header cwd).
 * @param id - the session id.
 * @returns the absolute log path (may not exist).
 */
export function sessionLogPath(cwd: string, id: SessionId): string {
  const dir = sessionDir(cwd, id)
  return resolveSessionLogPath(dir) ?? join(dir, 'session.jsonl.zstd')
}

/** One session's log, searching every project directory when the given
 *  workspace does not hold it (a session id is unique across the home, and
 *  `/export <id>` / `/sessions` may name a session created elsewhere). */
export function findSessionLogPath(cwd: string, id: SessionId): string | undefined {
  const direct = sessionLogPath(cwd, id)
  if (existsSync(direct)) return direct
  try {
    const root = dshHomePath('sessions')
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = resolveSessionLogPath(join(root, entry.name, encodeSegment(id)))
      if (candidate !== undefined) return candidate
    }
  } catch { /* unreadable home: report no log */ }
  return undefined
}

/**
 * Read one session's whole durable log through the file-backed reader (highest
 * generation present, historical packed rows and current rows both decoded).
 *
 * This is the client's stand-in for `persistence.inspect` when the harness's
 * persistence service is out of reach — in host mode it lives in the host child.
 * Windowed so a giant log never lands in one slice burst; callers that want the
 * whole transcript (export, title folding) hold the result on purpose.
 * @param cwd - the session's working directory (project key).
 * @param id - the session id.
 * @returns every event of the session, in log order.
 * @throws when no canonical log exists for that session.
 */
export async function readSessionEvents(cwd: string, id: SessionId): Promise<DurableEvent[]> {
  const path = findSessionLogPath(cwd, id)
  if (path === undefined) throw new Error(`no persisted log for ${String(id)}`)
  const reader = new SessionLogReader(path)
  const total = await reader.totalEvents()
  const out: DurableEvent[] = []
  const window = 100_000
  for (let from = 0; from < total; from += window) {
    for (const event of await reader.read(from, Math.min(from + window, total))) out.push(event)
  }
  return out
}

/**
 * List this workspace's persisted sessions straight from disk, by reading frame
 * 0 (the header) of each session directory's log.
 *
 * The `/sessions` dialog used to ask the harness for the list, which is empty in
 * host mode — the persistence service is in the host child — so the picker (and
 * with it rename/delete) could never see a session. A project directory holds
 * one header read per session, which is bounded and cheap even for a directory
 * of giant logs.
 * @param cwd - the workspace whose project directory to scan.
 * @returns header-shaped rows, in directory order (the dialog sorts them).
 */
export async function listSessionFiles(cwd: string): Promise<readonly SessionHeaderLike[]> {
  const out: SessionHeaderLike[] = []
  try {
    for (const entry of readdirSync(join(dshHomePath('sessions'), projectKey(cwd)), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = resolveSessionLogPath(join(dshHomePath('sessions'), projectKey(cwd), entry.name))
      if (path === undefined) continue
      try {
        const header = await new SessionLogReader(path).header()
        const id = typeof header?.id === 'string' && header.id !== '' ? header.id : entry.name
        out.push({
          id: id as SessionId,
          ...typeof header?.cwd === 'string' ? { cwd: header.cwd } : {},
          ...typeof header?.createdAt === 'number' ? { createdAt: header.createdAt } : {},
        })
      } catch { /* unreadable session: leave it out of the list */ }
    }
  } catch { /* no project directory yet: an empty list */ }
  return out
}
