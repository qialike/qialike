/**
 * Frozen decoder for the v0/v1 packed chunk-row storage vocabulary.
 *
 * Why a copy lives HERE: the harness removed this vocabulary from its storage
 * layer in the 0.1.5 format rework — `@deepseek-ai/dsh-session/chunk-rows` and
 * `decodeStorageRecord()` are gone, the current writer (v3) stores one event per
 * row, and the replacement (`sessionFormatCatalog.createRestore`) migrates a
 * WHOLE file in order. The logs already on disk were written as v0/v1 though,
 * and the frame reader's whole value is that it reads a *window* of a giant log
 * without materializing the rest. A packed row is self-contained (`seq0` + a
 * member array), so expanding one is stateless and keeps random access alive;
 * a whole-file migration does not. Hence the frozen copy.
 *
 * Semantics are frozen from the harness's
 * `packages/core/session/src/chunk-rows.ts` (dsh-tui's 0.1.2-rc.1 harness): a
 * `text-chunks` / `reasoning-chunks` / `tool-call-chunks` row carries N members
 * anchored on `seq0`/`time0`; member `k` is seq `seq0 + k`, time
 * `time0 + sum(dt[0..k-1])`, and expands to one `assistant/chunk` event whose
 * chunk is a text/reasoning/tool-call delta. Malformed rows throw (corrupt
 * storage must not silently drop a whole run); callers drop them.
 *
 * The current writer needs none of this: a row that carries a numeric `seq` is
 * already one event, whatever the file's header version says — which is why the
 * reader can stay version-agnostic instead of parsing the header first.
 *
 * @module dsh-tui-app/log-row-codec
 */

/** One durable log event, in the shape the harness stores it. */
export interface DurableEvent {
  type: string
  seq: number
  time?: number
  data?: unknown
  [key: string]: unknown
}

/** The packed-run row tags; only these three ever appear in a v0/v1 log. */
const PACKED_TAGS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/** A parsed JSONL record (a JSON object). */
type Row = Record<string, unknown>

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Row, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** Throw the uniform malformed-row diagnostic (mirrors the harness's wording). */
function malformed(tag: string, why: string): never {
  throw new Error(`malformed ${tag} storage row: ${why}`)
}

/** A packed-run row as far as the reader knows it BEFORE validation: the tag is
 *  what makes it a candidate, so the type stays narrow enough for TypeScript's
 *  control flow (a predicate typed as the plain record type would narrow the
 *  negative branch to `never`). */
interface PackedRow extends Row {
  type: string
  seq0: number
  time0: number
  data: Row
}

/** Whether a parsed record is a packed chunk row rather than a session event. */
export function isPackedRow(value: unknown): value is PackedRow {
  return isRecord(value) && typeof value.type === 'string' && PACKED_TAGS.has(value.type)
}

/** Validate the shared run-data fields and the payload/dt arity. */
function validateRunData(tag: string, data: Row, payloadKey: 'texts' | 'args'): string[] {
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    malformed(tag, 'turn/step/index must be numbers')
  }
  const payload = data[payloadKey]
  if (!Array.isArray(payload) || payload.length === 0 || payload.some((entry) => typeof entry !== 'string')) {
    malformed(tag, `${payloadKey} must be a non-empty string array`)
  }
  const dt = data.dt
  if (!Array.isArray(dt) || dt.some((gap) => !Number.isSafeInteger(gap))) {
    malformed(tag, 'dt must be an array of safe integers')
  }
  if (dt.length !== payload.length - 1) {
    malformed(tag, `dt length ${dt.length} does not match ${payload.length} members`)
  }
  return payload as string[]
}

/**
 * Expand one validated packed row into its member events, in order.
 * @param row - the parsed row (already known to carry a packed tag).
 * @returns one `assistant/chunk` event per member.
 * @throws when the row is malformed (corrupt storage).
 */
export function expandPackedRow(row: PackedRow): DurableEvent[] {
  const tag = row.type as string
  if (!hasExactKeys(row, ['type', 'seq0', 'time0', 'data'])) {
    malformed(tag, 'envelope must be exactly {type, seq0, time0, data}')
  }
  const seq0 = row.seq0
  if (typeof seq0 !== 'number' || !Number.isSafeInteger(seq0) || seq0 < 0 || Object.is(seq0, -0)) {
    malformed(tag, 'seq0 must be a non-negative safe integer')
  }
  const time0 = row.time0
  if (typeof time0 !== 'number' || !Number.isSafeInteger(time0)) {
    malformed(tag, 'time0 must be a safe integer')
  }
  const data = row.data
  if (!isRecord(data)) malformed(tag, 'data must be an object')
  let members: string[]
  if (tag === 'tool-call-chunks') {
    const withName = hasExactKeys(data, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args'])
    if (!withName && !hasExactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'])) {
      malformed(tag, 'data must be exactly {turn, step, index, id, name?, dt, args}')
    }
    if (typeof data.id !== 'string' || (withName && typeof data.name !== 'string')) {
      malformed(tag, 'id (and name when present) must be strings')
    }
    members = validateRunData(tag, data, 'args')
  } else {
    if (!hasExactKeys(data, ['turn', 'step', 'index', 'dt', 'texts'])) {
      malformed(tag, 'data must be exactly {turn, step, index, dt, texts}')
    }
    members = validateRunData(tag, data, 'texts')
  }
  // Reconstruction bounds: the encoder only packs members whose seqs/times stay
  // safe integers, so a running value that leaves the safe range is outside any
  // encoder's image (float arithmetic would round it silently).
  if (members.length - 1 > Number.MAX_SAFE_INTEGER - seq0) {
    malformed(tag, 'member seqs must stay safe integers')
  }
  let time = time0 as number
  for (const gap of data.dt as number[]) {
    time += gap
    if (!Number.isSafeInteger(time)) malformed(tag, 'member times must stay safe integers')
  }
  const events: DurableEvent[] = []
  let memberTime = time0 as number
  for (let k = 0; k < members.length; k++) {
    if (k > 0) memberTime += (data.dt as number[])[k - 1] as number
    const chunk = tag === 'text-chunks'
      ? { type: 'text-delta', index: data.index as number, text: members[k] as string }
      : tag === 'reasoning-chunks'
        ? { type: 'reasoning-delta', index: data.index as number, text: members[k] as string }
        : {
            type: 'tool-call-delta',
            index: data.index as number,
            id: data.id as string,
            ...Object.hasOwn(data, 'name') ? { name: data.name as string } : {},
            argumentsDelta: members[k] as string,
          }
    events.push({
      type: 'assistant/chunk',
      seq: seq0 + k,
      time: memberTime,
      data: { turn: data.turn as number, step: data.step as number, chunk },
    })
  }
  return events
}

/**
 * Decode one stored JSONL line into the events it represents.
 *
 * This is the ONLY format-dependent step in the frame reader, and it is
 * deliberately tag-based rather than version-based:
 * - a row carrying a numeric `seq` is one current-format event (v2/v3);
 * - a row tagged `*-chunks` is a packed v0/v1 run and expands to N events;
 * - anything else (the header line, metadata) holds no event slot.
 * @param line - one JSONL record (without its newline).
 * @returns the events in log order (empty for a header/metadata/undecodable line).
 */
export function decodeLogLine(line: string): DurableEvent[] {
  const trimmed = line.trim()
  if (trimmed === '') return []
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!isRecord(value)) return []
  try {
    if (isPackedRow(value)) return expandPackedRow(value)
  } catch {
    // Corrupt storage: drop the row rather than surface a half-run.
    return []
  }
  if (typeof value.seq === 'number') return [value as DurableEvent]
  return []
}
