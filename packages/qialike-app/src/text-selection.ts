/**
 * Mouse-selection copying, shared by every surface that supports it: the
 * conversation transcript (composer/status/sidebar included) and — since a
 * dialog used to swallow the press with no anchor at all — the open dialog
 * (`question` / `models` / `theme` / `sessions` / `approval` / command palette /
 * plan review / file reference).
 *
 * The text is taken from the FRAME BUFFER, never from a model: the build's Ink
 * patch (`apps/tui-bin/build.mjs`, `patchInkFrameController`) bakes the inverse
 * highlight into the composited cell grid and writes the same walked text to
 * `__dshFrameController.copiedText`. That is the only source that is correct
 * while an overlay is up — a dialog is painted OVER the transcript, so any
 * model-side reconstruction (`selectionText`, which walks the transcript rows)
 * would silently copy the text BEHIND the dialog.
 *
 * Callers therefore treat an empty frame text as "nothing copyable" and never
 * fall back to a model while a dialog is open.
 */
import { spawnSync } from 'node:child_process'
import type { Store } from './index.tsx'
import { dialogTextBand } from './list-geometry.ts'

/** Copy text to the system clipboard — `pbcopy` / `clip` / `wl-copy` / `xclip`
 *  / `xsel`, falling back to OSC 52.
 *
 *  macOS Terminal.app has no OSC 52, so `pbcopy` is the only reliable path; use
 *  the ABSOLUTE path and BLOCK until it has consumed stdin (spawnSync), so a
 *  Node single-executable binary is guaranteed to deliver the bytes — an async
 *  `spawn` + `stdin.end` race under a busy event loop can leave the child
 *  reading EOF before the text is flushed, silently setting nothing. */
export function writeClipboard(text: string): void {
  if (process.platform === 'darwin') {
    for (const cmd of ['/usr/bin/pbcopy', 'pbcopy']) {
      const res = spawnSync(cmd, [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
      if (!res.error && res.status === 0) return
    }
    process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x1b\\`)
    return
  }
  // Linux: no single clipboard tool is guaranteed (X11 vs Wayland). Try the
  // Wayland tool and the two X11 tools in order (wl-copy / xclip / xsel) — so
  // whichever is installed and matches the session sets the system clipboard.
  // xclip/xsel default to the PRIMARY selection, so the -selection clipboard /
  // --clipboard flag is required for Ctrl+V paste.
  if (process.platform === 'win32') {
    const r = spawnSync('clip', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    if (!r.error && r.status === 0) return
  } else if (process.platform === 'linux') {
    for (const [cmd, args] of [
      ['wl-copy', []],
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ] as const) {
      const r = spawnSync(cmd, [...args], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
      if (!r.error && r.status === 0) return
    }
  }
  // No clipboard command succeeded; send OSC 52 (iTerm2 / Kitty / Alacritty /
  // Windows Terminal).
  process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x1b\\`)
}

/** The frame controller the build patches into Ink (`build.mjs`). */
type FrameController = { copiedText?: string }

/** The walked text of the last painted frame's selection, or '' when this
 *  build has no frame controller / nothing was highlighted. */
export function frameCopiedText(): string {
  const fc = (globalThis as unknown as { __dshFrameController?: FrameController }).__dshFrameController
  return fc?.copiedText ?? ''
}

/** Whether a mouse selection spans a real drag (the same Manhattan threshold
 *  the frame controller uses to decide that a highlight is warranted). */
export function isDragSelection(store: Store): boolean {
  const sel = store.selection
  if (sel === null) return false
  return Math.abs(sel.aRow - sel.cRow) + Math.abs(sel.aCol - sel.cCol) > 2
}

/**
 * Copy the active mouse selection to the clipboard and flash the usual status
 * line. Returns the copied text ('' when there was nothing to copy).
 *
 * @param store - the TUI store (the selection lives on it).
 * @param fallback - model-side reconstruction, used ONLY while no dialog owns the
 *   pointer (the conversation surface, whose text is not behind anything). While
 *   a dialog is up an empty frame text means the drag never covered dialog text,
 *   and the fallback is IGNORED here rather than at each call site — otherwise a
 *   dialog would copy the transcript hidden behind it.
 */
export function copySelection(store: Store, fallback?: () => string): string {
  if (!isDragSelection(store)) return ''
  const frame = frameCopiedText()
  const useFallback = fallback !== undefined && !dialogOwnsSelection()
  const text = (frame !== '' ? frame : (useFallback ? fallback() : '')).trim()
  if (text === '') return ''
  writeClipboard(text)
  const long = text.length > 40
  const preview = long ? text.slice(0, 40) + '…' : text
  // Show the feedback in the bottom STATUS BAR (transient, not a transcript
  // item): a `status` transcript row would re-layout / follow-tail auto-scroll
  // the transcript and slide the screen-coordinate highlight onto the next
  // block below (the user saw this as the highlight jumping to下文). For a
  // large selection the status shows the char count, so the FULL copy (which
  // goes to the clipboard, never truncated) can be trusted.
  store.flashStatus(long ? `Copied: ${preview} (${text.length} chars)` : `Copied: ${preview}`)
  return text
}

/** Whether the dialog copy path applies right now (a dialog publishes a text
 *  area). Exposed so the conversation panel can pick its copy source once. */
export function dialogOwnsSelection(): boolean {
  return dialogTextBand() !== null
}
