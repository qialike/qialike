/**
 * Per-session last-activity timestamps (`~/.dsh/dsh-tui-activity.json`).
 *
 * The harness session header only carries `createdAt`, so "most recent" is
 * otherwise creation time. The TUI records the last time a session was used
 * (switched to, resumed, or messaged) so the /sessions list and the launch
 * auto-resume can prefer *recently used* sessions. Best-effort persistence —
 * a missing or unparsable file degrades to creation-time ordering.
 *
 * @module @yourname/dsh-tui-app/session-activity
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** In-memory activity map; disk loaded lazily. */
const memory = new Map<string, number>()
let diskLoaded = false

/** Absolute path of the activity file. */
function activityPath(): string {
  return dshHomePath('dsh-tui-activity.json')
}

/** Load the activity file once; a missing/unparsable file yields an empty map. */
function ensureLoaded(): void {
  if (diskLoaded) return
  diskLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(activityPath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) memory.set(id, value)
    }
  } catch {
    // Missing or malformed file -> cold start.
  }
}

/** Persist the activity map (best-effort; an unwritable home must not crash). */
function persist(): void {
  const path = activityPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(Object.fromEntries(memory), null, 2) + '\n')
  } catch {
    // best-effort
  }
}

/**
 * Mark a session as active now (switched to, resumed, or messaged). Persisted
 * across restarts so "recently used" ordering survives relaunch.
 * @param id - the session id.
 */
export function touchSession(id: SessionId): void {
  ensureLoaded()
  memory.set(String(id), Date.now())
  persist()
}

/**
 * The last-activity timestamp of a session, or `undefined` when never touched
 * (fall back to creation-time ordering).
 * @param id - the session id.
 */
export function lastActivity(id: SessionId): number | undefined {
  ensureLoaded()
  return memory.get(String(id))
}

/**
 * Forget a session's activity record (called after the session is deleted).
 * @param id - the deleted session id.
 */
export function forgetActivity(id: SessionId): void {
  ensureLoaded()
  if (memory.delete(String(id))) persist()
}
