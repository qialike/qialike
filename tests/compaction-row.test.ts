import { describe, expect, test } from 'bun:test'
import {
  Store,
  compactionCheckpointSummary,
  compactionRowHeader,
  isCompactionCheckpoint,
  formatCompactTokens,
  type CompactionRowFacts,
} from '../packages/dsh-tui-app/src/index.tsx'

/** A real checkpoint message body, framed exactly like the harness writes it
 *  (`CHECKPOINT_PREAMBLE` + `<compacted-summary>…</compacted-summary>`). */
const CHECKPOINT = [
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it.',
  '',
  '<compacted-summary>',
  '## Primary Request and Intent',
  '- ship the compaction row',
  '</compacted-summary>',
].join('\n')

describe('compaction checkpoint detection', () => {
  test('the harness marker is plugin provenance named compact', () => {
    expect(isCompactionCheckpoint({ kind: 'plugin', plugin: 'compact' })).toBe(true)
    // The generic context injections must NOT become compaction rows.
    expect(isCompactionCheckpoint({ kind: 'plugin', plugin: 'dsh-system-prompt' })).toBe(false)
    expect(isCompactionCheckpoint({ kind: 'user' })).toBe(false)
    expect(isCompactionCheckpoint(undefined)).toBe(false)
  })
})

describe('checkpoint summary extraction', () => {
  test('takes the framed block, not the preamble', () => {
    const summary = compactionCheckpointSummary(CHECKPOINT)
    expect(summary).toBe('## Primary Request and Intent\n- ship the compaction row')
    expect(summary).not.toContain('automatically generated checkpoint')
  })

  test('an unterminated frame keeps what is there (truncated log)', () => {
    expect(compactionCheckpointSummary('<compacted-summary>\npartial')).toBe('partial')
  })

  test('no frame (or an empty one) reads as unavailable', () => {
    expect(compactionCheckpointSummary('just a context injection')).toBeUndefined()
    expect(compactionCheckpointSummary('<compacted-summary>\n\n  \n</compacted-summary>')).toBeUndefined()
  })
})

describe('compaction row header', () => {
  const counted: CompactionRowFacts = { items: 322, tokens: 173_507, provider: 'deepseek-official', model: 'deepseek-v4-flash' }

  test('collapsed and expanded differ only by the disclosure mark', () => {
    expect(compactionRowHeader(counted, false)).toBe('+ Compaction · Compacted 322 history items (~173.5k tokens)')
    expect(compactionRowHeader(counted, true)).toBe('- Compaction · Compacted 322 history items (~173.5k tokens)')
  })

  test('counts degrade honestly when the log lacks them', () => {
    expect(compactionRowHeader({ items: 12 }, false)).toBe('+ Compaction · Compacted 12 history items')
    expect(compactionRowHeader({ summary: 'x' }, false)).toBe('+ Compaction · older history folded into a summary')
    expect(compactionRowHeader({}, false)).toBe('+ Compaction · older history folded (summary not in this log)')
  })

  test('one line, always (the row is a transcript row)', () => {
    for (const facts of [counted, { items: 12 }, { summary: 'x' }, {}]) {
      expect(compactionRowHeader(facts, false)).not.toContain('\n')
    }
    expect(formatCompactTokens(173_507)).toBe('173.5k')
  })
})

describe('Store compaction rows', () => {
  test('appendCompaction keeps the summary as the row text and the facts for the renderer', () => {
    const store = new Store()
    store.appendCompaction({ summary: '## summary', items: 322, tokens: 173_507 })
    const items = store.getItems()
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('compaction')
    expect(items[0]?.text).toBe('## summary')
    expect(items[0]?.compaction).toEqual({ summary: '## summary', items: 322, tokens: 173_507 })
  })

  test('a checkpoint without a readable summary still produces a row', () => {
    const store = new Store()
    store.appendCompaction({ items: 5 })
    expect(store.getItems()[0]?.compaction?.summary).toBeUndefined()
    expect(compactionRowHeader(store.getItems()[0]!.compaction!, false))
      .toBe('+ Compaction · Compacted 5 history items')
  })

  test('/think counts compaction rows among the detail rows it flips', () => {
    const store = new Store()
    store.appendCompaction({ summary: '## summary', items: 3, tokens: 10 })
    store.append('assistant', 'hello')
    store.toggleAllDetail() // show all → flash reports the affected rows
    expect(store.statusFlash?.text).toBe('details: show all (1 rows)')
    // The per-row override map carries the checkpoint row's disclosure, which
    // is what the renderer and the row/geometry mirror both read.
    const key = store.getItems()[0]!.key
    expect(store.isToolExpanded(key)).toBe(true)
    store.toggleToolExpanded(key)
    expect(store.isToolExpanded(key)).toBe(false)
  })
})
