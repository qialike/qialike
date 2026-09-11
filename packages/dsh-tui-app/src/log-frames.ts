/**
 * File-backed session-log reader: open a giant session by reading ONLY the frames
 * a viewport needs, instead of materializing every event.
 *
 * Why this exists: the harness's resume is O(events) at ~8 µs/event (measured:
 * 1.47 M events → 11.7 s), and the durable log was ALREADY written as a
 * concatenation of independent zstd frames (one per append flush, the first being
 * exactly the header line). That framing is the seek index `less`/`vim` would
 * want: the frame table is a plain magic scan (~50 ms for 82 k frames) and any
 * suffix of frames decompresses on its own (measured: the last 1 200 frames —
 * 1 914 rows, ~36 k events, including a compaction checkpoint — in 11 ms).
 *
 * So the display path never has to ask the harness for a session at all: it
 * seeks, reads the tail, and pulls older ranges on demand. `seq` is dense and
 * ascending across frames (the harness's own reader asserts
 * `event.seq === events.length`), which is what makes a frame addressable by
 * event range — and what lets us find a frame by bisecting with one small
 * decompress per probe instead of indexing the whole file.
 *
 * @module dsh-tui-app/log-frames
 */

import { decodeLogLine } from './log-row-codec.ts'
import type { DurableEvent } from './log-row-codec.ts'

export type { DurableEvent }

/** Bun is not in the typecheck project's lib set; declare only the surface this
 *  module uses (the build bundles Bun's real implementation). */
interface BunFileLike {
  readonly size: number
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }
}
declare const Bun: {
  file(path: string): BunFileLike
  zstdDecompressSync(data: Uint8Array): Uint8Array
}

const MAGIC = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd])
/** Bytes per scan chunk: the frame scan streams the file instead of loading it. */
const SCAN_CHUNK = 4 * 1024 * 1024

/** Frames per probe window (see {@link SessionLogReader.windowProbe}). */
const WINDOW_PROBE_FRAMES = 256
/** Upper bound for a probe window that keeps finding only fragments. */
const MAX_WINDOW_FRAMES = 16_384

/** Offsets of every zstd frame start, ascending. */
export interface FrameTable {
  /** Byte offset of each frame's magic. */
  readonly offsets: readonly number[]
  /** File size at scan time. */
  readonly size: number
}

/**
 * Scan a file for zstd frame magics without decompressing anything.
 * @param path - the log file.
 * @returns the frame table (offsets ascending; `size` is the scanned byte count).
 */
export async function scanFrameTable(path: string): Promise<FrameTable> {
  const file = Bun.file(path)
  const size = file.size
  const offsets: number[] = []
  let carry = new Uint8Array(0)
  let base = 0
  for (let pos = 0; pos < size; pos += SCAN_CHUNK) {
    const end = Math.min(pos + SCAN_CHUNK, size)
    const chunk = new Uint8Array(await file.slice(pos, end).arrayBuffer())
    const buf = new Uint8Array(carry.length + chunk.length)
    buf.set(carry, 0)
    buf.set(chunk, carry.length)
    const limit = buf.length - 3
    for (let i = 0; i < limit; i++) {
      if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
        offsets.push(base - carry.length + i)
      }
    }
    // Keep the last 3 bytes so a magic split across chunks is still found.
    carry = buf.slice(Math.max(0, buf.length - 3))
    base = end
  }
  return { offsets, size }
}

/** What a frame turned out to hold: an event range, a metadata frame with no
 *  events (the harness REQUIRES frame 0 to be exactly the header line), or
 *  nothing readable (a torn frame from a concurrent append). */
type FrameProbe = readonly [number, number] | 'meta' | null

/**
 * Decode one frame to TEXT (`undefined` when the frame is torn/undecodable).
 *
 * A frame is a BYTE-bounded flush, not a record batch: a JSON record can be split
 * across two frames. So callers must join a run of frames and then split lines —
 * parsing frame by frame silently drops every split record (measured on the real
 * 1.48 M-event log, where that also broke the seq bisection).
 */
function frameText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder().decode(Bun.zstdDecompressSync(bytes))
  } catch {
    return undefined
  }
}

/**
 * Parse the COMPLETE records of one text run.
 *
 * Unterminated edges are dropped on purpose: a leading fragment belongs to the
 * frame before the run, and a trailing one without a closing newline is exactly
 * what an append in flight looks like — counting it would surface a half-written
 * event (and, worse, a bogus "newest event").
 * @param text - one or more frames' decoded text, joined.
 * @returns the parseable events.
 */
function parseRun(text: string): DurableEvent[] {
  const parts = text.split('\n')
  if (!text.endsWith('\n')) parts.pop()
  const out: DurableEvent[] = []
  for (const line of parts) {
    if (line.trim() === '') continue
    for (const event of parseLine(line)) out.push(event)
  }
  return out
}

/**
 * Decode one stored line into the events it represents — the reader's only
 * format-dependent step, delegated to {@link decodeLogLine}.
 *
 * Two layouts exist on disk and the dispatch is by CONTENT, not by the header's
 * version (so a mixed directory and a mid-upgrade session both read):
 * - current writer (v2/v3): one row per event, carrying its own dense `seq`;
 * - historical writer (v0/v1): delta-chunk RUNS packed into `text-chunks` /
 *   `reasoning-chunks` / `tool-call-chunks` rows anchored on `seq0`, where one
 *   row expands to N events with seqs `seq0..seq0+N-1`.
 * A windowed reader must expand the packed runs itself (measured before the
 * frozen decoder existed: hand-parsing for `seq` dropped half the events of a
 * real log and emptied every range that sat inside a run).
 * @param line - one JSONL record.
 * @returns the events (empty for a torn line or a metadata line without events).
 */
function parseLine(line: string): DurableEvent[] {
  return decodeLogLine(line)
}

/**
 * A seekable reader over one session log.
 *
 * Reads are bounded by the requested event range: the frame covering a `seq` is
 * found by bisecting the frame table with a single small decompress per probe
 * (frames are ~350 B), and only the covering frames are decompressed.
 */
export class SessionLogReader {
  private table: Promise<FrameTable> | undefined
  /** Sparse cache of probed frames (see {@link FrameProbe}). */
  private readonly probed = new Map<number, FrameProbe>()
  /** Cached window probes (index → probe), see {@link windowProbe}. */
  private readonly windows = new Map<number, FrameProbe>()
  /** Ranges whose start was moved to the next safe boundary (see `adjustSafe`). */
  private readonly adjustedEnds = new Map<number, number>()

  /**
   * @param path - the session log file.
   */
  constructor(private readonly path: string) {}

  /** Diagnostic view of one frame's probe (used by probes and tests). */
  async frameInfo(index: number): Promise<FrameProbe> {
    return await this.frameSeqRange(await this.frames(), index)
  }

  /** The frame table (scanned once, cached). */
  async frames(): Promise<FrameTable> {
    this.table ??= scanFrameTable(this.path)
    return await this.table
  }

  /** Drop the cached table so the next read sees frames appended meanwhile. */
  invalidate(): void {
    this.table = undefined
    this.probed.clear()
    this.windows.clear()
  }

  /** Read the byte slice of one frame. */
  private async frameBytes(table: FrameTable, index: number): Promise<Uint8Array> {
    const start = table.offsets[index]!
    const end = index + 1 < table.offsets.length ? table.offsets[index + 1]! : table.size
    return new Uint8Array(await Bun.file(this.path).slice(start, end).arrayBuffer())
  }

  /** Probe one frame: its event seq range, `'meta'`, or `null` when unreadable. */
  private async frameSeqRange(table: FrameTable, index: number): Promise<FrameProbe> {
    const cached = this.probed.get(index)
    if (cached !== undefined) return cached
    const text = frameText(await this.frameBytes(table, index))
    if (text === undefined) {
      this.probed.set(index, null)
      return null
    }
    // A frame that starts mid-record carries a fragment as its first line; borrow
    // the next frame's text so the first COMPLETE record is seen.
    let run = text
    let events = parseRun(run)
    const firstLine = run.split('\n')[0] ?? ''
    if (events.length === 0 || parseLine(firstLine).length === 0) {
      const next = index + 1 < table.offsets.length ? frameText(await this.frameBytes(table, index + 1)) : undefined
      if (next !== undefined) {
        run = text + next
        events = parseRun(run)
      }
    }
    // No complete record at all: metadata (the header frame is exactly that) —
    // NOT corruption; only an undecodable frame is torn.
    const probe: FrameProbe = events.length === 0
      ? 'meta'
      : [events[0]!.seq, events[events.length - 1]!.seq]
    this.probed.set(index, probe)
    return probe
  }

  /** The end byte offset of frame `index` (the file size for the last frame). */
  private frameEnd(table: FrameTable, index: number): number {
    return index + 1 < table.offsets.length ? table.offsets[index + 1]! : table.size
  }

  /**
   * Decode frames `[from, to)` as ONE text run, in a single byte read.
   * @param table - the frame table.
   * @param from - first frame index (inclusive).
   * @param to - last frame index (exclusive).
   * @returns the joined decoded text.
   */
  private async readWindowText(table: FrameTable, from: number, to: number): Promise<string> {
    const startByte = table.offsets[from]!
    const endByte = this.frameEnd(table, to - 1)
    const bytes = new Uint8Array(await Bun.file(this.path).slice(startByte, endByte).arrayBuffer())
    let text = ''
    for (let index = from; index < to; index++) {
      const part = frameText(bytes.subarray(table.offsets[index]! - startByte, this.frameEnd(table, index) - startByte))
      if (part !== undefined) text += part
    }
    return text
  }

  /** The first frame whose byte offset is >= `byte`. */
  private async firstFrameAtOrAfter(table: FrameTable, byte: number): Promise<number> {
    let lo = 0
    let hi = table.offsets.length - 1
    let found = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (table.offsets[mid]! >= byte) {
        found = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    return found
  }

  /**
   * Probe a WINDOW of frames: the first and last complete record it holds.
   *
   * A single frame is not a reliable probe: a big packed chunk row (one record
   * carrying thousands of events) can fill a frame entirely, leaving the frame
   * with no complete record of its own — measured on the real 1.48 M-event log,
   * where per-frame probing made the seq bisection miss by thousands of events.
   * A window always contains complete records (unless one record is bigger than
   * the window, which grows until it fits).
   * @param table - the frame table.
   * @param from - first frame of the window.
   * @param stride - how many frames the window spans (grows when it yields none).
   * @returns `[firstSeq, lastSeq]`, `'meta'`, or `null` when unreadable.
   */
  private async windowProbe(table: FrameTable, from: number, stride = WINDOW_PROBE_FRAMES): Promise<FrameProbe> {
    const cached = this.windows.get(from)
    if (cached !== undefined) return cached
    const to = Math.min(from + stride, table.offsets.length)
    const text = await this.readWindowText(table, from, to)
    let events = parseRun(text)
    let probe: FrameProbe
    if (events.length === 0) {
      // One record larger than the window (or metadata): try a bigger window.
      if (to < table.offsets.length && stride < MAX_WINDOW_FRAMES) {
        this.windows.delete(from)
        return await this.windowProbe(table, from, stride * 4)
      }
      probe = 'meta'
    } else {
      probe = [events[0]!.seq, events[events.length - 1]!.seq]
    }
    this.windows.set(from, probe)
    return probe
  }

  /**
   * The first frame index whose window could hold `seq` — the window start to
   * begin streaming from (the caller filters by seq, so a window that starts a
   * little early costs nothing).
   * @param seq - the event sequence to locate.
   * @returns the frame index, or -1 when the log holds no such event.
   */
  private async frameFor(table: FrameTable, seq: number): Promise<number> {
    let lo = 0
    let hi = table.offsets.length - 1
    let candidate = -1
    while (lo <= hi) {
      const mid = lo + Math.floor((hi - lo) / 2 / WINDOW_PROBE_FRAMES) * WINDOW_PROBE_FRAMES
      const probe = await this.windowProbe(table, mid)
      if (probe === null) {
        hi = mid - 1
        continue
      }
      if (probe === 'meta' || probe[1] < seq) {
        lo = mid + WINDOW_PROBE_FRAMES
      } else {
        candidate = mid
        hi = mid - 1
      }
      if (hi - lo < WINDOW_PROBE_FRAMES && lo > hi) break
      if (lo > hi) break
    }
    return candidate
  }

  /** The last frame holding events (torn tail / metadata frames are skipped). */
  private async lastEventFrame(table: FrameTable): Promise<number> {
    for (let i = table.offsets.length - 1; i >= 0; i--) {
      const probe = await this.frameSeqRange(table, i)
      if (probe !== null && probe !== 'meta') return i
    }
    return -1
  }

  /** Total durable events (last seq + 1); 0 when nothing is readable. */
  async totalEvents(): Promise<number> {
    const table = await this.frames()
    const last = await this.lastEventFrame(table)
    if (last < 0) return 0
    // The newest frame may end mid-record: join it with its predecessor so the
    // last COMPLETE record (the true event count) is seen.
    const start = last > 0 ? last - 1 : last
    let text = ''
    for (let index = start; index <= last; index++) {
      const part = frameText(await this.frameBytes(table, index))
      if (part !== undefined) text += part
    }
    const events = parseRun(text)
    const newest = events[events.length - 1]
    if (newest !== undefined) return newest.seq + 1
    const probe = await this.frameSeqRange(table, last)
    return probe === null || probe === 'meta' ? 0 : probe[1] + 1
  }

  /** The header record: frame 0 is required to be exactly one header line. */
  async header(): Promise<Record<string, unknown> | undefined> {
    const table = await this.frames()
    const text = frameText(await this.frameBytes(table, 0))
    if (text === undefined) return undefined
    const line = text.split('\n')[0]
    if (line === undefined || line.trim() === '') return undefined
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  /**
   * Read every event with `from <= seq < to`, decompressing only the frames that
   * cover that range.
   * @param from - inclusive first seq.
   * @param to - exclusive last seq.
   * @returns the events, ascending by seq.
   */
  async read(from: number, to: number): Promise<DurableEvent[]> {
    if (to <= from) return []
    const table = await this.frames()
    const startFrame = await this.frameFor(table, from)
    if (startFrame < 0) return []
    const out: DurableEvent[] = []
    // Frames join into ONE JSONL stream. Read a byte window per step (a syscall
    // per frame would dominate: ~350 B frames) and carry the unterminated tail
    // across windows so a record split at any boundary is parsed whole.
    let carry = ''
    let index = startFrame
    const WINDOW_FRAMES = 4_096
    while (index < table.offsets.length) {
      const stop = Math.min(index + WINDOW_FRAMES, table.offsets.length)
      const text = await this.readWindowText(table, index, stop)
      const lines = (carry + text).split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        for (const event of parseLine(line)) {
          if (event.seq < from) continue
          if (event.seq >= to) return out
          out.push(event)
        }
      }
      if (stop === index) break
      index = stop
    }
    return out
  }

  /**
   * Read the newest events, walking frames BACKWARDS until at least `minEvents`
   * events are covered — the "viewport" read: its cost follows the viewport, not
   * the log.
   * @param minEvents - how many events the caller needs (at least).
   * @returns the events and the seq they start at.
   */
  async readTail(minEvents: number): Promise<{ events: DurableEvent[]; startSeq: number; total: number }> {
    const table = await this.frames()
    const last = await this.lastEventFrame(table)
    if (last < 0) return { events: [], startSeq: 0, total: 0 }
    const total = await this.totalEvents()
    if (total === 0) return { events: [], startSeq: 0, total: 0 }
    // One byte window, sized from the file's OWN density (bytes per event) so a
    // small tail of a small log does not read the whole file — a fixed 64 KB
    // window did exactly that (measured: a 5 000-event log returned all 5 000).
    const density = table.size / total
    const window = Math.min(Math.max(8 * 1024, Math.ceil((minEvents + 256) * density * 1.3)), 8 * 1024 * 1024)
    let fromIndex = await this.firstFrameAtOrAfter(table, Math.max(0, table.size - window))
    let run = parseRun(await this.readWindowText(table, fromIndex, last + 1))
    let span = total - (run[0]?.seq ?? total)
    if (span < minEvents && fromIndex > 0) {
      // Correct once from what the first read actually bought (density varies with
      // packed rows, which carry thousands of events in one record).
      const bytesPerEvent = (table.size - table.offsets[fromIndex]!) / Math.max(1, span)
      const want = Math.ceil((minEvents + 256) * bytesPerEvent * 1.3)
      fromIndex = await this.firstFrameAtOrAfter(table, Math.max(0, table.size - want))
      run = parseRun(await this.readWindowText(table, fromIndex, last + 1))
      span = total - (run[0]?.seq ?? total)
    }
    const startSeq = run.length > 0 ? run[0]!.seq : total
    return { events: run, startSeq, total }
  }
}
