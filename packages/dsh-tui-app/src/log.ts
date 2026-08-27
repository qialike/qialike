/**
 * dsh-tui error/crash log. Writes timestamped lines to `~/.dsh/dsh-tui.log`
 * (appended, rotated at 1MB) and mirrors them to stderr so they are visible
 * when the TUI is launched from a shell. Everything is best-effort: a logging
 * failure never affects the app.
 *
 * Captured via the callers: uncaught exceptions, unhandled rejections, the
 * session `start()` failure, and (via a `console.error` wrapper) React/Ink
 * warnings such as "Maximum update depth exceeded".
 *
 * @module @yourname/dsh-tui-app/log
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const LOG_PATH = dshHomePath('dsh-tui.log')
const MAX_BYTES = 1_048_576 // 1 MB; then rotate to `.1` (one previous run)

/** Ensure the home dir exists, log the process start, and mirror stderr errors
 *  into the log (so thrown errors that bypass console.error — e.g. Ink's
 *  "<Box> can't be nested inside <Text>" — are captured too). */
export function initErrorLog(): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    writeLine('dsh-tui started')
  } catch {
    // Logging is best-effort; never throw from here.
  }
  try {
    const orig = process.stderr.write.bind(process.stderr) as (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean
    process.stderr.write = ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
      try {
        const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
        // Skip our own log echoes ([ISO] prefix) and dsh-tui debug lines.
        if (s && !s.startsWith('[20') && !s.includes('[dsh-tui]')) {
          writeLine(`[stderr] ${s.replace(/\s+$/, '')}`)
        }
      } catch {
        // ignore
      }
      return orig(chunk, encoding, cb)
    }) as typeof orig
  } catch {
    // best-effort
  }
}

/** Log an uncaught error/tag (the error text + its stack when available). */
export function logError(tag: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  writeLine(`[${tag}] ${detail}`)
}

/** Log a captured console.error message (e.g. a React warning). */
export function logConsoleError(text: string): void {
  writeLine(`[console.error] ${text}`)
}

function writeLine(line: string): void {
  const stamp = new Date().toISOString()
  try {
    rotateIfNeeded()
    appendFileSync(LOG_PATH, `[${stamp}] ${line}\n`)
  } catch {
    // Ignore (e.g. unwritable home).
  }
  try {
    process.stderr.write(`[${stamp}] ${line}\n`)
  } catch {
    // Ignore.
  }
}

function rotateIfNeeded(): void {
  try {
    if (statSync(LOG_PATH).size > MAX_BYTES) {
      renameSync(LOG_PATH, `${LOG_PATH}.1`)
    }
  } catch {
    // No file yet (first write) or stat failed -> nothing to rotate.
  }
}
