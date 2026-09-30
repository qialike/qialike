/**
 * Tests for the cheap session-log HEAD probe (web parity: decide `blank` from a
 * small head prefix instead of decoding the whole log).
 *
 * The harness writes ONE CHECKSUMMED zstd frame per append flush (the first
 * being the header alone), so these tests build frames the same way
 * (`node:zlib` with `ZSTD_c_checksumFlag`) and cover the structural walk, the
 * multi-frame window, and the folded facts.
 *
 * Run with `bun test tests/session-head.test.ts`.
 *
 * @module qialike/session-head-test
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { bunZstd, completeZstdFrames, firstZstdFrameEnd, foldSessionHead, probeSessionHead } from '../packages/qialike-app/src/session-head.ts'
import { sessionDir } from '../packages/qialike-app/src/session-files.ts'

/** One checksummed zstd frame from JSONL lines — exactly what the harness
 *  writer produces (one frame per append flush). */
function frame(lines: readonly unknown[]): Uint8Array {
  const payload = Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return zlib.zstdCompressSync(payload, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
}

describe('foldSessionHead', () => {
  const header = JSON.stringify({ type: 'session/created', seq: 0, data: { id: 's' } })
  const title = JSON.stringify({ type: 'session/title', seq: 1, data: { title: 'fix the tests' } })
  const turn = JSON.stringify({ type: 'turn/start', seq: 2, data: { turn: 1 } })

  test('a prefix without turn or message events is blank and reports confidence', () => {
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

  test('a conversation without turn markers is NOT blank (foldSessionBlank rule)', () => {
    // The `/fork`-child seed drops turn boundaries but keeps the transcript;
    // calling that "unused" hid it from /sessions and let /new adopt it.
    for (const type of ['user/message', 'assistant/message', 'tool/result']) {
      const line = JSON.stringify({ type, seq: 2, data: {} })
      expect(foldSessionHead(`${header}\n${line}\n`, true).blank).toBe(false)
    }
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

describe('zstd frame walk', () => {
  test('finds the end of the first complete frame (and rejects a torn one)', () => {
    const payload = 'x'.repeat(4096) + '\n'
    const plain = bunZstd.compressSync(new TextEncoder().encode(payload))
    const both = new Uint8Array(plain.length * 2)
    both.set(plain, 0)
    both.set(plain, plain.length)
    // Two complete frames: the scanner must stop after the FIRST one.
    expect(firstZstdFrameEnd(both)).toBe(plain.length)
    // Head cut mid-frame → undefined (caller falls back).
    expect(firstZstdFrameEnd(plain.slice(0, plain.length - 3))).toBeUndefined()
    // Not a zstd frame at all.
    expect(firstZstdFrameEnd(new Uint8Array([1, 2, 3, 4, 5]))).toBeUndefined()
  })

  test('counts the content checksum as part of the frame', () => {
    // The harness compresses with ZSTD_c_checksumFlag = 1. A walk that stopped
    // at the last block reported a frame 4 bytes short, and every decompression
    // of that slice failed — so probeSessionHead answered undefined for every
    // real log.
    const one = frame([{ type: 'session', seq: 0 }])
    expect(firstZstdFrameEnd(one)).toBe(one.length)
    expect(firstZstdFrameEnd(one.slice(0, one.length - 1))).toBeUndefined()
    const two = new Uint8Array(one.length * 2)
    two.set(one, 0)
    two.set(one, one.length)
    expect(completeZstdFrames(two)).toEqual([
      { start: 0, end: one.length },
      { start: one.length, end: two.length },
    ])
    // A torn trailing frame is dropped, not fatal.
    const torn = new Uint8Array(one.length + 10)
    torn.set(one, 0)
    torn.set(one.slice(0, 10), one.length)
    expect(completeZstdFrames(torn)).toEqual([{ start: 0, end: one.length }])
  })
})

describe('probeSessionHead', () => {
  const home = mkdtempSync(join(tmpdir(), 'qialike-session-head-'))
  process.env.DSH_HOME = home
  const CWD = '/work/probe'
  const ID = 'session-11111111-2222-3333-4444-555555555555'
  const CONTENT_ID = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  /** Write a log the way the harness does: header frame, then one frame per
   *  append batch, every frame checksummed. */
  function writeLog(id: string, frames: readonly (readonly unknown[])[]): string {
    const dir = sessionDir(CWD, id as never)
    mkdirSync(dir, { recursive: true })
    const parts = frames.map((lines) => frame(lines))
    const path = join(dir, 'session.v3.jsonl.zstd')
    writeFileSync(path, Buffer.concat(parts))
    return path
  }

  writeLog(ID, [
    [{ type: 'session', version: 3, id: ID, createdAt: 1, cwd: CWD }],
    [{ type: 'permission/preset', seq: 0 }, { type: 'sandbox/mode', seq: 1 }, { type: 'approval/policy', seq: 2 }],
    [{ type: 'session/title', seq: 3, data: { title: 'fix the tests' } }],
    [{ type: 'sandbox/mode', seq: 4, data: { mode: 'workspace-write' } }],
  ])
  writeLog(CONTENT_ID, [
    [{ type: 'session', version: 3, id: CONTENT_ID, createdAt: 2, cwd: CWD }],
    [{ type: 'user/message', seq: 0 }],
  ])

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test('decodes EVERY complete frame in the window, not just the first', () => {
    // The title lands in frame 3: a first-frame-only decode would miss it.
    const facts = probeSessionHead(CWD, ID)
    expect(facts?.title).toBe('fix the tests')
    expect(facts?.blank).toBe(true)
    // The whole file fits in the window → eof makes the verdict confident.
    expect(facts?.confident).toBe(true)
  })

  test('a message in a later frame makes the session non-blank', () => {
    const facts = probeSessionHead(CWD, CONTENT_ID)
    expect(facts?.blank).toBe(false)
    expect(facts?.confident).toBe(true)
  })

  test('an id with no readable log returns undefined', () => {
    expect(probeSessionHead(CWD, 'session-99999999-0000-0000-0000-000000000000')).toBeUndefined()
  })

  test('a window that stops inside a frame still folds the complete ones before it', () => {
    const full = probeSessionHead(CWD, ID)
    // Cut the window inside the LAST frame: that frame is dropped, the earlier
    // ones (including the title) still answer, and the tail is unreached.
    const path = join(sessionDir(CWD, ID as never), 'session.v3.jsonl.zstd')
    const cutoff = probeSessionHead(CWD, ID, statSync(path).size - 1)
    expect(cutoff?.title).toBe('fix the tests')
    expect(cutoff?.confident).toBe(false)
    expect(full?.confident).toBe(true)
  })
})
