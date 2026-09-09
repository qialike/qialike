/**
 * Regression tests for the debounced markdown-height estimate (优化1: a long
 * streaming assistant answer must not re-run the mdast parse on every delta).
 *
 * The per-item estCache is keyed by item OBJECT, and streamText replaces the
 * streaming tail item each delta — without this debounce every delta would
 * re-parse the whole (growing) markdown on the main thread. The debounce is
 * keyed by the stable transcript ROW key and only re-parses once the text has
 * grown past MARKDOWN_REPARSE_GROWTH chars since the last parse; the measured
 * painted height covers the gap, and settlement re-parses once.
 *
 * Run with `bun test tests/markdown-estimate-debounce.test.ts`.
 *
 * @module dsh-tui/markdown-estimate-debounce-test
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { estimateMarkdownHeight } from '../packages/dsh-tui-app/src/markdown.tsx'
import {
  clearMarkdownHeightCache,
  estimateMarkdownHeightDebounced,
  markdownHeightReparseDue,
} from '../packages/dsh-tui-app/src/panels/conversation.tsx'

const W = 40
const GEN = 7

/** Plain single-paragraph markdown: mdast wrap height grows ~linearly with
 *  length, so appending 500 chars ALWAYS changes the line count at W=40. */
const baseText = Array.from({ length: 150 }, () => 'word').join(' ')

describe('estimateMarkdownHeightDebounced', () => {
  beforeEach(() => {
    clearMarkdownHeightCache()
  })

  test('reparse predicate: no entry or growth ≥512 chars', () => {
    expect(markdownHeightReparseDue(undefined, 10)).toBe(true)
    expect(markdownHeightReparseDue(100, 200)).toBe(false) // growth 100 < 512
    expect(markdownHeightReparseDue(100, 611)).toBe(false) // growth 511
    expect(markdownHeightReparseDue(100, 612)).toBe(true) // growth 512
  })

  test('first call parses; small growth reuses the cached line count', () => {
    const key = 1
    const first = estimateMarkdownHeightDebounced(key, baseText, W, GEN)
    expect(first).toBe(estimateMarkdownHeight(baseText, W))

    const grown = baseText + ' extra '.repeat(50) // +300 chars < 512
    const grownLines = estimateMarkdownHeight(grown, W)
    expect(grownLines).not.toBe(first) // would differ if parsed

    // Debounced: reuse the stale (smaller) estimate until growth ≥ threshold.
    expect(estimateMarkdownHeightDebounced(key, grown, W, GEN)).toBe(first)
  })

  test('growth past the threshold re-parses', () => {
    const key = 2
    const big = baseText + ' extra '.repeat(400) // +2400 chars ≥ 512
    expect(estimateMarkdownHeightDebounced(key, big, W, GEN)).toBe(estimateMarkdownHeight(big, W))
  })

  test('a generation change (transcript reload) drops stale entries even for the same key', () => {
    const key = 3
    estimateMarkdownHeightDebounced(key, baseText, W, GEN) // parse at generation 7
    const grown = baseText + ' extra '.repeat(50)
    // Same key reused after a reload: generation 8 must NOT serve the stale
    // line count computed from the old session's text.
    expect(estimateMarkdownHeightDebounced(key, grown, W, GEN + 1)).toBe(estimateMarkdownHeight(grown, W))
  })

  test('clearMarkdownHeightCache forces a re-parse (width change)', () => {
    const key = 4
    const first = estimateMarkdownHeightDebounced(key, baseText, W, GEN)
    clearMarkdownHeightCache()
    const grown = baseText + ' extra '.repeat(50) // < 512 growth
    // Cache gone: even small growth now parses at the (new) width.
    expect(estimateMarkdownHeightDebounced(key, grown, W, GEN)).toBe(estimateMarkdownHeight(grown, W))
    void first
  })
})
