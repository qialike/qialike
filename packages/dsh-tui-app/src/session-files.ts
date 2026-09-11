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

import { readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'

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
