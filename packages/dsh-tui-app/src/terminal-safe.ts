/**
 * Terminal-output text sanitization.
 *
 * The transcript renders model / tool / error text straight into the Ink
 * framebuffer, and the frame writer emits lines to stdout verbatim. Ink's
 * ansi-tokenize re-emits control bytes it does not recognise as styles, so a
 * literal ESC (or C1 byte) inside content would reach the real terminal as a
 * live control sequence — screen clears, cursor moves, title OSC, OSC52
 * clipboard writes (see dsh-tui-security.md, 终端转义注入).
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
