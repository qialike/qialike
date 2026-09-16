/**
 * Unit tests for the raw-stdin decoder (`StdinDecoder`).
 *
 * The decoder is the robustness guarantee for dsh-tui's mouse/keyboard input:
 * recognized sequences decode precisely, and **any unknown escape sequence is
 * consumed whole and discarded** so stray bytes can never leak into the
 * composer as typed text. These tests pin that contract.
 *
 * Run with `bun test tests/stdin-decoder.test.ts`.
 *
 * @module dsh-tui/stdin-decoder-test
 */

import { describe, expect, test } from 'bun:test'
import { sanitizeTerminalText } from '../packages/dsh-tui-app/src/terminal-safe.ts'
import { StdinDecoder } from '../packages/dsh-tui-app/src/stdin.ts'

const esc = (hex: string): Uint8Array => Buffer.from(hex.split(' ').map((h) => Number.parseInt(h, 16)))

describe('StdinDecoder', () => {
  test('plain text, return, newline, tab, backspace', () => {
    const d = new StdinDecoder()
    expect(d.push('abc')).toEqual([{ char: 'a' }, { char: 'b' }, { char: 'c' }])
    expect(d.push('\r')).toEqual([{ char: '\r', return: true }])
    expect(d.push('\n')).toEqual([{ char: '\n' }])
    expect(d.push('\t')).toEqual([{ tab: true }])
    expect(d.push(Buffer.from([0x7f]))).toEqual([{ backspace: true }])
  })

  test('utf-8 multibyte', () => {
    const d = new StdinDecoder()
    expect(d.push('你好')).toEqual([{ char: '你' }, { char: '好' }])
  })

  test('control chars: ctrl+c/u/p', () => {
    const d = new StdinDecoder()
    expect(d.push(Buffer.from([0x03]))).toEqual([{ char: 'c', ctrl: true }])
    expect(d.push(Buffer.from([0x15]))).toEqual([{ char: 'u', ctrl: true }])
    expect(d.push(Buffer.from([0x10]))).toEqual([{ char: 'p', ctrl: true }])
  })

  test('ctrl+t and alt+t decode (reasoning-effort cycle keys)', () => {
    const d = new StdinDecoder()
    expect(d.push(Buffer.from([0x14]))).toEqual([{ char: 't', ctrl: true }]) // Ctrl+T
    expect(d.push(esc('1b 74'))).toEqual([{ char: 't', meta: true }]) // Alt+T
  })

  test('ctrl+y decodes (copy the active selection key)', () => {
    const d = new StdinDecoder()
    expect(d.push(Buffer.from([0x19]))).toEqual([{ char: 'y', ctrl: true }]) // Ctrl+Y
  })

  test('ctrl+d and alt+d decode (hide-provider keys)', () => {
    const d = new StdinDecoder()
    expect(d.push(Buffer.from([0x04]))).toEqual([{ char: 'd', ctrl: true }]) // Ctrl+D
    expect(d.push(esc('1b 64'))).toEqual([{ char: 'd', meta: true }]) // Alt+D
  })

  test('arrows, home, end, page up/down', () => {
    const d = new StdinDecoder()
    expect(d.push(esc('1b 5b 41'))).toEqual([{ upArrow: true }])
    expect(d.push(esc('1b 5b 42'))).toEqual([{ downArrow: true }])
    expect(d.push(esc('1b 5b 43'))).toEqual([{ rightArrow: true }])
    expect(d.push(esc('1b 5b 44'))).toEqual([{ leftArrow: true }])
    expect(d.push(esc('1b 5b 48'))).toEqual([{ home: true }])
    expect(d.push(esc('1b 5b 46'))).toEqual([{ end: true }])
    expect(d.push(esc('1b 4f 48'))).toEqual([{ home: true }]) // SS3 \x1bOH
    expect(d.push(esc('1b 4f 46'))).toEqual([{ end: true }]) // SS3 \x1bOF
    expect(d.push(esc('1b 5b 35 7e'))).toEqual([{ pageUp: true }])
    expect(d.push(esc('1b 5b 36 7e'))).toEqual([{ pageDown: true }])
    expect(d.push(esc('1b 5b 33 7e'))).toEqual([{ delete: true }]) // Delete \x1b[3~
  })

  /**
   * The SAME logical key arrives in several encodings depending on the terminal
   * and its current mode. A terminal in DECCKM (`?1h`, application cursor keys)
   * sends the arrows as SS3 — a decoder that only knew the CSI forms made every
   * arrow key dead there; the vt220/linux-console and rxvt Home/End tilde forms
   * (`ESC[1~`/`ESC[4~`/`ESC[7~`/`ESC[8~`) had the same problem. Both were
   * reported as "the key does nothing" in the composer.
   */
  test('the same key in its other encodings (SS3 arrows, Home/End tilde forms)', () => {
    const d = new StdinDecoder()
    expect(d.push(esc('1b 4f 41'))).toEqual([{ upArrow: true }]) // SS3 \x1bOA (DECCKM)
    expect(d.push(esc('1b 4f 42'))).toEqual([{ downArrow: true }])
    expect(d.push(esc('1b 4f 43'))).toEqual([{ rightArrow: true }])
    expect(d.push(esc('1b 4f 44'))).toEqual([{ leftArrow: true }])
    expect(d.push(esc('1b 5b 31 7e'))).toEqual([{ home: true }]) // \x1b[1~ (vt220 / linux console)
    expect(d.push(esc('1b 5b 34 7e'))).toEqual([{ end: true }]) // \x1b[4~
    expect(d.push(esc('1b 5b 37 7e'))).toEqual([{ home: true }]) // \x1b[7~ (rxvt)
    expect(d.push(esc('1b 5b 38 7e'))).toEqual([{ end: true }]) // \x1b[8~
    // The variants must not have widened the "unknown CSI" contract: Insert
    // (\x1b[2~), modified arrows (\x1b[1;5D) and F-keys stay discarded, and never
    // leak into the draft as text.
    expect(d.push(esc('1b 5b 32 7e'))).toEqual([])
    expect(d.push(esc('1b 5b 31 3b 35 44'))).toEqual([])
    expect(d.push(esc('1b 4f 50'))).toEqual([]) // SS3 F1
    expect(d.push('a')).toEqual([{ char: 'a' }])
  })

  test('alt+enter', () => {
    const d = new StdinDecoder()
    expect(d.push(esc('1b 0d'))).toEqual([{ altEnter: true }])
  })

  test('sgr mouse press / release / drag / wheel', () => {
    const d = new StdinDecoder()
    expect(d.push(esc('1b 5b 3c 30 3b 35 3b 31 30 4d'))).toEqual([{ mousePress: { row: 10, col: 5 } }])
    expect(d.push(esc('1b 5b 3c 30 3b 35 3b 31 30 6d'))).toEqual([{ mouseRelease: { row: 10, col: 5 } }])
    expect(d.push(esc('1b 5b 3c 33 3b 35 3b 31 30 4d'))).toEqual([{ mouseRelease: { row: 10, col: 5 } }]) // X10-style button 3
    expect(d.push(esc('1b 5b 3c 33 32 3b 35 3b 31 30 4d'))).toEqual([{ mouseDrag: { row: 10, col: 5 } }]) // button 32 = left+motion
    expect(d.push(esc('1b 5b 3c 33 35 3b 35 3b 31 30 4d'))).toEqual([{ mouseMove: { row: 10, col: 5 } }]) // button 35 = motion no button (?1003 hover)
    expect(d.push(esc('1b 5b 3c 36 34 3b 35 3b 31 30 4d'))).toEqual([{ wheelUp: { row: 10, col: 5 } }])
    expect(d.push(esc('1b 5b 3c 36 35 3b 35 3b 31 30 4d'))).toEqual([{ wheelDown: { row: 10, col: 5 } }])
  })

  test('sgr mouse: right button decodes as mouseRightPress; left press unchanged', () => {
    const d = new StdinDecoder()
    // SGR button 2 = right press.
    expect(d.push(esc('1b 5b 3c 32 3b 35 3b 31 30 4d'))).toEqual([{ mouseRightPress: { row: 10, col: 5 } }])
    // Right + motion (2 + 32 = 34) is consumed (popups close on the press).
    expect(d.push(esc('1b 5b 3c 33 34 3b 35 3b 31 30 4d'))).toEqual([])
    // Left press still decodes as mousePress; release is shared.
    expect(d.push(esc('1b 5b 3c 30 3b 35 3b 31 30 4d'))).toEqual([{ mousePress: { row: 10, col: 5 } }])
    expect(d.push(esc('1b 5b 3c 32 3b 35 3b 31 30 6d'))).toEqual([{ mouseRelease: { row: 10, col: 5 } }])
  })

  test('sgr mouse: SHIFT+right press carries the modifier, plain right does not', () => {
    const d = new StdinDecoder()
    // SGR button 6 = right (2) + shift (4). The dialog paste gesture is
    // Shift+right-click, so the bit must survive decoding; a plain right press
    // must stay exactly as before (no `shift` field).
    expect(d.push(esc('1b 5b 3c 36 3b 35 3b 31 30 4d'))).toEqual([{ mouseRightPress: { row: 10, col: 5 }, shift: true }])
    expect(d.push(esc('1b 5b 3c 32 3b 35 3b 31 30 4d'))).toEqual([{ mouseRightPress: { row: 10, col: 5 } }])
    // Other modifier combos stay ignored (the terminal keeps its own selection).
    expect(d.push(esc('1b 5b 3c 30 3b 35 3b 31 30 4d'))).toEqual([{ mousePress: { row: 10, col: 5 } }])
    expect(d.push(esc('1b 5b 3c 34 3b 35 3b 31 30 4d'))).toEqual([])
  })

  test('sgr mouse: the release after a right press is tagged mouseRightRelease', () => {
    const d = new StdinDecoder()
    // Right press then its release (SGR release carries no button — the decoder
    // tags it so popups swallow it instead of treating it as a left-click).
    expect(d.push(esc('1b 5b 3c 32 3b 35 3b 31 30 4d'))).toEqual([{ mouseRightPress: { row: 10, col: 5 } }])
    expect(d.push(esc('1b 5b 3c 32 3b 35 3b 31 30 6d'))).toEqual([{ mouseRightRelease: { row: 10, col: 5 } }])
    // A following left press resets the pending flag: its release is normal.
    expect(d.push(esc('1b 5b 3c 30 3b 35 3b 31 30 4d'))).toEqual([{ mousePress: { row: 10, col: 5 } }])
    expect(d.push(esc('1b 5b 3c 30 3b 35 3b 31 30 6d'))).toEqual([{ mouseRelease: { row: 10, col: 5 } }])
    // Any non-right press between them also clears the pending tag.
    expect(d.push(esc('1b 5b 3c 32 3b 35 3b 31 30 4d'))).toEqual([{ mouseRightPress: { row: 10, col: 5 } }])
    expect(d.push(esc('1b 5b 3c 30 3b 35 3b 31 30 4d'))).toEqual([{ mousePress: { row: 10, col: 5 } }])
    expect(d.push(esc('1b 5b 3c 30 3b 35 3b 31 30 6d'))).toEqual([{ mouseRelease: { row: 10, col: 5 } }])
  })

  test('multi-byte button field (10 columns)', () => {
    const d = new StdinDecoder()
    expect(d.push(esc('1b 5b 3c 30 3b 31 30 3b 32 30 4d'))).toEqual([{ mousePress: { row: 20, col: 10 } }])
  })

  test('sgr mouse: modifier combos are ignored (native selection)', () => {
    const d = new StdinDecoder()
    expect(d.push(esc('1b 5b 3c 34 3b 35 3b 31 30 4d'))).toEqual([]) // Shift+left (button 4)
    expect(d.push(esc('1b 5b 3c 31 36 3b 35 3b 31 30 4d'))).toEqual([]) // Ctrl+left (button 16)
  })

  test('unknown escape sequences are discarded whole (no leaked text)', () => {
    const d = new StdinDecoder()
    expect(d.push(esc('1b 5b 31 3b 32 41'))).toEqual([]) // Shift+Up
    expect(d.push(esc('1b 5b 31 3b 39 48'))).toEqual([]) // cursor position \x1b[1;9H
    expect(d.push(esc('1b 5b 33 31 6d'))).toEqual([]) // color SGR \x1b[31m
    expect(d.push(esc('1b 4f 50'))).toEqual([]) // F1
    expect(d.push(esc('1b 5b 4d'))).toEqual([]) // lone X10 mouse prefix (no 1006)
  })

  test('esc followed by an unknown byte: emits escape, discards the byte', () => {
    const d = new StdinDecoder()
    expect(d.push(esc('1b 71'))).toEqual([{ escape: true }]) // \x1bq
  })

  test('double esc = two Esc presses (one immediate, one via flushEsc)', () => {
    const d = new StdinDecoder()
    expect(d.push(esc('1b 1b'))).toEqual([{ escape: true }]) // first Esc consumed immediately
    expect(d.pendingEscape).toBe(true) // second Esc left as a lone pending ESC
    expect(d.flushEsc()).toEqual([{ escape: true }]) // timer resolves it as the second Esc press
  })

  test('lone ESC waits for disambiguation, flushEsc resolves it', () => {
    const d = new StdinDecoder()
    expect(d.push(Buffer.from([0x1b]))).toEqual([])
    expect(d.pendingEscape).toBe(true)
    expect(d.flushEsc()).toEqual([{ escape: true }])
    expect(d.pendingEscape).toBe(false)
    // A lone ESC followed later by more input must not resolve as Escape:
    const d2 = new StdinDecoder()
    d2.push(Buffer.from([0x1b]))
    expect(d2.push(Buffer.from([0x5b, 0x41]))).toEqual([{ upArrow: true }]) // completes \x1b[A
  })

  test('chunked sgr mouse sequence across pushes', () => {
    const d = new StdinDecoder()
    expect(d.push(esc('1b 5b 3c 30 3b 35 3b 31'))).toEqual([]) // incomplete
    expect(d.push(esc('30 4d'))).toEqual([{ mousePress: { row: 10, col: 5 } }])
  })

  test('incomplete unknown csi waits for its final byte', () => {
    const d = new StdinDecoder()
    expect(d.push(esc('1b 5b 31 3b'))).toEqual([]) // no final byte yet
    expect(d.push(esc('41'))).toEqual([]) // now complete -> discarded
  })
})

test('bracketed paste is assembled into one paste event', () => {
  const d = new StdinDecoder()
  expect(d.push(Buffer.from('\x1b[200~'))).toEqual([])
  expect(d.push(Buffer.from('/tmp/photo.png'))).toEqual([])
  expect(d.push(Buffer.from('\x1b[201~'))).toEqual([{ paste: '/tmp/photo.png' }])
})

test('bracketed paste normalizes CRLF / CR line endings to LF', () => {
  // A CRLF clipboard used to reach the draft verbatim and the CR WIPED the row
  // it ended (cursor to column 0, then the row's padding overwrote the text):
  // pasting two CRLF lines showed an empty first row and only the second line.
  const d = new StdinDecoder()
  expect(d.push(Buffer.from('\x1b[200~one\r\ntwo\x1b[201~'))).toEqual([{ paste: 'one\ntwo' }])
  const e = new StdinDecoder()
  expect(e.push(Buffer.from('\x1b[200~a\rb\x1b[201~'))).toEqual([{ paste: 'a\nb' }])
})

test('bracketed paste strips terminal control bytes AND whole escape sequences', () => {
  // A paste is untrusted text: copying from a build/terminal log brings ANSI with
  // it, and Ink re-emits a control byte it does not recognise VERBATIM into the
  // frame — measured on the real binary, a draft holding `X\x1b[2JY` put
  // `\x1b[2J` into the composer row's own write (a screen erase, replayed every
  // repaint), `\x1b[31m` reached the terminal as live styling, and OSC 52 reached
  // it as a clipboard write. The DIALOG paste path already sanitizes
  // (clipboard.ts); this is the same treatment at the shared source, so the
  // composer (and any other `k.paste` consumer) cannot smuggle them in.
  const cases: [string, string][] = [
    ['SGR colour', 'A\x1b[31mRED\x1b[0mB'],
    ['erase display', 'X\x1b[2JY'],
    ['erase line', 'X\x1b[KY'],
    ['cursor move', 'X\x1b[10;10HY'],
    ['hide cursor', 'X\x1b[?25lY'],
    ['OSC 52 clipboard write', 'X\x1b]52;c;cGF3bmVk\x07Y'],
    ['OSC 0 window title', 'X\x1b]0;pwned\x07Y'],
    ['C1 CSI (0x9b)', 'X\x9b31mY'],
    ['DEL and NUL', 'A\x00B\x7fC'],
  ]
  for (const [label, payload] of cases) {
    const d = new StdinDecoder()
    d.push(Buffer.from('\x1b[200~'))
    const out = d.push(Buffer.from(payload + '\x1b[201~'))
    expect(out, label).toHaveLength(1)
    const pasted = out[0]!.paste ?? ''
    expect(pasted, `${label}: machine text is sanitized`).toBe(sanitizeTerminalText(payload))
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/.test(pasted), `${label}: measured clean`).toBe(false)
  }
  // The kept whitespace is untouched: tabs and newlines are content.
  const d = new StdinDecoder()
  d.push(Buffer.from('\x1b[200~'))
  expect(d.push(Buffer.from('a\tb\nc\x1b[201~'))).toEqual([{ paste: 'a\tb\nc' }])
  // …and the two normalizations compose (CRLF -> LF, then whole escape sequences,
  // then the byte floor): a pasted colour code is decoration, not content, so it
  // disappears entirely while the words survive.
  const e = new StdinDecoder()
  e.push(Buffer.from('\x1b[200~'))
  expect(e.push(Buffer.from('one\r\n\x1b[31mtwo\x1b[201~'))).toEqual([{ paste: 'one\ntwo' }])
})

test('bracketed paste splits cleanly around surrounding text', () => {
  const d = new StdinDecoder()
  expect(d.push(Buffer.from('a\x1b[200~/x/y.png\x1b[201~b')))
    .toEqual([{ char: 'a' }, { paste: '/x/y.png' }, { char: 'b' }])
})
