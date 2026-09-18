/**
 * The layout's markdown-height ESTIMATE must equal the height Ink actually
 * PAINTS for the same row — the whole transcript viewport (its window slice,
 * `maxScroll` and the follow-tail anchor) is computed from it.
 *
 * Why this is a regression test at all: the transcript trusts a painted
 * measurement when one exists, but every first pass, and every row whose
 * measurement was dropped, falls back to `estimateMarkdownHeight`. A silent
 * undercount there puts the newest wrapped line below the viewport (the
 * "answer's tail never shows up; End does not help" report — see
 * qialike-development §2.5.51). The two sides of this test are the real
 * renderer (`<MarkdownText>`, measured through Ink's `measureElement`) and the
 * real estimator, at the geometry `conversation.tsx` uses:
 *
 *   terminal width  -> convUsableWidth(width, sidebar) = message column width
 *   message column  -> itemContent's `width="100%"` box with paddingLeft/Right = 3
 *   text area       -> MESSAGE_TEXT_WIDTH(column) = column - 6 = the `usable`
 *                      handed to <MarkdownText> and to estimateMarkdownHeight
 *
 * Run with `bun test tests/markdown-height-painted.test.ts`.
 *
 * @module qialike/markdown-height-painted-test
 */

import { Writable } from 'node:stream'
import { describe, expect, test } from 'bun:test'
import React from '../packages/qialike-app/node_modules/react/index.js'
import { Box, measureElement, render } from '../packages/qialike-app/node_modules/ink/build/index.js'
import { MarkdownText, estimateMarkdownHeight } from '../packages/qialike-app/src/markdown.tsx'

/** A TTY-shaped sink: Ink's layout only needs columns/rows/isTTY. */
class FakeStdout extends Writable {
  columns: number
  rows: number
  isTTY = true
  constructor(cols: number, rows: number) {
    super()
    this.columns = cols
    this.rows = rows
  }
  _write(_chunk: unknown, _enc: unknown, cb: () => void): void { cb() }
}

/** Painted height of one assistant row body — the exact element chain
 *  `itemContent` renders (see the module comment). */
async function paintedHeight(text: string, usable: number): Promise<number> {
  const ref = React.createRef<import('ink').DOMElement>()
  const element = React.createElement(
    Box,
    { width: usable, flexDirection: 'column' },
    React.createElement(
      Box,
      { width: '100%', paddingLeft: 3, paddingRight: 3, ref },
      React.createElement(MarkdownText, { text, usable: usable - 6 }),
    ),
  )
  const instance = render(element, {
    stdout: new FakeStdout(usable + 20, 40) as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  // Ink commits React, then runs its yoga layout; measureElement reads the
  // computed node height, so give the layout a beat before reading it.
  await new Promise((resolve) => setTimeout(resolve, 60))
  const height = measureElement(ref.current).height
  instance.unmount()
  return height
}

/** Everything Ink WROTE for one assistant row — the painted frame, escapes and
 *  all. {@link paintedHeight} reads yoga's computed height; this reads the bytes
 *  the terminal receives, which is what a clip shows up in. */
async function paintedFrame(text: string, usable: number): Promise<string> {
  const chunks: string[] = []
  class CaptureStdout extends FakeStdout {
    _write(chunk: unknown, _enc: unknown, cb: () => void): void {
      chunks.push(String(chunk))
      cb()
    }
  }
  const element = React.createElement(
    Box,
    { width: usable, flexDirection: 'column' },
    React.createElement(
      Box,
      { width: '100%', paddingLeft: 3, paddingRight: 3 },
      React.createElement(MarkdownText, { text, usable: usable - 6 }),
    ),
  )
  const instance = render(element, {
    stdout: new CaptureStdout(usable + 20, 40) as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  instance.unmount()
  return chunks.join('')
}

const COLUMNS = 100
/** Mirror of `convUsableWidth(width, sidebarVisibleFor(width))`: the message
 *  column's CONTENT width (the outer paddingX=1 already removed) at 100 cols
 *  with the sidebar visible. Kept as a literal so the test is not a tautology
 *  over the implementation it guards. */
const USABLE = COLUMNS - 2 - Math.max(20, Math.round(COLUMNS * 0.3))

/** Structured corpora: every markdown shape the transcript can meet. */
const samples: Record<string, string> = {
  'plain CJK paragraph': '这是一段用于测试中文折行的普通段落,长度足够跨越多个终端行。'.repeat(20),
  'headings + paragraphs': ['# 标题', '', '正文一段,写得长一点以便折行。', '', '## 小标题', '', '正文二段。', ''].join('\n').repeat(14),
  'bullet list': Array.from({ length: 40 }, (_, i) => `- 列表项 ${i}: 一些说明文字,足够长以触发折行`).join('\n'),
  'numbered list': Array.from({ length: 40 }, (_, i) => `${i + 1}. 编号项 ${i}: 一些说明文字,足够长以触发折行`).join('\n'),
  'fenced code': ['```ts', ...Array.from({ length: 40 }, (_, i) => `const value${i} = compute(${i}) // 注释`), '```'].join('\n'),
  // Over-wide lines: pin that the paint AND the estimate both wrap them. These
  // two agree even when the line is clipped (both used to count one row), so the
  // clip itself is pinned by the painted-bytes test below, not by the height.
  'fenced code, over-wide ASCII line': ['```bash', `python3 -c "${'import socket,time;t=time.time();'.repeat(4)}"`, 'echo done', '```'].join('\n'),
  'fenced code, over-wide CJK line': ['```text', '这是一行很长的中文说明文字,用来验证代码块内的宽字符折行与高度估算一致,长度需要超过代码框的内宽。'.repeat(2), '```'].join('\n'),
  blockquote: Array.from({ length: 20 }, (_, i) => `> 引用第 ${i} 行:一段被引用的说明文字`).join('\n\n'),
  table: ['| 序号 | 值 |', '| --- | --- |', ...Array.from({ length: 20 }, (_, i) => `| ${i} | 值 ${i} |`)].join('\n'),
  mixed: ['## 小标题', '', '先说结论:双进程被移除了,取舍如下。', '', '- 其一', '- 其二', '', '```ts', 'const a = 1', '```', ''].join('\n').repeat(10),
}

describe('estimateMarkdownHeight equals the painted row height', () => {
  for (const [name, text] of Object.entries(samples)) {
    test(`${name}`, async () => {
      expect(estimateMarkdownHeight(text, USABLE - 6)).toBe(await paintedHeight(text, USABLE))
    })
  }

  test('a long streamed assistant answer (the clipped-tail shape)', async () => {
    // Long CJK prose ending in a short question: the exact shape whose last
    // wrapped line used to be cut off below the transcript viewport.
    const answer = `${'双进程的复杂度每天都付,而巨型会话是少数场景。'.repeat(60)}\n\n要我把上面那两处残留(陈旧注释 + 死代码 source 参数)也清掉吗?这属于纯内部清理,不影响行为。`
    expect(estimateMarkdownHeight(answer, USABLE - 6)).toBe(await paintedHeight(answer, USABLE))
  })

  test('an over-wide code line is painted in FULL, not clipped', async () => {
    // `wrap="truncate"` kept only the frame's inner width and replaced the tail
    // with `…`, so a copied command silently lost its end (reported on a
    // 149-column one-liner in a ~120-column terminal). The estimate was never
    // wrong here — the LINE was missing — so only the painted bytes can pin it.
    const run = 'x'.repeat(140)
    const frame = await paintedFrame(['```bash', `echo ${run}`, '```'].join('\n'), USABLE)
    // CSI sequences (SGR, cursor moves, DEC private modes) carry no `x`, so the
    // count is exact either way; stripping keeps a failure readable.
    const painted = frame.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
    expect(painted.split('x').length - 1).toBe(run.length)
  })
})
