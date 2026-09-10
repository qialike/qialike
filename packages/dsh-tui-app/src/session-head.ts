/**
 * Cheap session-log HEAD probe (web parity).
 *
 * The harness's own session list only reads the FIRST JSONL line of each log
 * (verified in `dsh-session-persistence-jsonl`: `readFirstZstdLine` /
 * `readFirstLine`), and the web host decides whether a session is `blank` from
 * a 1 KB head probe (`DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024`) plus batched
 * summary work — it NEVER opens a log just to find out whether it has content.
 *
 * dsh-tui used to do the opposite: `autoResumeNewest` called `agents.resume()`
 * on every candidate and disposed the ones that turned out empty, and the title
 * prewarm called `inspect()` (a full-log decode) for every session missing from
 * the cache. On a 1.4M-event / 26 MB-zstd session that is seconds per session.
 *
 * This module decodes only the head of a log (the first complete zstd frame, or
 * the first N bytes of a plain `.jsonl`) and folds the facts that are decided
 * once, early in a session:
 *   - `blank`  — no `turn/start` in the probed prefix (same rule as the web);
 *   - `title`  — the session/title event, when it landed early.
 * A probe that could not cover enough of the log reports `complete: false`, and
 * callers fall back to the (expensive) full inspection for that one session.
 *
 * @module @yourname/dsh-tui-app/session-head
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sessionDir } from './session-files.ts'

/** Bytes read from the head of a log (the harness probes 1 KB; a zstd frame can
 *  be larger, so we read more and then cut at the first COMPLETE frame). */
export const HEAD_PROBE_BYTES = 128 * 1024

/** Decoded JSONL bytes a probe must produce before "no turn/start" counts as a
 *  real blank verdict (otherwise the caller falls back to a full inspect). */
export const HEAD_PROBE_MIN_JSONL = 24 * 1024

const ZSTD_MAGIC = 0xfd2fb528

/** zstd codec of the running runtime (Bun and Node ≥22.15 both expose one).
 *  Exported so tests can build real frames without a harness dependency. */
export const bunZstd: { compressSync: (data: Uint8Array) => Uint8Array } = (() => {
  const b = globalThis as { Bun?: { zstdCompressSync?: (data: Uint8Array) => Uint8Array } }
  if (typeof b.Bun?.zstdCompressSync === 'function') {
    return { compressSync: (data) => b.Bun!.zstdCompressSync!(data) }
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require('node:zlib') as { zstdCompressSync?: (data: Uint8Array) => Uint8Array }
  return { compressSync: (data) => zlib.zstdCompressSync!(data) }
})()

/**
 * End offset (exclusive) of the first COMPLETE zstd frame in `buf`, or
 * undefined when the buffer holds no full frame. Minimal frame walk: magic +
 * frame header descriptor + (optional windows/dictionary/content size) + blocks
 * (`blockSize` 3-byte headers) until the last-block flag.
 * @param buf - bytes from the start of the log.
 * @returns the frame end offset, or undefined.
 */
export function firstZstdFrameEnd(buf: Uint8Array): number | undefined {
  if (buf.length < 5) return undefined
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0, true) !== ZSTD_MAGIC) return undefined
  let offset = 4
  const descriptor = view.getUint8(offset)
  offset += 1
  if ((descriptor & 0x18) !== 0) return undefined // reserved bits
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const dictionaryFlag = descriptor & 0x03
  if (!singleSegment) offset += 1 // window descriptor
  offset += dictionaryFlag === 3 ? 4 : dictionaryFlag
  // Frame_Content_Size: present when the flag is non-zero (2/4/8 bytes), and a
  // single-segment frame with flag 0 carries a 1-byte size (zstd spec).
  offset += singleSegment && contentSizeFlag === 0 ? 1 : ([0, 2, 4, 8][contentSizeFlag] ?? 0)
  // Blocks: 3-byte header (last-block bit + type + size).
  for (;;) {
    if (offset + 3 > buf.length) return undefined
    const header = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
    const last = (header & 0x01) !== 0
    const type = (header >>> 1) & 0x03
    const size = header >>> 3
    offset += 3
    if (type === 0x03) return undefined // reserved block type
    // RLE blocks carry ONE repeated byte (size is the repeat count), raw and
    // compressed blocks carry `size` bytes.
    offset += type === 0x01 ? 1 : size
    if (offset > buf.length) return undefined
    if (last) break
  }
  return offset
}

/** Read + decode the head of one persisted session log and fold its facts.
 *  Bounded by {@link HEAD_PROBE_BYTES} and the first complete zstd frame, so a
 *  26 MB log costs the same as a small one.
 *  @param cwd - the session's working directory (project key).
 *  @param id - the session id.
 *  @param maxBytes - head bytes to read (test/limit hook).
 *  @returns the facts, or undefined when the log cannot be read/decoded. */
export function probeSessionHead(cwd: string, id: string, maxBytes = HEAD_PROBE_BYTES): SessionHeadFacts | undefined {
  try {
    const dir = sessionDir(cwd, id as never)
    for (const name of ['session.jsonl.zstd', 'session.jsonl'] as const) {
      const path = join(dir, name)
      let size = 0
      try {
        size = statSync(path).size
      } catch {
        continue
      }
      const take = Math.min(size, maxBytes)
      const buf = Buffer.allocUnsafe(take)
      const fd = openSync(path, 'r')
      let read = 0
      try {
        read = readSync(fd, buf, 0, take, 0)
      } finally {
        closeSync(fd)
      }
      const head = buf.subarray(0, read)
      if (name.endsWith('.zstd')) {
        const end = firstZstdFrameEnd(head)
        if (end === undefined) return undefined // no complete frame in the head
        const jsonl = zstdDecompress(head.subarray(0, end))
        if (jsonl === undefined) return undefined
        return foldSessionHead(jsonl, end >= size)
      }
      return foldSessionHead(head.toString('utf8'), read >= size)
    }
  } catch {
    /* unreadable log → caller falls back to a full inspection */
  }
  return undefined
}

/** Decompress one complete zstd frame (Bun's codec, falling back to zlib). */
function zstdDecompress(frame: Uint8Array): string | undefined {
  try {
    const b = globalThis as { Bun?: { zstdDecompressSync?: (data: Uint8Array) => Uint8Array } }
    const out = typeof b.Bun?.zstdDecompressSync === 'function'
      ? b.Bun.zstdDecompressSync(frame)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      : (require('node:zlib') as { zstdDecompressSync: (data: Uint8Array) => Uint8Array }).zstdDecompressSync(frame)
    return Buffer.from(out).toString('utf8')
  } catch {
    return undefined
  }
}

/** Facts folded from a decoded log head. */
export interface SessionHeadFacts {
  /** True when no `turn/start` appeared in the probed prefix (web blank rule). */
  readonly blank: boolean
  /** Session title, when a `session/title` event landed inside the prefix. */
  readonly title?: string
  /** Whether the prefix covers enough of the log for `blank` to be trusted. */
  readonly confident: boolean
}

/**
 * Fold one decoded JSONL prefix into {@link SessionHeadFacts}.
 * @param jsonl - decoded head text (may end mid-record).
 * @param eof - the prefix reached the end of the file (everything was read).
 * @returns the folded facts.
 */
export function foldSessionHead(jsonl: string, eof: boolean): SessionHeadFacts {
  let blank = true
  let title: string | undefined
  const lines = jsonl.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('{') === false) continue
    // Cheap substring checks first: parsing every record of a 128 KB head is
    // unnecessary when neither marker appears in it.
    if (trimmed.includes('"turn/start"')) { blank = false; continue }
    if (title === undefined && trimmed.includes('"session/title"')) {
      try {
        const parsed = JSON.parse(trimmed) as { type?: string; data?: { title?: unknown } }
        const candidate = parsed.data?.title
        if (parsed.type === 'session/title' && typeof candidate === 'string' && candidate.trim() !== '') title = candidate
      } catch { /* a torn last line is expected; ignore it */ }
    }
  }
  const decodedBytes = jsonl.length
  return { blank, ...(title === undefined ? {} : { title }), confident: eof || decodedBytes >= HEAD_PROBE_MIN_JSONL }
}
