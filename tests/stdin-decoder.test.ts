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
    expect(d.push(esc('1b 5b 3c 36 34 3b 35 3b 31 30 4d'))).toEqual([{ wheelUp: true }])
    expect(d.push(esc('1b 5b 3c 36 35 3b 35 3b 31 30 4d'))).toEqual([{ wheelDown: true }])
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

test('bracketed paste splits cleanly around surrounding text', () => {
  const d = new StdinDecoder()
  expect(d.push(Buffer.from('a\x1b[200~/x/y.png\x1b[201~b')))
    .toEqual([{ char: 'a' }, { paste: '/x/y.png' }, { char: 'b' }])
})
