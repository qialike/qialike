/**
 * The turn-tail "Files changed" row and its fold.
 *
 * The rules are copied from the harness's browser plugin
 * (`@deepseek-ai/dsh-client-ui-deliverables`: `mutationPath`,
 * `deliverablesDefinition`, `producedForClosing`) — these tests pin them so a
 * later edit cannot quietly widen or narrow what counts as a written file.
 *
 * Run with `bun test tests/files-changed.test.ts`.
 *
 * @module qialike/files-changed-test
 */
import { describe, expect, test } from 'bun:test'
import {
  FILES_CHANGED_LABEL,
  FILES_CHANGED_SHOWN,
  FilesChangedLedger,
  filesChangedLine,
  mutationPath,
} from '../packages/qialike-app/src/files-changed.ts'

describe('mutationPath: which tool calls wrote a file', () => {
  test('write counts only with a string body and a usable path', () => {
    expect(mutationPath('write', JSON.stringify({ file_path: 'src/a.ts', content: '' }))).toBe('src/a.ts')
    // A path is kept EXACTLY as spelled (no normalization).
    expect(mutationPath('write', JSON.stringify({ file_path: './a/../b.ts', content: 'x' }))).toBe('./a/../b.ts')
    expect(mutationPath('write', JSON.stringify({ file_path: 'src/a.ts' }))).toBeNull()
    expect(mutationPath('write', JSON.stringify({ file_path: '   ', content: 'x' }))).toBeNull()
    expect(mutationPath('write', JSON.stringify({ file_path: 42, content: 'x' }))).toBeNull()
  })

  test('edit needs a real change (old !== new, both strings)', () => {
    const ok = { file_path: 'a.md', old_string: 'x', new_string: 'y' }
    expect(mutationPath('edit', JSON.stringify(ok))).toBe('a.md')
    // Deleting text is a change too (empty new_string), and replace_all is optional.
    expect(mutationPath('edit', JSON.stringify({ ...ok, new_string: '', replace_all: true }))).toBe('a.md')
    expect(mutationPath('edit', JSON.stringify({ ...ok, new_string: 'x' }))).toBeNull()
    expect(mutationPath('edit', JSON.stringify({ ...ok, old_string: '' }))).toBeNull()
    expect(mutationPath('edit', JSON.stringify({ ...ok, replace_all: 'yes' }))).toBeNull()
    expect(mutationPath('edit', JSON.stringify({ file_path: 'a.md', new_string: 'y' }))).toBeNull()
  })

  test('str_replace_editor counts only for its mutating commands', () => {
    expect(mutationPath('str_replace_editor', JSON.stringify({ path: 'a.ts', command: 'create', file_text: '' }))).toBe('a.ts')
    expect(mutationPath('str_replace_editor', JSON.stringify({ path: 'a.ts', command: 'str_replace', old_str: 'x' }))).toBe('a.ts')
    expect(mutationPath('str_replace_editor', JSON.stringify({ path: 'a.ts', command: 'insert', insert_line: 0, new_str: 'x' }))).toBe('a.ts')
    // `view` reads; malformed args write nothing.
    expect(mutationPath('str_replace_editor', JSON.stringify({ path: 'a.ts', command: 'view' }))).toBeNull()
    expect(mutationPath('str_replace_editor', JSON.stringify({ path: 'a.ts', command: 'create' }))).toBeNull()
    expect(mutationPath('str_replace_editor', JSON.stringify({ path: 'a.ts', command: 'insert', insert_line: -1, new_str: 'x' }))).toBeNull()
    expect(mutationPath('str_replace_editor', JSON.stringify({ command: 'create', file_text: 'x' }))).toBeNull()
  })

  test('every other tool, and malformed input, writes nothing', () => {
    // Shell tools are the important negative: `sed -i` changes a file and the
    // web never lists it (the model must declare it with `present`).
    for (const name of ['bash', 'pwsh', 'read', 'glob', 'grep', 'present', 'apply_patch', 'mcp__fs__write']) {
      expect(mutationPath(name, JSON.stringify({ file_path: 'a.ts', content: 'x', path: 'a.ts' })), name).toBeNull()
    }
    expect(mutationPath('write', undefined)).toBeNull()
    expect(mutationPath('write', 'not json')).toBeNull()
    expect(mutationPath('write', '[1,2]')).toBeNull()
    expect(mutationPath('write', 'null')).toBeNull()
    expect(mutationPath('write', '"a.ts"')).toBeNull()
  })
})

describe('FilesChangedLedger: one turn of successful mutations', () => {
  const call = (l: FilesChangedLedger, turn: number, id: string, name: string, args: unknown): void =>
    l.call(turn, id, name, JSON.stringify(args))

  test('a path is listed only after a SUCCESSFUL result, in event order', () => {
    const l = new FilesChangedLedger()
    call(l, 1, 'c1', 'write', { file_path: 'a.ts', content: 'x' })
    call(l, 1, 'c2', 'edit', { file_path: 'b.ts', old_string: 'x', new_string: 'y' })
    // Only c2 has settled: a call whose result never arrived wrote nothing to
    // report (and `flush` is one-shot, so settling it later cannot resurrect it).
    l.result('c2', false)
    expect(l.flush(1)).toEqual(['b.ts'])
    l.result('c1', false)
    expect(l.flush(1)).toEqual([])

    // Both settled, in event order.
    const both = new FilesChangedLedger()
    call(both, 1, 'c1', 'write', { file_path: 'a.ts', content: 'x' })
    call(both, 1, 'c2', 'write', { file_path: 'b.ts', content: 'x' })
    both.result('c1', false)
    both.result('c2', false)
    expect(both.flush(1)).toEqual(['a.ts', 'b.ts'])
  })

  test('an errored result, an unknown callId and a non-mutation contribute nothing', () => {
    const l = new FilesChangedLedger()
    call(l, 1, 'c1', 'write', { file_path: 'a.ts', content: 'x' })
    call(l, 1, 'c2', 'write', { file_path: 'b.ts', content: 'x' })
    call(l, 1, 'c3', 'bash', { command: 'sed -i s/x/y/ c.ts' })
    l.result('c1', true)          // failed write
    l.result('c2', false)         // ok
    l.result('c3', false)         // shell: not a mutation
    l.result('nope', false)       // never seen
    expect(l.flush(1)).toEqual(['b.ts'])
  })

  test('a file written then edited in the same turn is ONE entry (first-seen order)', () => {
    const l = new FilesChangedLedger()
    call(l, 3, 'c1', 'write', { file_path: 'a.ts', content: 'x' })
    call(l, 3, 'c2', 'write', { file_path: 'b.ts', content: 'x' })
    call(l, 3, 'c3', 'edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })
    for (const id of ['c1', 'c2', 'c3']) l.result(id, false)
    expect(l.flush(3)).toEqual(['a.ts', 'b.ts'])
  })

  test('turns do not leak into each other, and flush is one-shot', () => {
    const l = new FilesChangedLedger()
    call(l, 1, 'c1', 'write', { file_path: 'a.ts', content: 'x' })
    l.result('c1', false)
    call(l, 2, 'c2', 'write', { file_path: 'b.ts', content: 'x' })
    l.result('c2', false)
    expect(l.flush(1)).toEqual(['a.ts'])
    expect(l.flush(1)).toEqual([])              // already handed over
    expect(l.flush(2)).toEqual(['b.ts'])
    // A late result for a flushed turn's call cannot resurrect it.
    l.result('c1', false)
    expect(l.flush(1)).toEqual([])
  })

  test('reset forgets every turn (a session switch starts fresh)', () => {
    const l = new FilesChangedLedger()
    call(l, 1, 'c1', 'write', { file_path: 'a.ts', content: 'x' })
    l.result('c1', false)
    l.reset()
    expect(l.flush(1)).toEqual([])
  })
})

describe('filesChangedLine: the row itself', () => {
  test('names the count, then the paths', () => {
    expect(FILES_CHANGED_LABEL).toBe('Files changed')
    expect(filesChangedLine(['a.ts'])).toBe('Files changed · 1 · a.ts')
    expect(filesChangedLine(['a.ts', 'b/c.md'])).toBe('Files changed · 2 · a.ts, b/c.md')
  })

  test('spells out six paths, then collapses the rest (web SHOWN_LIMIT)', () => {
    expect(FILES_CHANGED_SHOWN).toBe(6)
    const many = Array.from({ length: 9 }, (_, i) => `f${i}.ts`)
    const line = filesChangedLine(many)
    expect(line).toBe(`Files changed · 9 · ${many.slice(0, 6).join(', ')}, +3 more`)
    // Exactly six: no remainder clause.
    expect(filesChangedLine(many.slice(0, 6))).not.toContain('more')
  })
})

/**
 * The RESUME path: `foldHistoryEvents` replays a session log, and the turn-tail
 * row must come out of that fold exactly as it does live.
 *
 * The event shapes below are copied from records a real log carries (verified in
 * `~/.dsh/sessions/.../session.v3.jsonl.zstd`):
 *   tool/call   → {turn, step, callId, name, arguments}
 *   tool/result → {turn, step, message:{source:{kind:'tool',callId}, content:[{isError}]}}
 *   turn/end    → {turn, reason:{kind}}
 * Only the fields the fold reads are filled in.
 */
import { foldHistoryEvents } from '../packages/qialike-app/src/index.tsx'

const call = (turn: number, seq: number, callId: string, name: string, args: unknown): unknown => ({
  type: 'tool/call', seq, time: seq, data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
})
const result = (turn: number, seq: number, callId: string, isError = false): unknown => ({
  type: 'tool/result', seq, time: seq,
  data: {
    turn, step: 1,
    message: {
      source: { kind: 'tool', callId },
      // The real block is a `tool-result` wrapper whose nested content carries
      // the text; `toolResultDisplay` reads `isError` only from this type.
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], isError }],
    },
  },
})
const end = (turn: number, seq: number): unknown => ({ type: 'turn/end', seq, time: seq, data: { turn, reason: { kind: 'completed' } } })

describe('resume replay folds the same row', () => {
  test('a turn that wrote a file gets its tail row, after its own rows', () => {
    const { items } = foldHistoryEvents([
      call(42, 1, 'c1', 'write', { file_path: '/tmp/sum.py', content: 'print(1)' }),
      result(42, 2, 'c1'),
      end(42, 3),
    ] as never)
    const last = items.at(-1)!
    expect(last.kind).toBe('status')
    expect(last.text).toBe('Files changed · 1 · /tmp/sum.py')
  })

  test('an errored or non-mutation call leaves no row at all', () => {
    for (const [name, args, isError] of [
      ['write', { file_path: '/tmp/a.py', content: 'x' }, true],
      ['bash', { command: 'sed -i s/x/y/ /tmp/b.py' }, false],
    ] as const) {
      const { items } = foldHistoryEvents([
        call(7, 1, 'c1', name, args),
        result(7, 2, 'c1', isError),
        end(7, 3),
      ] as never)
      expect(items.filter((i) => i.text.startsWith('Files changed')), name).toHaveLength(0)
    }
  })

  test('a write followed by an edit of the same file is one entry', () => {
    const { items } = foldHistoryEvents([
      call(9, 1, 'c1', 'write', { file_path: 'a.ts', content: 'x' }),
      result(9, 2, 'c1'),
      call(9, 3, 'c2', 'edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
      result(9, 4, 'c2'),
      end(9, 5),
    ] as never)
    expect(items.at(-1)!.text).toBe('Files changed · 1 · a.ts')
  })

  test('two turns leave two rows, each at its own tail', () => {
    const { items } = foldHistoryEvents([
      call(1, 1, 'c1', 'write', { file_path: 'one.ts', content: 'x' }),
      result(1, 2, 'c1'),
      end(1, 3),
      call(2, 4, 'c2', 'write', { file_path: 'two.ts', content: 'x' }),
      result(2, 5, 'c2'),
      end(2, 6),
    ] as never)
    const rows = items.filter((i) => i.text.startsWith('Files changed'))
    expect(rows.map((r) => r.text)).toEqual(['Files changed · 1 · one.ts', 'Files changed · 1 · two.ts'])
    // Each row follows its own turn's tool row (the fold is in event order).
    const toolRows = items.map((i, idx) => (i.kind === 'tool' ? idx : -1)).filter((i) => i >= 0)
    const rowIdx = items.map((i, idx) => (i.text.startsWith('Files changed') ? idx : -1)).filter((i) => i >= 0)
    expect(rowIdx[0]!).toBeGreaterThan(toolRows[0]!)
    expect(rowIdx[1]!).toBeGreaterThan(toolRows[1]!)
  })
})
