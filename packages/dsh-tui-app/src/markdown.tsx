/**
 * Terminal Markdown renderer for the assistant text, aligned with `dsh web`'s
 * assistant surface (which renders Markdown via a direct mdast pipeline).
 *
 * This renders the mdast produced by `mdast-util-from-markdown` (with the GFM
 * extension) into Ink components. The web supports a full Markdown feature
 * set; a terminal can only style a subset, so unsupported node types
 * (tables beyond a best-effort grid, images, math, footnotes) degrade to their
 * source text rather than being dropped.
 *
 * Streaming: the assistant text grows token by token and the component
 * re-parses/re-renders it live on every delta. The transcript measures an
 * item's height from what is actually rendered, so the display must track the
 * live text (a debounced copy would lag the layout and keep old rows on screen
 * while new content is clipped). Very long text falls back to a plain wrap so a
 * huge code dump never stalls the loop.
 *
 * Coloring policy: headings keep the accent color; a bold label immediately
 * followed by a colon (`**键**: 值`) keeps the secondary color as a field key,
 * and filename/path tokens in body prose keep the secondary color too. All
 * other marks keep their structural styling (bold/italic/strikethrough/
 * underline/inline-code chip) but render in the base text color, and plain
 * prose/paths before a colon are never colored. Think (reasoning) and tool
 * rows render through their own plain paths elsewhere and never receive the
 * file-name coloring.
 *
 * @module @yourname/dsh-tui-app/markdown
 */

import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import { stripTerminalControls } from './terminal-safe.ts'
import { theme } from './theme.ts'

/** Structural subset of mdast the renderer touches (avoids a hard mdast types dependency). */
interface MdNode {
  type: string
  value?: string
  depth?: number
  ordered?: boolean
  start?: number
  checked?: boolean | null
  lang?: string | null
  meta?: string | null
  url?: string
  alt?: string
  title?: string | null
  label?: string
  identifier?: string
  children?: MdNode[]
}

/** Parse `text` into a mdast root; tolerant so streaming partial Markdown never throws. */
function parse(text: string): MdNode {
  try {
    const tree = fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as unknown as MdNode
    return tree
  } catch {
    return { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }] }
  }
}

/** All heading levels share one accent (a single markdown-heading color). */
function headingColor(_depth: number): string {
  return theme.accent
}

/** Known file extensions for prose file-name highlighting. */
const FILE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|yaml|yml|md|markdown|py|sh|bash|css|scss|sass|html|htm|go|rs|c|cpp|cc|h|hpp|txt|zstd|toml|lock|env|xml|svg|png|jpe?g|gif|webp|exe|bin|sql|log|diff|patch|csv|db|sqlite)$/i

/**
 * Color filename/path tokens in one body-prose run with the secondary accent.
 * Scoped to the assistant Markdown body only — Think (reasoning) and tool rows
 * render through their own plain paths in conversation.tsx, not this renderer,
 * so they are never touched here.
 *
 * A token qualifies when it looks like a path (contains a `/` or `\`, no URL
 * `://`, and a leading `~`/`.`/`/` or a file extension or 3+ segments) or ends
 * in a known file extension. Bare numbers, version strings, and Latin
 * abbreviation punctuation (`e.g.`) stay uncolored.
 */
function renderBodyText(text: string): React.ReactNode {
  const out: React.ReactNode[] = []
  const RE = /[A-Za-z0-9_~./\\-]+/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = RE.exec(text)) !== null) {
    let token = m[0]
    // A trailing period after a file name is sentence punctuation, not the
    // file name; pull at most a few off so a name + `.` still matches.
    while (token.endsWith('.') && !FILE_EXT_RE.test(token) && token.length > 1) {
      token = token.slice(0, -1)
    }
    const isPath = (token.includes('/') || token.includes('\\'))
      && !token.includes('://')
      && (token.startsWith('/') || token.startsWith('~/') || token.startsWith('./') || token.startsWith('../')
        || FILE_EXT_RE.test(token) || token.split(/[/\\]/).length > 2)
    const isFile = FILE_EXT_RE.test(token)
    if (isPath || isFile) {
      const start = m.index
      const end = start + m[0].length
      if (start > last) out.push(text.slice(last, start))
      out.push(<Text key={`f${start}`} color={theme.secondary}>{token}</Text>)
      const tail = text.slice(start + token.length, end)
      if (tail !== '') out.push(tail)
      last = end
    }
  }
  if (last < text.length) out.push(text.slice(last))
  return out.length === 0 ? text : out
}

/** Render inline phrasing nodes as React nodes (no newlines). */
function renderInline(node: MdNode, isKey = false): React.ReactNode {
  switch (node.type) {
    case 'text': return renderBodyText(node.value ?? '')
    case 'strong': return <Text bold color={isKey ? theme.secondary : undefined}>{renderInlineChildren(node)}</Text>
    case 'emphasis': return <Text italic>{renderInlineChildren(node)}</Text>
    case 'delete': return <Text strikethrough>{renderInlineChildren(node)}</Text>
    case 'inlineCode': {
      // Chip-less skins (element == bg — e.g. a user theme whose element
      // equals its background) must not paint a background: any tinted block
      // under bare TUI glyphs reads as a dirty text 底纹, not a rounded web
      // chip. Render the code unstyled so it
      // reads exactly like the surrounding body text (the patched frame
      // writer paints unstyled glyphs with the theme text color).
      const chip = theme.element.toLowerCase() !== theme.bg.toLowerCase()
      if (chip) return <Text backgroundColor={theme.element}>{node.value ?? ''}</Text>
      return <Text>{node.value ?? ''}</Text>
    }
    case 'break': return '\n'
    case 'link': return (
      <Text underline>
        {renderInlineChildren(node)}{node.url ? <Text dimColor> ({node.url})</Text> : null}
      </Text>
    )
    case 'image': return <Text dimColor>{`![${node.alt ?? ''}](${node.url ?? ''})`}</Text>
    case 'html': return <Text dimColor>{node.value ?? ''}</Text>
    case 'inlineMath': return <Text dimColor>{node.value ?? ''}</Text>
    case 'footnoteReference': return <Text dimColor>[{node.label ?? '^'}]</Text>
    default: return renderInlineChildren(node) ?? (node.value ? <Text>{node.value}</Text> : null)
  }
}

/** Render a node's inline children, each wrapped in a keyed fragment (avoids React key warnings). */
function renderInlineChildren(node: MdNode): React.ReactNode {
  const kids = node.children ?? []
  if (kids.length === 0) return null
  // A bold label immediately followed by a colon (`**状态**: value`) is a
  // field key: color that bold label with the secondary accent. Any other
  // text-before-colon (prose, paths, code references) stays in the base text
  // color, since it cannot be told apart from a genuine key syntactically.
  return kids.map((child, i) => {
    const next = kids[i + 1]
    const isKey = child.type === 'strong' && next?.type === 'text'
      && /^[:：]/.test((next.value ?? '').trimStart())
    return <React.Fragment key={i}>{renderInline(child, isKey)}</React.Fragment>
  })
}

/** Render a paragraph's inline content as a single wrapped line. */
function renderParagraph(node: MdNode): React.ReactNode {
  return (
    <Text wrap="wrap">{renderInlineChildren(node)}</Text>
  )
}

/** Render a block-level node. `usable` = available text columns (for tables). */
function renderBlock(node: MdNode, key: number | string, usable: number): React.ReactNode {
  switch (node.type) {
    case 'paragraph': return React.createElement(React.Fragment, { key }, renderParagraph(node))
    case 'heading': {
      const depth = node.depth ?? 1
      return (
        <Text key={key} bold color={headingColor(depth)} wrap="wrap">
          {renderInlineChildren(node)}
        </Text>
      )
    }
    case 'blockquote': {
      const kids = node.children ?? []
      // Block children (e.g. code) return a <Box> and must not nest inside a
      // <Text> (Ink throws "<Box> can't be nested inside <Text>"); render each
      // child as a sibling in a column instead.
      return (
        <Box key={key} width="100%" flexDirection="column">
          {kids.map((child, i) => child.type === 'paragraph'
            ? <Text key={`q-${key}-${i}`} wrap="wrap">│ {renderInlineChildren(child)}</Text>
            : renderBlock(child, `${key}-q-${i}`, usable))}
        </Box>
      )
    }
    case 'thematicBreak': return <Text key={key} color={theme.borderSubtle}>─{'─'.repeat(24)}</Text>
    case 'code': {
      const lines = (node.value ?? '').split('\n')
      return (
        // width="100%": a bordered Box shrink-fits to its content unless told
        // to fill; the code frame must span the message content width (aligning
        // with the wrapped text lines and leaving the 4-col right margin).
        <Box key={key} width="100%" borderStyle="round" borderColor={theme.borderSubtle} paddingX={1} flexDirection="column">
          {node.lang ? <Text dimColor>{node.lang}</Text> : null}
          {/* Each code line as its own Text so wrapped lines are counted in the
              box height (a single joined Text overflows the border when wrapping). */}
          {lines.map((line, i) => <Text key={i} color={theme.text} wrap="truncate">{line}</Text>)}
        </Box>
      )
    }
    case 'list': {
      const ordered = node.ordered === true
      const start = node.start ?? 1
      const items = node.children ?? []
      // Same Box-in-Text rule: each item's paragraph content stays in a Text,
      // and non-paragraph block children (e.g. code) render as siblings.
      return (
        <Box key={key} width="100%" flexDirection="column">
          {items.map((item, i) => (
            <Box key={i} width="100%" flexDirection="column">
              <Text wrap="wrap">
                <Text>{ordered ? `${start + i}. ` : '• '}</Text>
                {(item.children ?? []).map((child, j) => child.type === 'paragraph'
                  ? <React.Fragment key={`l-${i}-${j}`}>{renderInlineChildren(child)}</React.Fragment>
                  : null)}
              </Text>
              {(item.children ?? []).map((child, j) => child.type !== 'paragraph'
                ? renderBlock(child, `l-${i}-${j}`, usable)
                : null)}
            </Box>
          ))}
        </Box>
      )
    }
    case 'table': {
      // Grid via the shared tableGrid (visual-width aligned, never wraps);
      // header row bold + a ── separator so the table reads as a structure,
      // not a wall of pipes.
      const cells = (node.children ?? []).map((row: MdNode) =>
        (row.children ?? []).map((cell: MdNode) => inlinePlain(cell)))
      if (cells.length === 0) return null
      const { lines, widths } = tableGrid(cells, usable)
      if (lines.length === 0) return null
      const body = lines.slice(1)
      return (
        <Box key={key} width="100%" flexDirection="column">
          <Text wrap="truncate"><Text bold color={theme.secondary}>{lines[0]}</Text></Text>
          {lines.length > 1
            ? <Text wrap="truncate" color={theme.borderSubtle}>{tableSeparator(widths)}</Text>
            : null}
          {body.map((line, r) => (
            <Text key={r} wrap="truncate">{line}</Text>
          ))}
        </Box>
      )
    }
    case 'image': return <Text key={key} dimColor>{`![${node.alt ?? ''}](${node.url ?? ''})`}</Text>
    case 'definition': case 'footnoteDefinition': return null
    default: {
      const kids = node.children ?? []
      return (
        <Box key={key} width="100%" flexDirection="column">
          {kids.length > 0
            ? kids.map((c, i) => renderBlock(c, `${key}-${i}`, usable))
            : (node.value ? <Text wrap="wrap">{node.value}</Text> : null)}
        </Box>
      )
    }
  }
}

/** Flatten an inline node's children into plain text (soft breaks stay newlines). */
function inlinePlain(node: MdNode): string {
  if (node.type === 'break') return '\n'
  return (node.children ?? []).map(inlinePlain).join('') + (node.value ?? '')
}

/**
 * Reduce an mdast tree to plain text, one logical line per *block* boundary
 * (`\n\n` mimics the renderer's `gap={1}` between blocks). Inline nodes inside
 * a paragraph/heading stay on their own line (the previous version pushed every
 * inline node as its own paragraph, inflating the line count massively).
 * @param text - the Markdown source.
 */
export function markdownPlain(text: string): string {
  const root = parse(text)
  const parts: string[] = []
  for (const block of root.children ?? []) {
    const s = blockPlain(block).trimEnd()
    if (s !== '') parts.push(s)
  }
  return parts.join('\n\n')
}

/** Flatten a block node to plain text (inline nodes stay on their line). */
function blockPlain(node: MdNode): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return inlinePlain(node)
    case 'blockquote':
      return (node.children ?? []).map(blockPlain).join('\n')
    case 'code':
      return (node.value ?? '').trimEnd()
    case 'list':
      return (node.children ?? []).map(blockPlain).join('\n')
    case 'table':
      return (node.children ?? []).map((row) => (row.children ?? []).map(inlinePlain).join(' | ')).join('\n')
    case 'thematicBreak':
      return '─'
    default: {
      const kids = node.children ?? []
      if (kids.length > 0) return kids.map(blockPlain).join('\n')
      return inlinePlain(node)
    }
  }
}

/** Display width of `text` (CJK/emoji count as two columns) — the same rule Ink
 *  uses, via the same `string-width` library, so estimates match rendering. */
export function visualWidth(text: string): number {
  return stringWidth(text)
}

/**
 * Lay out a markdown table (mdast table rows → cell strings) into a grid of
 * aligned terminal lines. Single source of truth for BOTH the renderer and the
 * height estimator, so a table paints exactly as many rows as are counted.
 *
 * Rules:
 *  - column widths are the max VISUAL width (CJK/emoji count 2) across every
 *    cell of that column (not just the header), with a readable floor;
 *  - rows never wrap: when the natural grid is wider than `usable`, the widest
 *    columns are shrunk first (long cells get an ellipsis) until it fits;
 *  - alignment is by visual width, so the `│` separators line up even with
 *    wide glyphs (misaligned pipes are what make a table read as "乱");
 *  - the first row is the header — callers decide how to style it.
 *
 * @param cells - table rows as cell-string rows (rows[0] = header).
 * @param usable - the text columns available (0/undefined → no shrink).
 * @returns `{ lines, widths }` — every row as one pre-padded, non-wrapping
 *          line (with surrounding `│ … │`), and the final column widths.
 */
export function tableGrid(
  cells: string[][],
  usable: number,
): { lines: string[]; widths: number[] } {
  if (cells.length === 0) return { lines: [], widths: [] }
  const colCount = Math.max(...cells.map((r) => r.length), 0)
  if (colCount === 0) return { lines: [], widths: [] }
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - visualWidth(s)))
  const cut = (s: string, w: number) => truncateWide(s, w)
  // Natural visual widths per column.
  const widths: number[] = []
  for (let c = 0; c < colCount; c++) {
    let w = 0
    for (const row of cells) w = Math.max(w, visualWidth(row[c] ?? ''))
    widths.push(Math.max(1, w))
  }
  // Border overhead of the painted line: `│ ` + pads + ` │`.
  const paintW = (ws: number[]) => 2 + ws.reduce((s, w) => s + w, 0) + (ws.length - 1) * 3 + 2
  // Shrink widest columns first until the painted line fits `usable`. The
  // floor of 1 is the last resort: beyond it a pathological grid (many
  // columns in a very narrow pane) simply stays wider than `usable` — the
  // caller's `wrap="truncate"` clips the tail WITHOUT wrapping, so the row
  // count (and the height estimate) never changes.
  if (usable > 0) {
    let budget = usable
    while (widths.length > 0 && paintW(widths) > budget) {
      const widest = widths.indexOf(Math.max(...widths))
      if (widths[widest] <= 1) break // floor reached: caller truncates
      widths[widest] -= 1
    }
  }
  const lines = cells.map((row) => {
    const filled = widths.map((w, c) => cut(row[c] ?? '', w))
    // Pad cells to their column width by VISUAL width; single-line guarantee:
    // cut() above never exceeds w, so the joined line fits its budget.
    return `│ ${filled.map((s, c) => pad(s, widths[c])).join(' │')} │`
  })
  return { lines, widths }
}

/** One dashed separator row for a table header, sized to the column widths. */
export function tableSeparator(widths: number[]): string {
  if (widths.length === 0) return ''
  return `├${widths.map((w) => '─'.repeat(w + 2)).join('┼')}┤`
}

/** Truncate `text` to a visual-width budget, appending an ellipsis when cut
 *  (never splits a surrogate pair or a wide character across the budget). */
export function truncateWide(text: string, maxCols: number): string {
  if (visualWidth(text) <= maxCols) return text
  let used = 0
  let out = ''
  for (const character of text) {
    const width = visualWidth(character)
    if (used + width > maxCols - 1) break
    out += character
    used += width
  }
  return `${out}…`
}

/** Number of terminal rows Ink paints for `text` at `usable` columns.
 *
 *  Paragraph/heading/list/blockquote text renders with Ink `wrap="wrap"`,
 *  which is exactly `wrap-ansi(text, usable, { trim: false, hard: true })` —
 *  a greedy WORD break (characters pack up to the column limit, a word that
 *  would overflow moves to the next row, a word wider than the limit is
 *  hard-broken). A character-count ceil (`Math.ceil(width / usable)`) is NOT
 *  equivalent: it undercounts prose, because word breaks waste the residual
 *  columns and the miss grows with the text length. That undercount fed
 *  `layout.content` (hence `maxScroll`) with too few rows, so the streaming
 *  tail was clipped below the viewport — the "message box doesn't auto-scroll;
 *  PgDn reveals it" bug. Using the same `wrap-ansi` the renderer uses makes the
 *  estimate equal the painted row count.
 * @param text - the text (paragraphs separated by `\n`).
 * @param usable - the wrapped column width.
 * @returns the number of terminal rows Ink will paint. */
export function countWrappedLines(text: string, usable: number): number {
  return wrapAnsi(text, Math.max(1, usable), { trim: false, hard: true }).split('\n').length
}

/**
 * Estimate the rows `MarkdownText` will actually render for `text` at the
 * conversation width. Walks the same mdast tree the renderer uses so the
 * estimate matches the real layout: paragraphs/headings wrap at `usable`,
 * code lines are truncated to one row each (plus border + lang), tables pad
 * cells, and the root `gap={1}` separates blocks.
 * @param text - the Markdown source.
 * @param usable - text columns available for the conversation area.
 */
export function estimateMarkdownHeight(text: string, usable: number): number {
  if (text.length > 8_000) return countWrappedLines(text, usable)
  const root = parse(text)
  const blocks = root.children ?? []
  let rows = 0
  blocks.forEach((block, i) => {
    if (i > 0) rows += 1 // the renderer's root <Box gap={1}> between blocks
    rows += blockRows(block, usable)
  })
  return Math.max(1, rows)
}

/** Rows one block node renders at `usable` columns (mirrors renderBlock). */
function blockRows(node: MdNode, usable: number): number {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return countWrappedLines(inlinePlain(node), usable)
    case 'blockquote': {
      let rows = 0
      for (const child of node.children ?? []) {
        rows += child.type === 'paragraph'
          ? countWrappedLines(`│ ${inlinePlain(child)}`, usable)
          : blockRows(child, usable)
      }
      return rows
    }
    case 'thematicBreak':
      return 1
    case 'code': {
      const lines = (node.value ?? '').split('\n')
      return 2 + (node.lang ? 1 : 0) + lines.length
    }
    case 'list': {
      const ordered = node.ordered === true
      const start = node.start ?? 1
      let rows = 0
      ;(node.children ?? []).forEach((item, i) => {
        const prefix = ordered ? `${start + i}. ` : '• '
        const paras: string[] = []
        for (const child of item.children ?? []) {
          if (child.type === 'paragraph') paras.push(inlinePlain(child))
          else rows += blockRows(child, usable)
        }
        rows += countWrappedLines(prefix + paras.join(''), usable)
      })
      return rows
    }
    case 'table': {
      const cells = (node.children ?? []).map((row) =>
        (row.children ?? []).map((cell) => inlinePlain(cell)))
      if (cells.length === 0) return 0
      const { lines } = tableGrid(cells, usable)
      // Painted rows: header + (separator) + data rows — mirrors the renderer.
      return lines.length + (lines.length > 1 ? 1 : 0)
    }
    case 'image':
      return countWrappedLines(`![${node.alt ?? ''}](${node.url ?? ''})`, usable)
    case 'definition':
    case 'footnoteDefinition':
      return 0
    default: {
      const kids = node.children ?? []
      if (kids.length > 0) return kids.reduce((s, c) => s + blockRows(c, usable), 0)
      return node.value ? countWrappedLines(node.value, usable) : 0
    }
  }
}

/**
 * Render assistant Markdown to Ink. User and status text stays plain; only the
 * assistant surface goes through this.
 * @param props.text - the assistant text (possibly streaming).
 * @param props.usable - available text columns; tables shrink to it (omitting
 *                       keeps natural widths; long grids truncate at the Ink
 *                       box edge instead of wrapping).
 */
export function MarkdownText(props: { text: string; usable?: number }): React.JSX.Element {
  // Render the live text directly (no debounce): the transcript measures this
  // item's height from what is actually on screen, so display, measurement and
  // layout must all track the same (live) text. A debounced copy would make the
  // measured height lag the store text, under-sizing the row and keeping old
  // messages on screen while new content is clipped below the viewport.
  // Terminal-injection guard: untrusted model/tool text is stripped of control
  // bytes BEFORE parsing or the long-text plain path (dsh-tui-security.md).
  const safe = useMemo(() => stripTerminalControls(props.text), [props.text])
  const tree = useMemo(() => parse(safe), [safe])
  if (safe.length > 8_000) return <Text wrap="wrap">{safe}</Text>
  // Block separation is a LAYOUT MARGIN on each block, never
  // a painted blank row: a painted blank can measure 0 rows in a
  // scroll re-layout and merge into the next line (the glyph overwrites the
  // next line's first cell, deleting the gap); a margin is pure layout and
  // survives every paint path. estimateMarkdownHeight adds the same +1 per
  // block boundary, so the estimate matches the real layout.
  return (
    <Box width="100%" flexDirection="column">
      {(tree.children ?? []).map((node, i) => (
        <Box key={i} marginTop={i > 0 ? 1 : 0} flexShrink={0}>{renderBlock(node, i, props.usable ?? 0)}</Box>
      ))}
    </Box>
  )
}
