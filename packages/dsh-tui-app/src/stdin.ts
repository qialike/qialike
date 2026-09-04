/**
 * Raw-stdin byte decoder for the TUI. Turns the raw terminal stream into
 * structured key/mouse events, dispatching to the app's `handleKey`.
 *
 * Robustness contract:
 *  - Known sequences (arrows, Home/End, PgUp/PgDn, SGR mouse, Alt+Enter, SS3
 *    Home/End) are decoded precisely.
 *  - Any **unrecognized** escape sequence is consumed in full and discarded, so
 *    stray bytes (cursor-position queries, function keys, Shift+arrow, color
 *    SGR, malformed mouse reports) can never leak into the composer as typed
 *    text.
 *  - A lone `ESC` byte is never resolved here: it could be the Esc key or the
 *    start of a sequence. The caller arms a short timer and calls
 *    {@link StdinDecoder.flushEsc} when nothing followed it.
 *
 * @module @yourname/dsh-tui-app/stdin
 */

/** One decoded key event. */
export interface RawKey {
  char?: string
  return?: boolean
  escape?: boolean
  ctrl?: boolean
  /** Alt (meta) modifier, e.g. Alt+T = ESC + 't'. */
  meta?: boolean
  tab?: boolean
  backspace?: boolean
  delete?: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  pageUp?: boolean
  pageDown?: boolean
  home?: boolean
  end?: boolean
  altEnter?: boolean
  wheelUp?: boolean
  wheelDown?: boolean
  mousePress?: { row: number; col: number }
  mouseDrag?: { row: number; col: number }
  mouseRelease?: { row: number; col: number }
  /** Bracketed-paste text (`ESC[200~ … ESC[201~`), assembled as one event. */
  paste?: string
}

/** CSI final bytes terminate an escape sequence's parameter string. */
function isCsiFinal(b: number): boolean {
  return b >= 0x40 && b <= 0x7e
}

/** UTF-8 continuation range check. */
function utf8Len(b: number): number {
  return b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
}

/** Bracketed-paste delimiters: `ESC[200~` opens, `ESC[201~` closes. */
const PASTE_START = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]

/**
 * A stateful raw-stdin decoder. Feed it chunks with {@link push}; complete
 * sequences become events, incomplete ones stay buffered for the next chunk,
 * and unknown sequences are swallowed.
 */
export class StdinDecoder {
  private buf: number[] = []
  /** Accumulated bracketed-paste bytes while a `ESC[200~ … ESC[201~` region is open. */
  private paste: number[] | null = null

  /** True when a lone `ESC` is awaiting disambiguation (nothing after it yet). */
  get pendingEscape(): boolean {
    return this.buf.length === 1 && this.buf[0] === 0x1b
  }

  /** Append a chunk and decode every complete event available. */
  push(chunk: Buffer | Uint8Array | string): RawKey[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    for (const b of bytes) this.buf.push(b)
    return this.parse()
  }

  /** Resolve a lone `ESC` as the Esc key (called after the caller's short timeout). */
  flushEsc(): RawKey[] {
    if (!this.pendingEscape) return []
    this.buf.shift()
    return [{ escape: true }]
  }

  private parse(): RawKey[] {
    const out: RawKey[] = []
    while (this.buf.length > 0) {
      // Bracketed paste in progress: collect bytes until the ESC[201~ terminator.
      if (this.paste !== null) {
        const term = PASTE_END
        if (this.buf.length >= term.length && this.buf.slice(0, term.length).every((v, i) => v === term[i])) {
          this.buf.splice(0, term.length)
          const text = Buffer.from(this.paste).toString('utf8')
          this.paste = null
          out.push({ paste: text })
          continue
        }
        this.paste.push(this.buf.shift()!)
        continue
      }
      const b = this.buf[0]!
      // Paste start: ESC[200~ (bracketed paste) — before the generic escape handler.
      if (b === 0x1b && this.buf.length >= PASTE_START.length
        && this.buf.slice(0, PASTE_START.length).every((v, i) => v === PASTE_START[i])) {
        this.buf.splice(0, PASTE_START.length)
        this.paste = []
        continue
      }
      if (b === 0x1b) {
        if (this.buf.length === 1) break // lone ESC pending; caller arms the timer
        const n = this.escapeEvent(out)
        if (n === 0) break // incomplete sequence: wait for more bytes
        continue
      }
      if (b === 0x0d) { this.buf.shift(); out.push({ char: '\r', return: true }); continue }
      if (b === 0x0a) { this.buf.shift(); out.push({ char: '\n' }); continue }
      if (b === 0x09) { this.buf.shift(); out.push({ tab: true }); continue }
      if (b === 0x08 || b === 0x7f) { this.buf.shift(); out.push({ backspace: true }); continue }
      if (b === 0x15) { this.buf.shift(); out.push({ char: 'u', ctrl: true }); continue }
      if (b === 0x10) { this.buf.shift(); out.push({ char: 'p', ctrl: true }); continue }
      if (b === 0x04) { this.buf.shift(); out.push({ char: 'd', ctrl: true }); continue }
      if (b === 0x12) { this.buf.shift(); out.push({ char: 'r', ctrl: true }); continue }
      if (b === 0x06) { this.buf.shift(); out.push({ char: 'f', ctrl: true }); continue }
      if (b === 0x03) { this.buf.shift(); out.push({ char: 'c', ctrl: true }); continue }
      if (b === 0x14) { this.buf.shift(); out.push({ char: 't', ctrl: true }); continue } // Ctrl+T
      if (b === 0x19) { this.buf.shift(); out.push({ char: 'y', ctrl: true }); continue } // Ctrl+Y: copy the active selection
      if (b >= 0x01 && b <= 0x1a) { this.buf.shift(); continue } // unhandled control char: ignore
      const len = utf8Len(b)
      if (this.buf.length < len) break
      const bytes = this.buf.splice(0, len)
      out.push({ char: Buffer.from(bytes).toString('utf8') })
    }
    return out
  }

  /**
   * Consume an escape sequence starting at `buf[0]`. Returns the number of
   * bytes consumed, or 0 when the sequence is incomplete. Recognized sequences
   * emit events; unrecognized ones are discarded whole.
   */
  private escapeEvent(out: RawKey[]): number {
    const buf = this.buf
    if (buf[1] === 0x0d) { // Alt+Enter
      buf.splice(0, 2)
      out.push({ altEnter: true })
      return 2
    }
    if (buf[1] === 0x5b) { // CSI
      if (buf.length < 3) return 0
      const finalIdx = this.csiFinalIndex()
      if (finalIdx === -1) return 0 // incomplete: no final byte yet
      const seq = buf.slice(1, finalIdx + 1) // '[', params..., final byte
      const final = buf[finalIdx]!
      buf.splice(0, finalIdx + 1)
      this.dispatchCsi(out, seq, final)
      return finalIdx + 1
    }
    if (buf[1] === 0x4f) { // SS3
      if (buf.length < 3) return 0
      const final = buf[2]!
      buf.splice(0, 3)
      if (final === 0x48) out.push({ home: true }) // \x1bOH
      else if (final === 0x46) out.push({ end: true }) // \x1bOF
      // other SS3 (F1-F4 = P/Q/R/S, etc.): discarded
      return 3
    }
    if (buf[1] === 0x74) { // Alt+T (the Ctrl+T fallback for terminals that swallow Ctrl+T)
      buf.splice(0, 2)
      out.push({ char: 't', meta: true })
      return 2
    }
    if (buf[1] === 0x64) { // Alt+D (the Ctrl+D fallback for hiding a provider)
      buf.splice(0, 2)
      out.push({ char: 'd', meta: true })
      return 2
    }
    // Unknown ESC prefix. If the next byte is itself ESC, consume only this ESC
    // and leave the next as a lone pending ESC (two Esc presses = double-Esc),
    // otherwise consume ESC + one byte and discard it.
    if (buf[1] === 0x1b) {
      buf.shift()
      out.push({ escape: true })
      return 1
    }
    buf.splice(0, 2)
    out.push({ escape: true })
    return 2
  }

  /** Index of the CSI final byte (0x40-0x7e) that terminates the sequence, or -1. */
  private csiFinalIndex(): number {
    const buf = this.buf
    for (let i = 2; i < buf.length; i++) {
      if (isCsiFinal(buf[i]!)) return i
    }
    return -1
  }

  private dispatchCsi(out: RawKey[], seq: number[], final: number): void {
    // seq = ['[', ...params, final]; final is the last byte.
    const params = seq.slice(1, -1)
    const p0 = params[0] ?? 0
    if (final === 0x4d || final === 0x6d) { // 'M' press/drag, 'm' release
      if (p0 === 0x3c) { // SGR mouse: '<' then "button;col;row"
        const fields = params.slice(1).reduce<number[][]>((acc, b) => {
          if (b === 0x3b) acc.push([])
          else acc[acc.length - 1]!.push(b)
          return acc
        }, [[]]).map((f) => Number(String.fromCharCode(...f)))
        this.dispatchSgrMouse(out, fields, final === 0x6d)
      }
      return
    }
    switch (final) {
      case 0x41: if (params.length === 0) out.push({ upArrow: true }); return
      case 0x42: if (params.length === 0) out.push({ downArrow: true }); return
      case 0x43: if (params.length === 0) out.push({ rightArrow: true }); return
      case 0x44: if (params.length === 0) out.push({ leftArrow: true }); return
      case 0x48: if (params.length === 0) out.push({ home: true }); return
      case 0x46: if (params.length === 0) out.push({ end: true }); return
      default: break
    }
    // PgUp/PgDn come as "\x1b[5~"/"\x1b[6~": params are ['5','~'] etc. with final '~'.
    if (final === 0x7e && p0 === 0x35) { out.push({ pageUp: true }); return }
    if (final === 0x7e && p0 === 0x36) { out.push({ pageDown: true }); return }
    if (final === 0x7e && p0 === 0x33) { out.push({ delete: true }); return } // Delete: "\x1b[3~"
    // Everything else (cursor-position, color SGR, modified arrows, etc.) is discarded.
  }

  private dispatchSgrMouse(out: RawKey[], fields: number[], isRelease: boolean): void {
    if (fields.length < 3) return
    const raw = fields[0] ?? 0
    const col = fields[1] ?? 0
    const row = fields[2] ?? 0
    if (!Number.isFinite(col) || !Number.isFinite(row)) return
    if (isRelease) { out.push({ mouseRelease: { row, col } }); return }
    if (raw === 0) out.push({ mousePress: { row, col } })
    else if (raw === 32) out.push({ mouseDrag: { row, col } }) // left + motion (drag)
    else if (raw === 3) out.push({ mouseRelease: { row, col } }) // X10-style release button
    else if (raw === 64) out.push({ wheelUp: true })
    else if (raw === 65) out.push({ wheelDown: true })
    // other buttons / modifier combos (Shift/alt/ctrl) are ignored so the
    // terminal can perform its own selection.
  }
}
