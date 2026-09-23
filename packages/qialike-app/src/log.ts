/**
 * qialike error/crash log. Writes timestamped lines to `~/.dsh/qialike.log`
 * (appended, rotated at 1MB) and mirrors them to stderr so they are visible
 * when the TUI is launched from a shell. Everything is best-effort: a logging
 * failure never affects the app.
 *
 * Captured via the callers: uncaught exceptions, unhandled rejections, the
 * session `start()` failure, and (via a `console.error` wrapper) React/Ink
 * warnings such as "Maximum update depth exceeded".
 *
 * @module @qialike/qialike-app/log
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { homeFilePath } from './legacy-names.ts'

/** Resolved per use, not at import: the legacy-name migration may rename
 *  `dsh-tui.log` to this name after this module is evaluated. */
function logPath(): string {
  return homeFilePath('qialike.log')
}
const MAX_BYTES = 1_048_576 // 1 MB; then rotate to `.1` (one previous run)

/**
 * Terminal control sequences — CSI (cursor show/hide `\x1b[?25l`, colors,
 * moves), OSC (`\x1b]...\x1b\\`), and single-character escapes. They are
 * terminal traffic, not errors; the mirror strips them so a pure-control
 * stderr chunk (e.g. cli-cursor's `\x1b[?25l` cursor hide, written to stderr
 * by default) is dropped entirely, and any real message that embeds codes
 * logs cleanly.
 */
const CONTROL_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[0-9@-Z\\^_`])/g

/** Clean one raw stderr chunk for the log: strip terminal control sequences
 *  and trailing whitespace. Returns `null` when nothing meaningful remains
 *  (a pure-escape chunk, whitespace, or an empty write) so callers can skip
 *  logging it. */
export function sanitizeStderrChunk(chunk: string): string | null {
  const clean = chunk.replace(CONTROL_RE, '').replace(/\s+$/, '')
  return clean.length > 0 ? clean : null
}

/** Ensure the home dir exists, log the process start, and mirror stderr errors
 *  into the log (so thrown errors that bypass console.error — e.g. Ink's
 *  "<Box> can't be nested inside <Text>" — are captured too). */
export function initErrorLog(): void {
  try {
    mkdirSync(dirname(logPath()), { recursive: true })
    // FILE ONLY: this breadcrumb used to mirror to stderr, which is the same tty
    // the alternate screen is on — so every launch printed a bare
    // `[<iso>] qialike started` line over the splash and had it wiped by Ink's
    // first frame, i.e. a visible flash of raw log text before the hero.
    writeLine('qialike started', false)
  } catch {
    // Logging is best-effort; never throw from here.
  }
  // Record the exit so a clean run is distinguishable from a crash: any error
  // lines precede `exited (code N)` (SIGKILL / power loss leave no record by
  // nature). `process.exitCode` carries the code during 'exit'.
  process.on('exit', () => {
    writeLine(`qialike exited (code ${process.exitCode ?? 0})`)
  })
  try {
    const orig = process.stderr.write.bind(process.stderr) as (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean
    process.stderr.write = ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
      try {
        const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
        // Skip our own log echoes ([ISO] prefix) and qialike debug lines, and
        // drop pure terminal-control chunks (cursor escapes) that libraries
        // write to stderr.
        if (s && !s.startsWith('[20') && !s.includes('[qialike]')) {
          const clean = sanitizeStderrChunk(s)
          if (clean !== null) {
            // FILE ONLY: the point of this wrapper is to CAPTURE stderr into the
            // log; writing it back to stderr echoes it onto the TUI (the
            // `[charwidth] …` warning landed on the screen at every startup).
            writeLine(`[stderr] ${clean}`, false)
          }
        } else {
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
  logErrorImpl(tag, error, true)
}

/**
 * Log an error to the file only — no stderr mirror. Use for routine stream or
 * request failures the UI already surfaces (e.g. the status line): the mirror
 * scribbles the line onto the terminal at the input row, which reads as the
 * TUI "showing an error in the input box".
 */
export function logErrorFileOnly(tag: string, error: unknown): void {
  logErrorImpl(tag, error, false)
}

function logErrorImpl(tag: string, error: unknown, mirror: boolean): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  writeLine(`[${tag}] ${detail}`, mirror)
}

/** Log a captured console.error message (e.g. a React warning). */
export function logConsoleError(text: string): void {
  writeLine(`[console.error] ${text}`)
}

function writeLine(line: string, mirror = true): void {
  const stamp = new Date().toISOString()
  try {
    rotateIfNeeded()
    appendFileSync(logPath(), `[${stamp}] ${line}\n`)
  } catch {
    // Ignore (e.g. unwritable home).
  }
  if (!mirror) return
  try {
    process.stderr.write(`[${stamp}] ${line}\n`)
  } catch {
    // Ignore.
  }
}

function rotateIfNeeded(): void {
  try {
    if (statSync(logPath()).size > MAX_BYTES) {
      renameSync(logPath(), `${logPath()}.1`)
    }
  } catch {
    // No file yet (first write) or stat failed -> nothing to rotate.
  }
}
