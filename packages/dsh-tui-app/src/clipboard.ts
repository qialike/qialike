/**
 * Clipboard READ + the one paste path every dialog input shares.
 *
 * The panels have always been able to COPY (`writeClipboard`: pbcopy / clip /
 * wl-copy / xclip / xsel + an OSC 52 fallback). Reading is the missing mirror,
 * and it is what makes a right-click paste possible at all: while the TUI has
 * mouse tracking on (`?1003h`), the terminal forwards the right-click to us and
 * does NOT run its own paste — so "right-click = paste" must be done here.
 *
 * Two entry points feed the same insertion:
 *   - a bracketed paste (`k.paste`): the terminal already read the clipboard and
 *     sent the text, so nothing is spawned;
 *   - a SHIFT+right-click (`k.mouseRightPress` + `k.shift`) inside a dialog: read
 *     the clipboard with the platform tools and insert that. (Plain right-click is
 *     deliberately inert: too easy to hit by accident.)
 *
 * Everything that lands in an input passes {@link pastedText}: control bytes and
 * escape sequences are stripped (`stripTerminalControls` — clipboard content is
 * attacker-controllable), single-line fields get their newlines folded away, and
 * the length is capped. The dialog never closes on either gesture.
 *
 * @module @yourname/dsh-tui-app/clipboard
 */
import { spawnSync } from 'node:child_process'
import { stripTerminalControls } from './terminal-safe.ts'

/** Default cap for one paste into a dialog input (characters). */
export const PASTE_MAX_CHARS = 4096

/** One clipboard-read attempt. */
export interface ClipboardReadResult {
  ok: boolean
  text: string
  /** Why it failed, for the status flash (empty when `ok`). */
  reason: string
}

/** Commands tried, in order, to read the system clipboard on `platform`. */
export function clipboardReadCommands(platform: string = process.platform): { cmd: string; args: string[] }[] {
  if (platform === 'darwin') return [{ cmd: 'pbpaste', args: [] }]
  if (platform === 'win32') {
    return [{ cmd: 'powershell.exe', args: ['-NoProfile', '-Command', 'Get-Clipboard -Raw'] }]
  }
  return [
    // Wayland first (a Wayland session may still have xclip installed but it
    // would read a different, empty selection), then X11.
    { cmd: 'wl-paste', args: ['--no-newline'] },
    { cmd: 'xclip', args: ['-o', '-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--output'] },
  ]
}

/**
 * Read the system clipboard.
 * @param platform - overridable for tests.
 * @param run - the spawner (injected in tests).
 * @returns the text, or a reason when no clipboard tool could provide one.
 */
export function readClipboardText(
  platform: string = process.platform,
  run: typeof spawnSync = spawnSync,
): ClipboardReadResult {
  let reason = 'no clipboard tool found (install wl-clipboard, xclip or xsel)'
  for (const { cmd, args } of clipboardReadCommands(platform)) {
    try {
      const r = run(cmd, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 })
      if (r.error === undefined && r.status === 0 && typeof r.stdout === 'string') {
        return { ok: true, text: r.stdout, reason: '' }
      }
      reason = r.error !== undefined ? `${cmd}: ${r.error.message}` : `${cmd}: exit ${String(r.status)}`
    } catch (error) {
      reason = `${cmd}: ${(error as Error).message}`
    }
  }
  return { ok: false, text: '', reason }
}

/**
 * Sanitise one paste for an input.
 * @param raw - clipboard text or a bracketed-paste payload.
 * @param singleLine - fold `\r`/`\n`/tabs into single spaces and trim (API keys,
 *   filters, file names); keep newlines otherwise (the question "Other" editor).
 * @param maxChars - hard cap.
 * @returns the text to insert (possibly empty).
 */
export function pastedText(raw: string, singleLine = false, maxChars = PASTE_MAX_CHARS): string {
  let text = stripTerminalControls(raw)
  if (singleLine) text = text.replace(/[\r\n\t]+/gu, ' ').replace(/ {2,}/gu, ' ').trim()
  else text = text.replace(/\r\n?/gu, '\n')
  return text.slice(0, Math.max(0, maxChars))
}

/** What the paste path needs from the host (a Store satisfies it). */
export interface PasteHost {
  /** Optional so a partial/fake host can never crash a dialog on a paste. */
  flashStatus?(text: string, ms?: number): void
}

/** The key fields both gestures arrive on. */
export interface PasteKey {
  paste?: string
  mouseRightPress?: { row: number; col: number }
  /** Shift held with the right-click: the paste gesture (a plain right-click is
   *  inert — too easy to trigger by accident — but still never closes a dialog). */
  shift?: boolean
}

/** Options for {@link handleDialogPaste}. */
export interface DialogPasteOptions {
  singleLine?: boolean
  maxChars?: number
  /** Clipboard reader (injected in tests); defaults to {@link readClipboardText}. */
  read?: () => ClipboardReadResult
}

/**
 * The ONE place a dialog input accepts a paste: a bracketed paste inserts the
 * text it already carries, a SHIFT+right-click reads the clipboard and inserts
 * that — and neither ever closes the dialog (the caller returns `true`). A plain
 * right-click is not a paste (returns false: the caller consumes it inertly).
 * @param k - the key being handled.
 * @param host - status-flash sink.
 * @param type - the dialog's own "append text" action (Store method).
 * @param options - single-line/cap/reader overrides.
 * @returns true when the event was a paste (and was consumed).
 */
export function handleDialogPaste(
  k: PasteKey,
  host: PasteHost,
  type: (text: string) => void,
  options: DialogPasteOptions = {},
): boolean {
  const maxChars = options.maxChars ?? PASTE_MAX_CHARS
  if (typeof k.paste === 'string') {
    const text = pastedText(k.paste, options.singleLine, maxChars)
    if (text !== '') type(text)
    return true
  }
  // A PLAIN right-click does not paste (the user's call: it is far too easy to
  // hit by accident next to a half-typed key); only Shift+right-click does. It is
  // still never an exit — the caller consumes it and the dialog stays open.
  if (k.mouseRightPress === undefined || k.shift !== true) return false
  const read = options.read ?? ((): ClipboardReadResult => readClipboardText())
  const result = read()
  if (!result.ok) {
    host.flashStatus?.(`clipboard unavailable — ${result.reason}`, 6000)
    return true
  }
  const text = pastedText(result.text, options.singleLine, maxChars)
  if (text === '') {
    host.flashStatus?.('clipboard is empty', 2500)
    return true
  }
  type(text)
  host.flashStatus?.(`pasted ${text.length} char${text.length === 1 ? '' : 's'}`, 2500)
  return true
}
