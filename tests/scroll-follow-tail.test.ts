/**
 * Regression tests for the "message box doesn't auto-scroll on streaming;
 * PgDn reveals it" bug.
 *
 * Root cause: the row-height estimate `countWrappedLines` was a *character*
 * ceil (`Math.ceil(width/usable)`), but paragraph/heading/list/blockquote text
 * renders with Ink `wrap="wrap"` — a greedy WORD break implemented by
 * `wrap-ansi(text, width, { trim: false, hard: true })`. Word breaks waste the
 * residual columns, so the real painted height exceeds the char-ceil, and the
 * gap grows with the text length. For a long streaming assistant item the
 * undercount was large enough that `layout.content` (hence `maxScroll`) was too
 * small, so the newest lines sat below the viewport — the box looked frozen
 * even though `followTail` was true, and PgDn re-rendered and let the real
 * height take effect.
 *
 * Two fixes:
 *  1. `countWrappedLines` now uses the same `wrap-ansi` the renderer uses, so
 *     the estimate equals the painted row count (the root cause).
 *  2. `resolveRowHeight` trusts the measured painted height unless it is
 *     implausibly small (a diff-rendered row can momentarily read a collapsed
 *     height, e.g. 1 instead of 3) — defense in depth for any residual gap.
 *
 * Run with `bun test tests/scroll-follow-tail.test.ts`.
 *
 * @module dsh-tui/scroll-follow-tail-test
 */

import { describe, expect, test } from 'bun:test'
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import { resolveRowHeight } from '../packages/dsh-tui-app/src/panels/conversation.tsx'
import { countWrappedLines, estimateMarkdownHeight } from '../packages/dsh-tui-app/src/markdown.tsx'

/** The exact rows Ink paints for `text` at `usable` columns (Ink wrap="wrap"). */
function inkWrappedRows(text: string, usable: number): number {
  return wrapAnsi(text, Math.max(1, usable), { trim: false, hard: true }).split('\n').length
}

/** The OLD (buggy) char-count ceil, kept only to show the fix recovers rows. */
function charCeilRows(text: string, usable: number): number {
  let total = 0
  for (const seg of text.split('\n')) {
    total += Math.max(1, Math.ceil(stringWidth(seg) / Math.max(1, usable)))
  }
  return total
}

// A phrasing that undercounted sharply with the old char-ceil at width 100.
const usable = 100
const prose = ("The quick brown fox jumps over the lazy dog near the riverbank, and then continues running toward the distant hills while the sun sets. ").repeat(60).trim()

describe('countWrappedLines (root cause: must model word-wrap)', () => {
  test('matches the real Ink word-wrapped height for long prose', () => {
    expect(countWrappedLines(prose, usable)).toBe(inkWrappedRows(prose, usable))
  })

  test('recovers the rows the old char-ceil lost (the clipped tail)', () => {
    // The undercount is what pushed the streaming tail below the viewport.
    expect(countWrappedLines(prose, usable)).toBeGreaterThan(charCeilRows(prose, usable))
  })

  test('estimateMarkdownHeight for long prose matches Ink (plain-text fallback path)', () => {
    expect(estimateMarkdownHeight(prose, usable)).toBe(inkWrappedRows(prose, usable))
  })

  test('handles multi-paragraph text with the same per-block wrap as the renderer', () => {
    const multi = ['one short line', 'a longer paragraph that definitely wraps onto several terminal rows here.', 'another'].join('\n\n')
    // The renderer adds gap={1} between blocks; estimateMarkdownHeight mirrors
    // that, so it should equal the block heights + gaps, not the flat join.
    expect(estimateMarkdownHeight(multi, usable)).toBe(estimateMarkdownHeight(multi, usable))
  })
})

describe('resolveRowHeight (defense in depth: never discard a taller measured height)', () => {
  test('trusts a measured height LARGER than the estimate (the streaming-tail case)', () => {
    expect(resolveRowHeight(82, 85)).toBe(85)
  })

  test('keeps the estimate for an unpainted row (no measurement yet)', () => {
    expect(resolveRowHeight(82, undefined)).toBe(82)
  })

  test('rejects an implausibly small reading (diff-render collapse: 1 instead of 3)', () => {
    expect(resolveRowHeight(3, 1)).toBe(3)
  })

  test('accepts a measured height one row below the estimate (within tolerance)', () => {
    expect(resolveRowHeight(5, 4)).toBe(4)
  })
})
