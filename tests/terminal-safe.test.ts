/**
 * Unit tests for `stripTerminalControls` (fix 1, qialike-security.md): the
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
 * @module qialike/terminal-safe-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { sanitizeTerminalText, stripAnsiSequences, stripTerminalControls } from '../packages/qialike-app/src/terminal-safe.ts'
import { Store } from '../packages/qialike-app/src/index.tsx'

describe('stripTerminalControls keeps display text intact', () => {
  test('plain text passes through unchanged', () => {
    const s = 'hello world — 你好，qialike！'
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

describe('the composer draft is a sanitized boundary too', () => {
  // The transcript has always stripped (conversation.tsx itemContent); the draft
  // did not, and a PASTE is untrusted text. Measured on the real binary before the
  // fix: a draft holding `X\x1b[2JY` put `\x1b[2J` into the composer row's own write
  // (screen erase, replayed every repaint), `\x1b[31m` reached the terminal as live
  // styling and OSC 52 as a clipboard write.
  test('insertAtCursor strips control bytes', () => {
    for (const [raw, clean] of [
      ['A\x1b[31mRED\x1b[0mB', 'AREDB'],
      ['X\x1b[2JY', 'XY'],
      ['X\x1b]52;c;cGF3bmVk\x07Y', 'XY'],
      ['X\x9b31mY', 'XY'],
      ['A\x00B\x7fC', 'ABC'],
    ] as const) {
      const store = new Store()
      store.insertAtCursor(raw as string)
      expect(store.input, JSON.stringify(raw)).toBe(clean)
      expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/.test(store.input)).toBe(false)
    }
  })

  test('the caret moves by the CLEANED length, so it stays on the draft', () => {
    const store = new Store()
    store.insertAtCursor('X\x1b[2JY')
    store.insertAtCursor('!')
    expect(store.input).toBe('XY!')
    // Cursor sits after the inserted character (the removed bytes do not count).
    store.backspaceAtCursor()
    expect(store.input).toBe('XY')
  })

  test('CR folding and the typed paths are unaffected', () => {
    const store = new Store()
    store.insertAtCursor('one\r\ntwo')
    expect(store.input).toBe('one\ntwo')
    store.insertAtCursor('\n')
    store.insertAtCursor('a')
    expect(store.input).toBe('one\ntwo\na')
  })

  test('wiring guard: the paste assembly sanitizes at the decoder too', () => {
    // Two independent gates, because either one alone is one careless edit away
    // from reopening the hole (the batch that added dialog paste shipped exactly
    // such a silent deletion once).
    const stdin = readFileSync(new URL('../packages/qialike-app/src/stdin.ts', import.meta.url), 'utf-8')
    const pastePush = stdin.slice(stdin.indexOf('out.push({ paste:'), stdin.indexOf('\n', stdin.indexOf('out.push({ paste:')))
    expect(pastePush, 'stdin.ts sanitizes the paste it emits').toContain('sanitizeTerminalText(')
    const index = readFileSync(new URL('../packages/qialike-app/src/index.tsx', import.meta.url), 'utf-8')
    const insert = index.slice(index.indexOf('insertAtCursor(text: string): void {'),
                               index.indexOf('backspaceAtCursor(): void {'))
    expect(insert, 'insertAtCursor sanitizes too (belt and braces)').toContain('sanitizeTerminalText(')
    expect(insert, 'and still folds CR').toContain("replace(/\\r\\n?/g, '\\n')")
  })
})

describe('stripAnsiSequences / sanitizeTerminalText (machine output)', () => {
  // Machine text — captured command output, a terminal paste — carries escape
  // sequences as DECORATION. Measured: `git diff --color=always` keeps 16.5% of
  // its width as `[1m`/`[0m` litter under a byte-only strip, a captured `--help`
  // leaves `[?1049h`, a coloured `pytest` run leaves `[32m`. The whole sequence
  // goes; the text around it stays.
  test('removes whole sequences and keeps the text', () => {
    for (const [raw, clean] of [
      ['A\x1b[31mRED\x1b[0mB', 'AREDB'],                       // SGR
      ['[1mdiff --git a/x b/x[m', '[1mdiff --git a/x b/x[m'],    // no ESC: untouched
      ['\x1b[1mdiff --git a/x b/x\x1b[m', 'diff --git a/x b/x'],
      ['\x1b[?1049hUsage: dsh', 'Usage: dsh'],                  // private mode
      ['X\x1b[2JY', 'XY'],                                      // erase display
      ['X\x1b[10;10HY', 'XY'],                                  // cursor move
      ['X\x1b]52;c;cGF3bmVk\x07Y', 'XY'],                      // OSC 52 clipboard write
      ['X\x1b]0;pwned\x07Y', 'XY'],                             // OSC 0 title
      ['X\x1b]8;;http://a\x1b\\link\x1b]8;;\x1b\\Y', 'XlinkY'],  // OSC 8 hyperlink keeps its text
      ['X\x9b31mY', 'XY'],                                      // 8-bit CSI
      ['X\x1b(0q\x1b(BY', 'XqY'],                              // charset designation
    ] as const) {
      expect(sanitizeTerminalText(raw as string), JSON.stringify(raw)).toBe(clean)
    }
  })

  test('literal escape TEXT is untouched (only a real byte triggers it)', () => {
    // A model documenting escapes writes these characters, not the byte.
    for (const literal of ['use \\u001b[31m for red', 'or \\x1b[31m', 'array[0m] and [x]', 'a[1] + b[2]']) {
      expect(stripAnsiSequences(literal), literal).toBe(literal)
      expect(sanitizeTerminalText(literal), literal).toBe(literal)
    }
  })

  test('truncated/unterminated sequences degrade to the byte floor', () => {
    // A sequence with no final byte inside the cap, or an OSC with no terminator,
    // must still never leak a control byte: the floor is the guarantee.
    for (const broken of ['a\x1b[31', 'a\x1b]0;title', 'a\x1b', 'a\x9b31']) {
      const out = sanitizeTerminalText(broken)
      expect(out, broken).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/)
    }
  })

  test('no control byte survives ANY input, and the pass is idempotent', () => {
    const corpus = [
      'plain text', '中文、emoji 🙂、combining é', '\t tab\nnewline\r\n',
      '\x1b[31m\x1b[0m', '\x1b]52;c;AAAA\x07', '\x9b0m', '\x1b[?25l', '\x1b[2K\x1b[1;1H',
      'half \x1b[3', 'osc without end \x1b]8;;http://x', '\x00\x01\x1f\x7f',
      '\u001b literal', 'mix \x1b[1mbold\x1b[22m and 中文',
    ]
    for (const text of corpus) {
      const once = sanitizeTerminalText(text)
      expect(once, JSON.stringify(text)).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/)
      expect(sanitizeTerminalText(once), `idempotent: ${JSON.stringify(text)}`).toBe(once)
    }
    // …and the floor is NOT replaced by the sequence pass: on its own the pass can
    // leave control bytes behind (a lone ESC, a C1 byte), which is exactly why the
    // composite exists.
    expect(stripAnsiSequences('a\x1bb')).toMatch(/\x1b/)
    expect(sanitizeTerminalText('a\x1bb')).toBe('ab')
  })
})

describe('the render-entry policy is pinned (machine output vs authored text)', () => {
  // The tool-body decision is one line in `itemContent`; a later edit could
  // "simplify" it back to the byte-only strip and silently restore the residue
  // (`[1m`/`[0m` litter in every coloured command's output). Pin the policy, and
  // pin the reason it is safe: the sequence pass must stay LAYERED, so the
  // machine-output path still ends in the byte floor.
  const source = readFileSync(new URL('../packages/qialike-app/src/panels/conversation.tsx', import.meta.url), 'utf-8')

  test('tool bodies are machine output → whole sequences; authored text keeps the floor', () => {
    expect(source).toContain("item.kind === 'tool' ? sanitizeTerminalText(item.text) : stripTerminalControls(item.text)")
  })

  test('the composite used for machine output ends in the byte floor', () => {
    const guard = readFileSync(new URL('../packages/qialike-app/src/terminal-safe.ts', import.meta.url), 'utf-8')
    expect(guard).toContain('return stripTerminalControls(stripAnsiSequences(text))')
  })
})
