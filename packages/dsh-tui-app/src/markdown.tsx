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
 * @module @yourname/dsh-tui-app/markdown
 */

import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import stringWidth from 'string-width'
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

/** All heading levels share the opencode accent (opencode uses one markdownHeading color). */
function headingColor(_depth: number): string {
  return theme.accent
}

/** Render inline phrasing nodes as React nodes (no newlines). */
function renderInline(node: MdNode): React.ReactNode {
  switch (node.type) {
    case 'text': return node.value ?? ''
    case 'strong': return <Text bold color={theme.warning}>{renderInlineChildren(node)}</Text>
    case 'emphasis': return <Text color={theme.yellow}>{renderInlineChildren(node)}</Text>
    case 'delete': return <Text dimColor>{renderInlineChildren(node)}</Text>
    case 'inlineCode': return <Text color={theme.success}>{node.value ?? ''}</Text>
    case 'break': return '\n'
    case 'link': return (
      <Text color={theme.primary} underline>
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
  return kids.map((child, i) => <React.Fragment key={i}>{renderInline(child)}</React.Fragment>)
}

/** Render a paragraph's inline content as a single wrapped line. */
function renderParagraph(node: MdNode): React.ReactNode {
  return (
    <Text wrap="wrap">{renderInlineChildren(node)}</Text>
  )
}

/** Render a block-level node. */
function renderBlock(node: MdNode, key: number | string): React.ReactNode {
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
        <Box key={key} flexDirection="column">
          {kids.map((child, i) => child.type === 'paragraph'
            ? <Text key={`q-${key}-${i}`} color={theme.yellow} wrap="wrap">│ {renderInlineChildren(child)}</Text>
            : renderBlock(child, `${key}-q-${i}`))}
        </Box>
      )
    }
    case 'thematicBreak': return <Text key={key} color={theme.borderSubtle}>─{'─'.repeat(24)}</Text>
    case 'code': {
      const lines = (node.value ?? '').split('\n')
      return (
        <Box key={key} borderStyle="round" borderColor={theme.borderSubtle} paddingX={1} flexDirection="column">
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
        <Box key={key} flexDirection="column">
          {items.map((item, i) => (
            <Box key={i} flexDirection="column">
              <Text wrap="wrap">
                <Text color={theme.secondary}>{ordered ? `${start + i}. ` : '• '}</Text>
                {(item.children ?? []).map((child, j) => child.type === 'paragraph'
                  ? <React.Fragment key={`l-${i}-${j}`}>{renderInlineChildren(child)}</React.Fragment>
                  : null)}
              </Text>
              {(item.children ?? []).map((child, j) => child.type !== 'paragraph'
                ? renderBlock(child, `l-${i}-${j}`)
                : null)}
            </Box>
          ))}
        </Box>
      )
    }
    case 'table': {
      // Best-effort aligned grid; a terminal cannot do rich tables.
      const rows = (node.children ?? []).map((row: MdNode) =>
        (row.children ?? []).map((cell: MdNode) =>
          (cell.children ?? []).map(renderInline).join('')) )
      if (rows.length === 0) return null
      const header = rows[0] ?? []
      const width = header.length
      const pad = (s: string, w: number) => s.padEnd(w).slice(0, w)
      return (
        <Text key={key} wrap="wrap">
          {rows.map((row, r) => (
            <Text key={r} wrap="wrap">
              │ {row.map((cell, c) => pad(cell, Math.max(10, (header[c]?.length ?? 10)))).join(' │')} │
            </Text>))}
        </Text>
      )
    }
    case 'image': return <Text key={key} dimColor>{`![${node.alt ?? ''}](${node.url ?? ''})`}</Text>
    case 'definition': case 'footnoteDefinition': return null
    default: {
      const kids = node.children ?? []
      return (
        <Box key={key} flexDirection="column">
          {kids.length > 0
            ? kids.map((c, i) => renderBlock(c, `${key}-${i}`))
            : (node.value ? <Text wrap="wrap">{node.value}</Text> : null)}
        </Box>
      )
    }
  }
}

/** Render a root's children as block nodes. */
function renderRoot(node: MdNode): React.ReactNode {
  const children = node.children ?? []
  return children.map((child, i) => renderBlock(child, i))
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

/** Number of terminal rows a wrapped piece of text occupies at `usable` columns. */
export function countWrappedLines(text: string, usable: number): number {
  let total = 0
  for (const seg of text.split('\n')) {
    total += Math.max(1, Math.ceil(visualWidth(seg) / Math.max(1, usable)))
  }
  return total
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
      const rowsArr = (node.children ?? []).map((row) =>
        (row.children ?? []).map((cell) => inlinePlain(cell)))
      if (rowsArr.length === 0) return 0
      const header = rowsArr[0] ?? []
      const pad = (s: string, w: number) => s.padEnd(w).slice(0, w)
      let rows = 0
      for (const row of rowsArr) {
        const line = `│ ${row.map((cell, c) => pad(cell, Math.max(10, (header[c]?.length ?? 10)))).join(' │')} │`
        rows += countWrappedLines(line, usable)
      }
      return rows
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
 */
export function MarkdownText(props: { text: string }): React.JSX.Element {
  // Render the live text directly (no debounce): the transcript measures this
  // item's height from what is actually on screen, so display, measurement and
  // layout must all track the same (live) text. A debounced copy would make the
  // measured height lag the store text, under-sizing the row and keeping old
  // messages on screen while new content is clipped below the viewport.
  const tree = useMemo(() => parse(props.text), [props.text])
  if (props.text.length > 8_000) return <Text wrap="wrap">{props.text}</Text>
  // Blank lines between blocks are EXPLICIT one-space rows (not Box `gap`):
  // a gap lives only in the layout model, and under partial-item rendering / the
  // scroll `-shift` clipping it can be skipped, making a heading flush against
  // the content above. A real text row always renders, so the separation
  // survives every paint path.
  return (
    <Box flexDirection="column">
      {(tree.children ?? []).map((node, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <Text> </Text> : null}
          {renderBlock(node, i)}
        </React.Fragment>
      ))}
    </Box>
  )
}
