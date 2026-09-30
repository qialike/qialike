/**
 * Unit tests for the file-backed session reader: a synthetic log is
 * written the way the harness writes one — a header frame, then one frame per
 * append flush — and the reader must find frames, address events by seq, and
 * read a tail whose cost follows the viewport rather than the file.
 *
 * Run with `bun test tests/log-frames.test.ts`.
 *
 * @module qialike/log-frames-test
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLogReader, scanFrameTable } from '../packages/qialike-app/src/log-frames.ts'

/** One zstd frame from a list of JSON lines (what one append flush produces). */
function frame(lines: readonly unknown[]): Uint8Array {
  return Bun.zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'))
}

/** One plain event row (a single event, as the writer stores a normal event). */
function eventRow(seq: number, text = `row ${seq}`): Record<string, unknown> {
  return { type: 'assistant/chunk', seq, time: 1000 + seq, data: { text } }
}

/** One PACKED delta run: N events (seqs `seq0..seq0+N-1`) in a single record. */
function packedRow(seq0: number, texts: readonly string[]): Record<string, unknown> {
  return {
    type: 'text-chunks',
    seq0,
    time0: 2000 + seq0,
    data: { turn: 1, step: 1, index: 0, dt: texts.slice(1).map(() => 1), texts: [...texts] },
  }
}

/**
 * Write a log with `rows` events in `perFrame`-sized flushes, the way the harness
 * writes one (header frame first, then one frame per append flush).
 * @returns the path.
 */
function writeLog(rows: number, perFrame = 3): { path: string; events: { seq: number; type: string }[] } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-frames-'))
  const path = join(dir, 'session.jsonl.zstd')
  const parts: Uint8Array[] = []
  const events: { seq: number; type: string }[] = []
  let seq = 0
  parts.push(frame([{ type: 'session', version: 0, id: 'session-test', createdAt: 1, cwd: '/tmp' }]))
  let batch: unknown[] = []
  while (seq < rows) {
    batch.push(eventRow(seq))
    events.push({ seq, type: 'assistant/chunk' })
    seq += 1
    if (batch.length >= perFrame) {
      parts.push(frame(batch))
      batch = []
    }
  }
  if (batch.length > 0) parts.push(frame(batch))
  writeFileSync(path, Buffer.concat(parts.map((p) => Buffer.from(p))))
  return { path, events }
}

describe('frame table', () => {
  test('finds one frame per flush plus the header frame', async () => {
    const { path } = writeLog(90, 3) // 30 flush frames + 1 header frame
    const table = await scanFrameTable(path)
    expect(table.offsets.length).toBe(31)
    expect(table.offsets[0]).toBe(0)
  })
})

describe('session log reader', () => {
  test('reads an event range by decompressing only covering frames', async () => {
    const { path, events } = writeLog(300, 3)
    const reader = new SessionLogReader(path)
    expect(await reader.totalEvents()).toBe(300)
    const middle = await reader.read(120, 126)
    expect(middle.map((e) => e.seq)).toEqual([120, 121, 122, 123, 124, 125])
    expect(middle[0]!.type).toBe('assistant/chunk')
    // the header frame's event is NOT in the seq space
    expect(await reader.read(0, 1)).toHaveLength(1)
    expect(events[0]!.seq).toBe(0)
  })

  test('reads the tail whose cost follows the viewport, and reports the start seq', async () => {
    const { path } = writeLog(5_000, 3)
    const reader = new SessionLogReader(path)
    const tail = await reader.readTail(120)
    expect(tail.total).toBe(5_000)
    expect(tail.events.length).toBeGreaterThanOrEqual(121)
    // Viewport-bounded: proportionally more than asked (density estimate + one
    // correction), but nowhere near the whole log.
    expect(tail.events.length).toBeLessThan(1_500)
    expect(tail.startSeq).toBe(tail.events[0]!.seq)
    expect(tail.events[tail.events.length - 1]!.seq).toBe(4_999)
  })

  test('a torn tail frame (a concurrent append in flight) is skipped, not fatal', async () => {
    const { path } = writeLog(60, 3)
    const good = await Bun.file(path).arrayBuffer()
    // append half a frame: a valid prefix that cannot be decompressed
    const torn = Buffer.concat([Buffer.from(good), Buffer.from(Bun.zstdCompressSync(Buffer.from('x'.repeat(400))).slice(0, 12))])
    writeFileSync(path, torn)
    const reader = new SessionLogReader(path)
    expect(await reader.totalEvents()).toBe(60)
    const tail = await reader.readTail(10)
    expect(tail.events[tail.events.length - 1]!.seq).toBe(59)
  })

  test('a record SPLIT across two frames is still read (frames are byte-bounded flushes)', async () => {
    // The real logs do this: a flush cuts mid-record, so the first line of the
    // next frame is a fragment. Parsing frame by frame silently drops it — and
    // breaks the seq bisection (measured on the real 1.48M-event log).
    const dir = mkdtempSync(join(tmpdir(), 'dsh-log-frames-split-'))
    const path = join(dir, 'session.jsonl.zstd')
    const row = (seq: number): string => JSON.stringify({ type: 'assistant/chunk', seq, data: { text: 'x'.repeat(40) } })
    const head = JSON.stringify({ type: 'session', version: 0, id: 'session-split', createdAt: 1, cwd: '/tmp' })
    const a = `${head}\n${row(0)}\n${row(1)}`
    const b = `\n${row(2)}\n${row(3)}\n${row(4)}`
    const c = `\n${row(5)}\n${row(6)}\n`
    writeFileSync(path, Buffer.concat([a, b, c].map((t) => Buffer.from(Bun.zstdCompressSync(Buffer.from(t))))))
    const reader = new SessionLogReader(path)
    expect(await reader.totalEvents()).toBe(7)
    const all = await reader.read(0, 7)
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
    // a range that starts inside the second frame must still return seq 2..3
    expect((await reader.read(2, 4)).map((e) => e.seq)).toEqual([2, 3])
    // the tail must include the newest record, not stop at the fragment
    const tail = await reader.readTail(3)
    expect(tail.total).toBe(7)
    expect(tail.events[tail.events.length - 1]!.seq).toBe(6)
  })

  test('an UNTERMINATED trailing record is dropped (it may be a torn append)', async () => {
    // A record with no closing newline is exactly what a flush in flight looks
    // like; treating it as complete would show a half-written event.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-log-frames-torn-record-'))
    const path = join(dir, 'session.jsonl.zstd')
    const head = JSON.stringify({ type: 'session', version: 0, id: 'session-torn', createdAt: 1, cwd: '/tmp' })
    const frames = [
      `${head}\n${JSON.stringify({ type: 'assistant/chunk', seq: 0, data: {} })}\n`,
      JSON.stringify({ type: 'assistant/chunk', seq: 1, data: { text: 'complete' } }) + '\n',
      JSON.stringify({ type: 'assistant/chunk', seq: 2, data: { text: 'half-writ' } }), // no newline
    ]
    writeFileSync(path, Buffer.concat(frames.map((t) => Buffer.from(Bun.zstdCompressSync(Buffer.from(t))))))
    const reader = new SessionLogReader(path)
    expect(await reader.totalEvents()).toBe(2)      // seq 2 is not counted yet
    expect((await reader.read(0, 5)).map((e) => e.seq)).toEqual([0, 1])
  })

  test('a PACKED delta run expands to its events, and ranges inside it work', async () => {
    // The log stores a run of `assistant/chunk` deltas as ONE `text-chunks` row
    // anchored on `seq0`; those rows are not session events and one row expands to
    // N events (seqs seq0..seq0+N-1). Hand-parsing for a `seq` field drops them —
    // which emptied every range that happened to sit inside a run.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-log-frames-packed-'))
    const path = join(dir, 'session.jsonl.zstd')
    const head = { type: 'session', version: 0, id: 'session-packed', createdAt: 1, cwd: '/tmp' }
    const texts = ['a', 'b', 'c', 'd', 'e', 'f']
    const parts = [
      frame([head, eventRow(0, 'before')]),
      frame([packedRow(1, texts)]),
      frame([eventRow(7, 'after')]),
    ]
    writeFileSync(path, Buffer.concat(parts.map((p) => Buffer.from(p))))
    const reader = new SessionLogReader(path)
    expect(await reader.totalEvents()).toBe(8)
    expect((await reader.read(0, 8)).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    // a range INSIDE the run (the case that returned [] before)
    expect((await reader.read(3, 6)).map((e) => e.seq)).toEqual([3, 4, 5])
    // and the expanded members are real `assistant/chunk` events carrying their
    // delta text in order (the harness's own codec decides the shape)
    const inside = await reader.read(1, 4)
    expect(inside.map((e) => e.type)).toEqual(['assistant/chunk', 'assistant/chunk', 'assistant/chunk'])
    expect(inside.map((e) => (e.data as { chunk?: { text?: string } }).chunk?.text)).toEqual(['a', 'b', 'c'])
  })

  test('a CURRENT (v3) log is one event per row and needs no decoding', async () => {
    // The 0.1.5 writer stores one event per line (header version 3) with no
    // packed runs at all, so the same frame table / bisection serves it — the
    // reader must not depend on the removed `chunk-rows` vocabulary.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-log-frames-v3-'))
    const path = join(dir, 'session.v3.jsonl.zstd')
    const head = { type: 'session', version: 3, id: 'session-v3', createdAt: 1, cwd: '/tmp' }
    const row = (seq: number): Record<string, unknown> => ({
      type: 'user/message',
      seq,
      time: 3000 + seq,
      data: { role: 'user', content: [{ type: 'text', text: `v3 row ${seq}` }] },
    })
    const parts = [frame([head, row(0), row(1)]), frame([row(2), row(3)])]
    writeFileSync(path, Buffer.concat(parts.map((p) => Buffer.from(p))))
    const reader = new SessionLogReader(path)
    expect(await reader.totalEvents()).toBe(4)
    expect((await reader.read(1, 3)).map((e) => e.seq)).toEqual([1, 2])
    expect((await reader.read(0, 4)).map((e) => e.type)).toEqual([
      'user/message', 'user/message', 'user/message', 'user/message',
    ])
    expect((await reader.readTail(50)).startSeq).toBe(0)
  })

  test('a MALFORMED packed row is dropped instead of surfacing a half run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-log-frames-badpack-'))
    const path = join(dir, 'session.jsonl.zstd')
    const head = { type: 'session', version: 0, id: 'session-badpack', createdAt: 1, cwd: '/tmp' }
    const bad = {
      type: 'text-chunks',
      seq0: 1,
      time0: 2000,
      // three members but only one gap: the row is corrupt storage.
      data: { turn: 1, step: 1, index: 0, dt: [1], texts: ['a', 'b', 'c'] },
    }
    const parts = [frame([head, eventRow(0, 'before')]), frame([bad]), frame([eventRow(1, 'after')])]
    writeFileSync(path, Buffer.concat(parts.map((p) => Buffer.from(p))))
    const reader = new SessionLogReader(path)
    expect(await reader.totalEvents()).toBe(2)
    expect((await reader.read(0, 5)).map((e) => e.seq)).toEqual([0, 1])
  })

  test('an empty/foreign file reads as empty instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-log-frames-empty-'))
    const path = join(dir, 'session.jsonl.zstd')
    writeFileSync(path, Buffer.from('not a zstd log at all'))
    const reader = new SessionLogReader(path)
    expect(await reader.totalEvents()).toBe(0)
    expect(await reader.read(0, 10)).toEqual([])
    expect((await reader.readTail(10)).events).toEqual([])
  })
})
