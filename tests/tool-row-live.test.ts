/**
 * Row-math tests for the RUNNING tool-row liveness (spinner + elapsed tail):
 * the one-line header must swap its static glyph for the live frame, carry the
 * `· Ns` tail without ever dropping it (narrow rows truncate the detail, never
 * the seconds), and the static header the estimate/copy paths share must stay
 * byte-identical to the pre-liveness form.
 *
 * Run with `bun test tests/tool-row-live.test.ts` (after `pnpm run build`).
 *
 * @module qialike/tool-row-live-test
 */

import { describe, expect, test } from 'bun:test'
import { visualWidth } from '../packages/qialike-app/src/markdown.tsx'
import { toolRowHeader } from '../packages/qialike-app/src/panels/conversation.tsx'
import type { TranscriptItem } from '../packages/qialike-app/src/index.tsx'

/** Header width the renderer caps at: max(8, usable - 6) (see
 *  MESSAGE_TEXT_WIDTH in conversation.tsx) — every header must fit it. */
function widthCap(usable: number): number {
  return Math.max(8, usable - 6)
}

const running = (name: string, argsRaw: string, startedAt = 1_000): TranscriptItem => ({
  key: 1,
  kind: 'tool',
  text: `│ ${name}`,
  tool: { state: 'running', startedAt, argsRaw },
})

describe('toolRowHeader running liveness', () => {
  test('static header (estimate/copy path) keeps the glyph and no live tail', () => {
    const header = toolRowHeader(running('bash', '{"command":"npm install && npm test","description":"Install deps"}'), 60)
    expect(header.startsWith('$')).toBe(true) // per-tool glyph, not a spinner
    expect(header).toContain('Bash')
    expect(header).toContain('Install deps') // web summary: description over command
    expect(header).not.toMatch(/·\s*\d+s$/) // no elapsed tail off the static path
    expect(visualWidth(header)).toBeLessThanOrEqual(widthCap(60))
  })

  test('live header swaps the glyph for the exact passed spinner frame', () => {
    const a = toolRowHeader(running('bash', '{"command":"ls -la"}'), 60, { frame: '⠋', seconds: 3 })
    const b = toolRowHeader(running('bash', '{"command":"ls -la"}'), 60, { frame: '⠸', seconds: 3 })
    expect(a.startsWith('⠋')).toBe(true)
    expect(b.startsWith('⠸')).toBe(true)
    expect(a[0]).not.toBe(b[0])
    expect(a).toContain('Bash · ls -la')
    expect(visualWidth(a)).toBeLessThanOrEqual(widthCap(60))
  })

  test('elapsed tail tracks the seconds and rides the row end', () => {
    const nine = toolRowHeader(running('bash', '{"command":"x"}'), 60, { frame: '⠙', seconds: 9 })
    const ten = toolRowHeader(running('bash', '{"command":"x"}'), 60, { frame: '⠙', seconds: 10 })
    expect(nine.endsWith('· 9s')).toBe(true)
    expect(ten.endsWith('· 10s')).toBe(true)
  })

  test('seconds survive truncation: a narrow row cuts the detail, never the tail', () => {
    const long = '{"command":"cd /very/long/workspace/path && pnpm install --frozen-lockfile && pnpm test && pnpm build"}'
    const header = toolRowHeader(running('bash', long), 12, { frame: '⠹', seconds: 123 })
    expect(header.endsWith('· 123s')).toBe(true)
    // Still a single visual line at the tiny width.
    expect(visualWidth(header)).toBeLessThanOrEqual(widthCap(12))
  })

  test('live tail is omitted while the run is idle-rendered (seconds null)', () => {
    const header = toolRowHeader(running('read', '{"path":"src/index.ts"}'), 60, { frame: '⠴', seconds: null })
    expect(header.startsWith('⠴')).toBe(true)
    expect(header).not.toMatch(/·\s*\d+s$/)
    expect(header).toContain('Read · src/index.ts')
  })

  test('read/write rows take the same live treatment', () => {
    const read = toolRowHeader(running('read', '{"path":"/tmp/x.ts"}'), 60, { frame: '⠦', seconds: 2 })
    const write = toolRowHeader(running('write', '{"file_path":"src/a.ts"}'), 60, { frame: '⠇', seconds: 2 })
    expect(read.startsWith('⠦')).toBe(true)
    expect(write.startsWith('⠇')).toBe(true)
    expect(read).toContain('Read · /tmp/x.ts')
    expect(write).toContain('Write · src/a.ts')
    expect(visualWidth(read)).toBeLessThanOrEqual(widthCap(60))
    expect(visualWidth(write)).toBeLessThanOrEqual(widthCap(60))
  })

  test('settled rows render the static glyph again (live must not leak)', () => {
    const ok = toolRowHeader({ key: 1, kind: 'tool', text: '✓ bash', tool: { state: 'ok', argsRaw: '{"command":"ls"}' } }, 60)
    const err = toolRowHeader({ key: 1, kind: 'tool', text: '✗ bash', tool: { state: 'error', argsRaw: '{"command":"ls"}' } }, 60)
    expect(ok.startsWith('$')).toBe(true)
    expect(err.startsWith('$')).toBe(true)
    expect(err.endsWith(' ✗')).toBe(true)
    expect(ok).not.toMatch(/·\s*\d+s$/)
    expect(visualWidth(ok)).toBeLessThanOrEqual(widthCap(60))
    expect(visualWidth(err)).toBeLessThanOrEqual(widthCap(60))
  })
})
