/**
 * Terminal-output text sanitization.
 *
 * The transcript renders model / tool / error text straight into the Ink
 * framebuffer, and the frame writer emits lines to stdout verbatim. Ink's
 * ansi-tokenize re-emits control bytes it does not recognise as styles, so a
 * literal ESC (or C1 byte) inside content would reach the real terminal as a
 * live control sequence — screen clears, cursor moves, title OSC, OSC52
 * clipboard writes (see qialike-security.md, 终端转义注入).
 *
 * Every untrusted text surface must pass through `stripTerminalControls`
 * before it enters a <Text>/<MarkdownText> boundary. Allowed: TAB, LF, CR and
 * every other code unit ≥ 0x20 (except DEL), including wide/astral text.
 * Removed: the remaining C0 controls, DEL, and the C1 range (U+0080-U+009F,
 * which carries CSI 0x9B and friends). Style bytes that Ink itself emits are
 * added AFTER this function runs, so legitimate colouring is unaffected.
 */

/** Remove terminal control bytes from untrusted display text.
 *  Keep \t \n \r; drop other C0 (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F), DEL 0x7F,
 *  and C1 (0x80-0x9F). No valid text glyph lives in the removed ranges, and
 *  UTF-16 surrogate halves stay untouched (0xD800-0xDFFF > 0x9F). */
export function stripTerminalControls(text: string): string {
  let out = ''
  let last = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const keep =
      c === 0x09 || c === 0x0a || c === 0x0d || // \t \n \r
      (c >= 0x20 && c !== 0x7f && (c < 0x80 || c > 0x9f))
    if (keep) continue
    // Drop this code unit: flush the kept run before it, then skip it.
    out += text.slice(last, i)
    last = i + 1
  }
  if (last === 0) return text
  out += text.slice(last)
  return out
}

/**
 * Complete ANSI escape sequences inside captured/machine text.
 *
 * Anchored on a REAL `ESC` / C1 byte, never on the parameters alone, so ordinary
 * text is untouched: the literal characters some text uses to TALK about escapes
 * (`\u001b[31m`, `\x1b[31m`) and bracket usage like `array[0m]` contain no
 * control byte and are left exactly as they are. Only the shapes a terminal would
 * ACT on are matched: CSI (incl. SGR, private modes like `ESC[?1049h`), OSC
 * (titles, OSC 8 hyperlinks, OSC 52 clipboard writes) in both the 7-bit and 8-bit
 * form, charset designation and the two-byte escapes.
 */
const ANSI_SEQUENCE = new RegExp([
  String.raw`\x1b\][^\u0007\x1b]*(?:\u0007|\x1b\\)`,   // OSC … BEL | ST
  String.raw`\u009d[^\u0007\x1b]*(?:\u0007|\x1b\\)`,    // 8-bit OSC (C1)
  String.raw`\x1b\[[0-?]*[ -/]*[@-~]`,                       // CSI (params, intermediates, final)
  String.raw`\u009b[0-?]*[ -/]*[@-~]`,                        // 8-bit CSI (C1)
  String.raw`\x1b[()][0-9A-Za-z]`,                            // charset designation
  String.raw`\x1b[@-Z\\-_]`,                                // two-byte escape
].join('|'), 'gu')

/** True when the text carries anything a sequence pass could act on. */
function hasEscapeStart(text: string): boolean {
  return text.includes('\x1b') || text.includes('\u009b') || text.includes('\u009d')
}

/**
 * Drop COMPLETE escape sequences, keeping the text around them.
 *
 * Use this for text a MACHINE produced — captured command output, a terminal
 * paste — where an escape is decoration: `git diff --color=always` keeps 16.5% of
 * its width as `[1m`/`[0m` litter under a byte-only strip (measured), and a pasted
 * `ESC[?1049h` leaves `[?1049h` in the draft. It is deliberately NOT used for
 * model/agent-authored text: an escape byte inside a code block or prose is
 * content there, and deleting it silently would lose information (the byte-level
 * strip keeps the parameters visible instead).
 *
 * This is an ADDITION to {@link stripTerminalControls}, never a replacement: a
 * truncated or unterminated sequence (`ESC[31` at the end of a paste) does not
 * match and is then handled by the byte floor. Call {@link sanitizeTerminalText}
 * to get both.
 */
export function stripAnsiSequences(text: string): string {
  if (!hasEscapeStart(text)) return text
  return text.replace(ANSI_SEQUENCE, '')
}

/**
 * The sanitizer for MACHINE-produced text: whole sequences first, then the
 * control-byte floor. The order matters — the floor is what makes the guarantee
 * ("no control byte reaches the frame") unconditional, so it must stay last and
 * must never be dropped in favour of the sequence pass.
 */
export function sanitizeTerminalText(text: string): string {
  return stripTerminalControls(stripAnsiSequences(text))
}
