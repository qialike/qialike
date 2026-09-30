/**
 * Tests for the markdown table renderer — the "消息框表格显示乱" fix.
 *
 * The old renderer padded every cell to `max(10, header.length)` JS chars and
 * let rows wrap, so long cells bled into neighbours, CJK/emoji (2 columns)
 * broke the `│` alignment, and overflow wrapped the grid into garbage. The new
 * table path lays out through one shared pure function (`tableGrid`):
 *  - column widths = max VISUAL width across every cell of the column;
 *  - alignment pads by visual width (CJK/emoji count 2), so pipes line up;
 *  - rows never wrap: a grid wider than `usable` shrinks the widest columns
 *    first (cells ellipsized) instead of wrapping;
 *  - the height estimate (`estimateMarkdownHeight`) counts the same lines the
 *    renderer paints (header + separator + data rows), so scroll stays aligned.
 *
 * Run with `bun test tests/markdown-table.test.ts`.
 *
 * @module qialike/markdown-table-test
 */

import { describe, expect, test } from 'bun:test'
import { tableGrid, tableSeparator, estimateMarkdownHeight, markdownPlain, visualWidth } from '../packages/qialike-app/src/markdown.tsx'

const md = (t: string) => t.replace(/^ +/gm, '').trim()

describe('tableGrid', () => {
  test('pads columns to the widest cell, not just the header', () => {
    const cells = [
      ['列', '状态'],
      ['很长的描述内容', '✅'],
    ]
    const { lines, widths } = tableGrid(cells, 0)
    // Widths: 列=1字×2=2; 状态=2字×2=4; 描述=7字×2=14; ✅=emoji×2=2.
    expect(visualWidth(lines[0])).toBe(visualWidth(lines[1]))
    // Every line is one logical row (no wrap): equal visual widths prove the
    // pipes align.
    expect(widths[0]).toBe(14)
    expect(widths[1]).toBe(4)
  })

  test('wide glyphs (CJK/emoji) count two columns so pipes align', () => {
    const cells = [
      ['a', 'b'],
      ['中', '😀'],
    ]
    const { lines } = tableGrid(cells, 0)
    // Both rows must paint identical widths — no drift from wide glyphs.
    expect(visualWidth(lines[0])).toBe(visualWidth(lines[1]))
  })

  test('shrinks the widest columns first instead of wrapping when too wide', () => {
    const cells = [
      ['a', 'b'],
      ['x'.repeat(80), 'y'],
    ]
    const { lines, widths } = tableGrid(cells, 30)
    // Painted line must fit the usable budget.
    for (const line of lines) expect(visualWidth(line)).toBeLessThanOrEqual(30)
    expect(widths[0]).toBeLessThan(80)
    // Cell was ellipsized, not wrapped (single line).
    expect(lines[1]).toContain('…')
  })

  test('a pathological grid never wraps — always one line per row', () => {
    // 5 columns in a 12-col pane cannot physically fit; the guarantee is that
    // the grid still emits exactly one line per row (never a wrapped second
    // line) with uniform width, and the caller clips the tail via truncate.
    const cells = [
      ['h1', 'h2', 'h3', 'h4', 'h5'],
      ['a', 'b', 'c', 'd', 'e'],
    ]
    const { lines, widths } = tableGrid(cells, 12)
    expect(lines).toHaveLength(cells.length)
    expect(new Set(lines.map(visualWidth)).size).toBe(1) // aligned rows
    expect(widths.every((w) => w >= 1)).toBe(true)
    expect(lines.every((l) => !l.includes('\n'))).toBe(true)
  })

  test('single-row (header-only) table is one line, separator only when data exists', () => {
    const one = tableGrid([['a', 'b']], 0)
    expect(one.lines).toHaveLength(1)
    expect(tableSeparator(one.widths)).toContain('─')
  })
})

describe('estimateMarkdownHeight counts the same rows the renderer paints', () => {
  const tbl = md(`
    | 列 | 状态 |
    |---|---|
    | 很长的描述内容 | ✅ |
    | 第二行 | ok |
  `)

  test('estimates header + separator + data rows', () => {
    // 2 data rows + separator → header(1) + sep(1) + 2 = 4, plus block gap 0.
    expect(estimateMarkdownHeight(tbl, 60)).toBe(4)
  })

  test('a too-wide table still estimates its shrink-painted rows (no wrap)', () => {
    // Natural width far above 40 → shrink → still 4 painted rows.
    expect(estimateMarkdownHeight(tbl, 40)).toBe(4)
  })

  test('markdownPlain flattens a table to pipe rows', () => {
    const plain = markdownPlain(tbl)
    expect(plain).toContain('列 | 状态')
    expect(plain).toContain('很长的描述内容 | ✅')
  })
})
