/**
 * Unit tests for `stripTerminalControls` (fix 1, dsh-tui-security.md): the
 * render-entry guard that strips terminal control bytes from untrusted model /
 * tool / question text before it reaches a <Text>/<MarkdownText> boundary.
 *
 * The transcript renders that text into the Ink framebuffer and the frame
 * writer emits it to stdout verbatim; Ink re-emits unrecognized ESC/C1 bytes
 * as live control sequences (screen clears, OSC52 clipboard writes). The
 * sanitizer must drop those bytes while keeping everything a terminal should
 * display: TAB/LF/CR, printable ASCII, and full astral/CJK text.
 *
 * Run with `bun test tests/terminal-safe.test.ts`.
 *
 * @module dsh-tui/terminal-safe-test
 */

import { describe, expect, test } from 'bun:test'
import { stripTerminalControls } from '../packages/dsh-tui-app/src/terminal-safe.ts'

describe('stripTerminalControls keeps display text intact', () => {
  test('plain text passes through unchanged', () => {
    const s = 'hello world — 你好，dsh-tui！'
    expect(stripTerminalControls(s)).toBe(s)
  })

  test('keeps TAB / LF / CR (structural whitespace) and printable ASCII', () => {
    const s = 'line1\twith\ttabs\nline2\r\nline3'
    expect(stripTerminalControls(s)).toBe(s)
  })

  test('keeps astral / CJK text (surrogate pairs above the control ranges)', () => {
    const s = '𝔘𝔫𝔦𝔠𝔬𝔡𝔢 🚀 汉字 中文'
    expect(stripTerminalControls(s)).toBe(s)
  })

  test('returns the SAME reference when nothing was removed', () => {
    const s = 'no controls here, just text'
    expect(stripTerminalControls(s)).toBe(s) // referential identity => zero-copy fast path
  })
})

describe('stripTerminalControls removes C0/C1/DEL injection vectors', () => {
  test('ESC (0x1B) is stripped wherever it appears', () => {
    const esc = String.fromCharCode(0x1b)
    expect(stripTerminalControls(`${esc}[2J`)).toBe('[2J') // clear screen
    expect(stripTerminalControls(`${esc}]0;title${String.fromCharCode(0x07)}`)).toBe(']0;title') // OSC title
    expect(stripTerminalControls(`before${esc}after`)).toBe('beforeafter')
  })

  test('OSC52 clipboard-push payload is neutralized (ESC … BEL dropped)', () => {
    const osc52 = `\u001b]52;c;QUJDRA==\u0007`
    const out = stripTerminalControls(osc52)
    expect(out.includes('\u001b')).toBe(false)
    expect(out.includes('\u0007')).toBe(false)
    expect(out).toBe(']52;c;QUJDRA==')
  })

  test('drops every other C0 control (NUL, BEL, backspace, unit separators)', () => {
    const c0 = [0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x0f, 0x1c, 0x1f]
    for (const code of c0) {
      const ch = String.fromCharCode(code)
      expect(stripTerminalControls(`a${ch}b`)).toBe('ab')
    }
  })

  test('drops DEL 0x7F and the whole C1 range 0x80-0x9F (CSI/OSC/DCS bytes)', () => {
    for (let code = 0x80; code <= 0x9f; code++) {
      const ch = String.fromCharCode(code)
      expect(stripTerminalControls(`a${ch}b`)).toBe('ab')
    }
    expect(stripTerminalControls('a\u007fb')).toBe('ab')
    // A lone C1 CSI (0x9B) must not reach the terminal either.
    expect(stripTerminalControls(`x\u009b2J`)).toBe('x2J')
  })

  test('mixed payload is fully scrubbed in one pass', () => {
    const mixed = `\u001b[31mred\u001b[0m \u0000 \u009b pad \u0007`
    const out = stripTerminalControls(mixed)
    expect(out).toBe('[31mred[0m   pad ')
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\u001b]/.test(out)).toBe(false)
  })
})
