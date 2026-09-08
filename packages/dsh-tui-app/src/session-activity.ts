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

/**
 * Mutable module state.
 *
 * IMPORTANT: the SEA build compiles each panel entry (index.tsx, the sessions
 * panel, …) as its OWN esbuild bundle, so top-level state here would be
 * duplicated per bundle: a `touchSession` write through the runtime entry's
 * copy would never be seen by the /sessions list's copy (which keeps its own
 * empty map after one disk load) until a restart re-read the disk file. All
 * mutable state therefore lives on ONE object anchored to the process global —
 * every bundle copy runs in the same realm — so every consumer reads and
 * writes the same activity map.
 */
interface ActivityState {
  /** In-memory activity map; disk loaded lazily. */
  map: Map<string, number>
  diskLoaded: boolean
}

const STATE_KEY = Symbol.for('dsh-tui.session-activity.state')
const shared: ActivityState = (() => {
  const holder = globalThis as unknown as Record<symbol, ActivityState | undefined>
  let state = holder[STATE_KEY]
  if (state === undefined) {
    state = { map: new Map<string, number>(), diskLoaded: false }
    holder[STATE_KEY] = state
  }
  return state
})()

/** Absolute path of the activity file. */
function activityPath(): string {
  return dshHomePath('dsh-tui-activity.json')
}

/** Load the activity file once; a missing/unparsable file yields an empty map. */
function ensureLoaded(): void {
  if (shared.diskLoaded) return
  shared.diskLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(activityPath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) shared.map.set(id, value)
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
    writeFileSync(path, JSON.stringify(Object.fromEntries(shared.map), null, 2) + '\n')
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
  shared.map.set(String(id), Date.now())
  persist()
}

/**
 * The last-activity timestamp of a session, or `undefined` when never touched
 * (fall back to creation-time ordering).
 * @param id - the session id.
 */
export function lastActivity(id: SessionId): number | undefined {
  ensureLoaded()
  return shared.map.get(String(id))
}

/**
 * Forget a session's activity record (called after the session is deleted).
 * @param id - the deleted session id.
 */
export function forgetActivity(id: SessionId): void {
  ensureLoaded()
  if (shared.map.delete(String(id))) persist()
}
