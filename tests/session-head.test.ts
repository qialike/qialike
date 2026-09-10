/**
 * Tests for the cheap session-log HEAD probe (web parity: decide `blank` from a
 * small head prefix instead of decoding the whole log).
 *
 * Run with `bun test tests/session-head.test.ts`.
 *
 * @module dsh-tui/session-head-test
 */

import { describe, expect, test } from 'bun:test'
import { bunZstd, firstZstdFrameEnd, foldSessionHead } from '../packages/dsh-tui-app/src/session-head.ts'

describe('foldSessionHead', () => {
  const header = JSON.stringify({ type: 'session/created', seq: 0, data: { id: 's' } })
  const title = JSON.stringify({ type: 'session/title', seq: 1, data: { title: 'fix the tests' } })
  const turn = JSON.stringify({ type: 'turn/start', seq: 2, data: { turn: 1 } })

  test('a prefix without turn/start is blank (web rule) and reports confidence', () => {
    const facts = foldSessionHead(`${header}\n`, true)
    expect(facts.blank).toBe(true)
    expect(facts.confident).toBe(true)
    // Not enough decoded bytes and not EOF → the caller must inspect fully.
    expect(foldSessionHead(`${header}\n`, false).confident).toBe(false)
  })

  test('a turn/start anywhere in the prefix means content', () => {
    const facts = foldSessionHead(`${header}\n${turn}\n`, true)
    expect(facts.blank).toBe(false)
  })

  test('an early session/title is folded for free', () => {
    const facts = foldSessionHead(`${header}\n${title}\n`, true)
    expect(facts.title).toBe('fix the tests')
    expect(facts.blank).toBe(true)
  })

  test('tolerates a torn last record and blank lines', () => {
    const facts = foldSessionHead(`${header}\n\n{"type":"session/ti`, false)
    expect(facts.blank).toBe(true)
    expect(facts.title).toBeUndefined()
  })
})

describe('firstZstdFrameEnd', () => {
  test('finds the end of the first complete frame (and rejects a torn one)', () => {
    const payload = 'x'.repeat(4096) + '\n'
    const frame = bunZstd.compressSync(new TextEncoder().encode(payload))
    const both = new Uint8Array(frame.length * 2)
    both.set(frame, 0)
    both.set(frame, frame.length)
    // Two complete frames: the scanner must stop after the FIRST one.
    expect(firstZstdFrameEnd(both)).toBe(frame.length)
    // Head cut mid-frame → undefined (caller falls back).
    expect(firstZstdFrameEnd(frame.slice(0, frame.length - 3))).toBeUndefined()
    // Not a zstd frame at all.
    expect(firstZstdFrameEnd(new Uint8Array([1, 2, 3, 4, 5]))).toBeUndefined()
  })
})
