/**
 * Pin the `PAINT_WIDE` reservation (color-emoji terminals paint some symbols
 * TWO cells wide while the cursor advances ONE column).
 *
 * Without the reservation Ink's grid placement writes the NEXT cell over the
 * glyph's painted second column, so the row no longer matches the model:
 *   - `⏸ Paused` crams "Paused" against the pictograph (the reported overlap);
 *   - `☀️` inside a markdown table prints every later cell of that row — the
 *     sidebar divider included — one column LEFT, so the divider drifts on
 *     exactly those rows.
 * The fix (the established one, same as ⚠ / 🏷 / 🛠) is to count the glyph as two
 * columns AND make its reserved second cell a REAL space, so the cursor really
 * advances two. `U+23F8` (⏸) and `U+2600` (☀) were missing from the set.
 *
 * The source-level half always runs (it is what a stale patch would break); the
 * render-level half runs when the resolve farm carries the build-time patch
 * (`apps/tui-bin/build.mjs`), which is the case in any checkout that has been
 * built — the same artifact the SEA embeds.
 *
 * Run with `bun test tests/paint-wide-glyphs.test.ts`.
 *
 * @module qialike/paint-wide-glyphs-test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, test } from 'bun:test'

const ROOT = process.cwd()
const BUILD = readFileSync(join(ROOT, 'apps/tui-bin/build.mjs'), 'utf8')
const FARM = join(ROOT, 'node_modules')

/** Cursor advance of a rendered sequence on a color-emoji terminal: every
 *  reserved member advances ONE column even though it paints two (the astral
 *  members behave the same on VTE, per charwidth.ts's PAINT_WIDE_ASTRAL). */
const ADVANCE_ONE = new Set([0x23f8, 0x2600, 0x26a0, 0x1f3f7, 0x1f6e0])
function advance(s: string, width: (t: string) => number): number {
  let n = 0
  for (const ch of s) n += ADVANCE_ONE.has(ch.codePointAt(0)!) ? 1 : width(ch)
  return n
}

/** Render one line through the patched Ink (fake TTY) and return it decoded. */
async function renderLine(text: string): Promise<string> {
  const React = (await import('../packages/qialike-app/node_modules/react/index.js')).default
  const { Box, Text, render } = await import('../packages/qialike-app/node_modules/ink/build/index.js')
  const chunks: string[] = []
  class Sink extends Writable {
    columns = 60
    rows = 24
    isTTY = true
    _write(chunk: unknown, _enc: unknown, cb: () => void): void {
      chunks.push(String(chunk))
      cb()
    }
  }
  const instance = render(
    React.createElement(Box, { width: 40, flexDirection: 'column' }, React.createElement(Text, null, text)),
    { stdout: new Sink() as unknown as NodeJS.WriteStream, stdin: process.stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise((resolve) => setTimeout(resolve, 120))
  instance.unmount()
  const stripped = chunks.join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  return stripped.split('\n').find((line) => line.trim() !== '') ?? ''
}

/** The build-time patch applied to the resolve farm (idempotent). */
async function ensureFarmPatched(): Promise<void> {
  const mod = await import('../apps/tui-bin/build.mjs')
  mod.patchStringWidthEmojiBlocks(FARM)
  mod.patchInkWideChar(FARM)
}

describe('PAINT_WIDE covers the reported paint-wide glyphs (source level)', () => {
  test('both copies of the set list the same members, including ⏸ and ☀', () => {
    const sets = [...BUILD.matchAll(/new Set\(\[([^\]]*0x[^\]]*)\]\)/g)].map((m) => m[1]!.replace(/\s/g, ''))
    const paintWide = sets.filter((s) => s.includes('0x1f3f7'))
    expect(paintWide.length).toBe(2) // the string-width oracle + the Ink pad fallback
    expect(paintWide[0]).toBe(paintWide[1])
    for (const cp of ['0x23f8', '0x2600', '0x26a0']) expect(paintWide[0]).toContain(cp)
  })

  test('a stale patch is re-applied (the guard keys on the CURRENT pad rule)', () => {
    expect(BUILD).toContain("text.includes('const __padFlags = [];') && text.includes('__cw.get(__cp) !== 2')")
    // The old rule skipped the reservation whenever the calibration map existed
    // without the code point; a farm patched with it MUST be rewritten.
    expect(BUILD).not.toContain('__cw.get(__cp) === 1')
  })
})

describe('the reserved second cell is a real space (render level)', () => {
  test('⏸ Paused reserves two columns so the text cannot cram against the glyph', async () => {
    await ensureFarmPatched()
    const stringWidth = (await import('../packages/qialike-app/node_modules/string-width/index.js')).default
    if (stringWidth('⚠') !== 2) {
      // Unbuilt farm in this process (the patch cannot retarget a module that
      // was already imported by another test file): the source-level block above
      // still guards the set. Build (`node apps/tui-bin/build.mjs --single`) to
      // run this half.
      expect(stringWidth('⚠')).toBe(1)
      return
    }
    const out = await renderLine('⏸ Paused')
    // glyph + reserved cell + the source's own space ⇒ two spaces in the output
    expect(out).toContain('⏸  Paused')
    // …and the terminal's advance then equals the model's width for the source
    expect(advance(out, stringWidth)).toBe(stringWidth('⏸ Paused'))
  })

  test('☀️ gets its VS16 cell turned into a space, so a table row cannot drift', async () => {
    await ensureFarmPatched()
    const stringWidth = (await import('../packages/qialike-app/node_modules/string-width/index.js')).default
    if (stringWidth('⚠') !== 2) {
      expect(stringWidth('⚠')).toBe(1)
      return
    }
    const cell = '☀️ 晴'
    const out = await renderLine(cell)
    // The variation selector is REPLACED by the reserved space (never kept as a
    // zero-width cell the cursor does not consume).
    expect(out).not.toContain('\uFE0F')
    expect(out).toContain('☀ ')
    expect(advance(out, stringWidth)).toBe(stringWidth(cell))

    // The reported shape: a markdown table row carrying the emoji. Its later
    // cells — the sidebar divider column among them — must stay aligned.
    const tableRow = '│ 天气 │ ☀️ 晴 │'
    const outRow = await renderLine(tableRow)
    expect(outRow).not.toContain('\uFE0F')
    expect(advance(outRow, stringWidth)).toBe(stringWidth(tableRow))
  })

  test('the pre-existing member (⚠) keeps its reservation', async () => {
    await ensureFarmPatched()
    const stringWidth = (await import('../packages/qialike-app/node_modules/string-width/index.js')).default
    if (stringWidth('⚠') !== 2) {
      expect(stringWidth('⚠')).toBe(1)
      return
    }
    const out = await renderLine('⚠ warn')
    expect(out).toContain('⚠  warn')
    expect(advance(out, stringWidth)).toBe(stringWidth('⚠ warn'))
  })

  test('a PRESENT but EMPTY calibration map still reserves (the startup window)', async () => {
    await ensureFarmPatched()
    const stringWidth = (await import('../packages/qialike-app/node_modules/string-width/index.js')).default
    if (stringWidth('⚠') !== 2) {
      expect(stringWidth('⚠')).toBe(1)
      return
    }
    // charwidth.ts publishes `__dshCharWidths` at the START of calibration, and
    // `mountUi()` + `paintFileFirstScreen()` paint the first screen before the
    // sentinels are measured — so on a real start the map is present and empty
    // while rows are already on screen. An absent entry must mean UNKNOWN
    // (reserve), never "the terminal already advances two columns": reading it
    // the second way dropped the reserved cell, and because the frame writer
    // diffs line-by-line the short row stayed on screen after calibration.
    const host = globalThis as { __dshCharWidths?: Map<number, number> }
    const prev = host.__dshCharWidths
    try {
      host.__dshCharWidths = new Map()
      for (const text of ['⚠️ warn', '⚠ warn']) {
        const out = await renderLine(text)
        expect(out).not.toContain('\uFE0F')
        expect(advance(out, stringWidth)).toBe(stringWidth(text))
      }
    } finally {
      if (prev === undefined) delete host.__dshCharWidths
      else host.__dshCharWidths = prev
    }
  })

  test('the real markdown table from the reported session renders aligned', async () => {
    await ensureFarmPatched()
    const stringWidth = (await import('../packages/qialike-app/node_modules/string-width/index.js')).default
    if (stringWidth('⚠') !== 2) {
      expect(stringWidth('⚠')).toBe(1)
      return
    }
    const { MarkdownText, tableGrid } = await import('../packages/qialike-app/src/markdown.tsx')
    const React = (await import('../packages/qialike-app/node_modules/react/index.js')).default
    const { Box, render } = await import('../packages/qialike-app/node_modules/ink/build/index.js')
    // A weather table whose emoji cell is drawn two columns wide (the ☀️ case).
    const source = ['| 项目 | 数据 |', '| --- | --- |', '| 天气 | ☀️ 晴 |', '| 气温 | 32°C |'].join('\n')
    const chunks: string[] = []
    class Sink extends Writable {
      columns = 80
      rows = 24
      isTTY = true
      _write(chunk: unknown, _enc: unknown, cb: () => void): void {
        chunks.push(String(chunk))
        cb()
      }
    }
    const usable = 60
    const instance = render(
      React.createElement(Box, { width: usable, flexDirection: 'column' }, React.createElement(MarkdownText, { text: source, usable })),
      { stdout: new Sink() as unknown as NodeJS.WriteStream, stdin: process.stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    instance.unmount()
    const lines = chunks.join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n')
    const weatherRow = lines.find((line) => line.includes('天气')) ?? ''
    expect(weatherRow).not.toBe('')
    expect(weatherRow).not.toContain('\uFE0F')
    // Its terminal advance equals the model line tableGrid predicted — that is
    // what keeps the row's `│` cells (and the sidebar divider) in column.
    const model = tableGrid([['项目', '数据'], ['天气', '☀️ 晴'], ['气温', '32°C']], usable).lines
      .find((line) => line.includes('天气')) ?? ''
    expect(model).not.toBe('')
    expect(advance(weatherRow, stringWidth)).toBe(stringWidth(model))
  })
})
