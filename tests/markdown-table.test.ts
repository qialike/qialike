/**
 * Tests for the markdown table renderer — the "消息框表格显示乱" fix, and the
 * later "表格信息被截断" fix.
 *
 * The old renderer padded every cell to `max(10, header.length)` JS chars and
 * let rows wrap, so long cells bled into neighbours, CJK/emoji (2 columns)
 * broke the `│` alignment, and overflow wrapped the grid into garbage. The new
 * table path lays out through one shared pure function (`tableGrid`):
 *  - column widths = max VISUAL width across every cell of the column;
 *  - alignment pads by visual width (CJK/emoji count 2), so pipes line up;
 *  - a grid wider than `usable` shrinks the widest columns first, and a cell
 *    that still does not fit WRAPS into its column instead of losing its tail
 *    behind an `…`. A column below `MIN_WRAP_COLS` is the exception: wrapping
 *    there would be a wall of 1–2 character lines, which reads worse than the
 *    ellipsis and costs many rows, so that case still ellipsizes;
 *  - the height estimate (`estimateMarkdownHeight`) counts the same lines the
 *    renderer paints (header lines + separator + data lines, wrapped cells
 *    included), so scroll stays aligned.
 *
 * Run with `bun test tests/markdown-table.test.ts`.
 *
 * @module qialike/markdown-table-test
 */

import { describe, expect, test } from 'bun:test'
import { tableGrid, tableSeparator, estimateMarkdownHeight, markdownPlain, visualWidth } from '../packages/qialike-app/src/markdown.tsx'

const md = (t: string) => t.replace(/^ +/gm, '').trim()
/** Every painted line of a grid, header first. */
const flat = (g: { header: string[]; body: string[] }) => [...g.header, ...g.body]

describe('tableGrid', () => {
  test('pads columns to the widest cell, not just the header', () => {
    const cells = [
      ['列', '状态'],
      ['很长的描述内容', '✅'],
    ]
    const { header, body, widths } = tableGrid(cells, 0)
    // Widths: 列=1字×2=2; 状态=2字×2=4; 描述=7字×2=14; ✅=emoji×2=2.
    expect(visualWidth(header[0])).toBe(visualWidth(body[0]))
    // Nothing had to shrink at usable=0, so each row is one line and equal
    // visual widths prove the pipes align.
    expect(widths[0]).toBe(14)
    expect(widths[1]).toBe(4)
  })

  test('wide glyphs (CJK/emoji) count two columns so pipes align', () => {
    const cells = [
      ['a', 'b'],
      ['中', '😀'],
    ]
    const lines = flat(tableGrid(cells, 0))
    // Both rows must paint identical widths — no drift from wide glyphs.
    expect(visualWidth(lines[0])).toBe(visualWidth(lines[1]))
  })

  test('wraps an over-wide cell into its column instead of ellipsizing it', () => {
    const cells = [
      ['a', 'b'],
      ['x'.repeat(80), 'y'],
    ]
    const g = tableGrid(cells, 30)
    const lines = flat(g)
    // Painted line must fit the usable budget.
    for (const line of lines) expect(visualWidth(line)).toBeLessThanOrEqual(30)
    expect(g.widths[0]).toBeLessThan(80)
    // The cell's content survives, spread over the wrapped lines — the point of
    // the fix: it used to end at an `…`.
    expect(lines.join('\n')).not.toContain('…')
    expect(lines.join('').split('x').length - 1).toBe(80)
    expect(g.body.length).toBeGreaterThan(1)
  })

  test('a wrapped row pads its other columns so the pipes stay in column', () => {
    const cells = [
      ['项', '现状'],
      ['风险何时出现', '你部署 qialike 站点（nginx/node 容器）之后 —— 那时才暴露'],
    ]
    const g = tableGrid(cells, 40)
    // The second column wrapped, so this row painted more than one line.
    expect(g.body.length).toBeGreaterThan(1)
    // The wrapped cell's continuation line leaves the other column BLANK — real
    // spaces padded to its width, not a shifted row.
    expect(g.body[1].slice(2, 2 + g.widths[0]).trim()).toBe('')
    // Which is what keeps every `│` in the same VISUAL column on every painted
    // line, wrapped or not. Measured in columns, not JS indices: a CJK cell is
    // two columns per character while its continuation is spaces, so an
    // `indexOf` comparison would "fail" while the pipes line up perfectly.
    const dividerCol = flat(g).map((line) => visualWidth(line.slice(0, line.indexOf('│', 1))))
    expect(new Set(dividerCol).size).toBe(1)
    expect(new Set(flat(g).map(visualWidth)).size).toBe(1)
  })

  test('a grid too narrow to wrap falls back to one ellipsized line per row', () => {
    // 5 columns in a 12-col pane cannot physically fit, and every column is
    // squeezed below MIN_WRAP_COLS. The guarantee is one painted line per
    // logical row (never a wrapped second line) with uniform width, and the
    // caller clips the tail — wrapping at 1–2 columns would be worse.
    const cells = [
      ['h1', 'h2', 'h3', 'h4', 'h5'],
      ['a', 'b', 'c', 'd', 'e'],
    ]
    const { header, body, widths } = tableGrid(cells, 12)
    expect(header).toHaveLength(1)
    expect(body).toHaveLength(1)
    expect(new Set(flat({ header, body }).map(visualWidth)).size).toBe(1) // aligned
    expect(widths.every((w) => w >= 1)).toBe(true)
    expect(flat({ header, body }).every((l) => !l.includes('\n'))).toBe(true)
  })

  test('single-row (header-only) table is one line, separator only when data exists', () => {
    const one = tableGrid([['a', 'b']], 0)
    expect(one.header).toHaveLength(1)
    expect(one.body).toHaveLength(0)
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

  test('a table that fits its budget needs no extra lines', () => {
    // The grid's natural width is 25, so 40 columns still paints 4 rows.
    expect(estimateMarkdownHeight(tbl, 40)).toBe(4)
  })

  test('a table squeezed until a cell wraps counts the wrapped lines', () => {
    // At 20 columns the first column shrinks to 9 and 很长的描述内容 (14 wide)
    // wraps onto two painted lines: header(1) + sep(1) + body(2 + 1) = 5. The
    // estimate has to follow, or the transcript's scroll height drifts — the
    // very bug this pairing exists to prevent.
    expect(estimateMarkdownHeight(tbl, 20)).toBe(5)
  })

  test('markdownPlain flattens a table to pipe rows', () => {
    // The plain-text path is independent of the grid (it never wraps), so
    // copying a message keeps the full cell text either way.
    const plain = markdownPlain(tbl)
    expect(plain).toContain('列 | 状态')
    expect(plain).toContain('很长的描述内容 | ✅')
  })
})
