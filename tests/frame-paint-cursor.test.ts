/**
 * The hardware cursor must not travel across the screen while a frame is
 * painted.
 *
 * Reported by the user (twice, in Chinese): typing `/` in the hero AND in the
 * session view makes the cursor blink "somewhere else" / all over the screen.
 *
 * Root cause (measured, not inferred): the patched frame writer moves the cursor
 * with a CUP before EVERY changed line and only appends its cursor suffix at the
 * END of the frame. The visibility in force while those CUPs execute is the one
 * the PREVIOUS frame's suffix left behind — normally `?25h`, the composer caret.
 * So a VISIBLE cursor was dragged to every repainted row. Opening the command
 * palette repaints ~16 lines in one frame, which is why that keystroke is the one
 * that shows it:
 *
 *   $ NO_CPR=1 python3 test/probes/vis-travel.py <binary>   # 工作台根目录下运行
 *   before: 16 visible row moves (rows 5..20) in the hero, 17 (rows 5..24) docked
 *   after:  0 in both
 *
 * A fast terminal consumes the whole write in one pass and shows nothing, which
 * is why this survived the earlier cursor work: every previous probe measured
 * DWELL TIME PER CELL (where the cursor rested) and was structurally blind to a
 * cursor that is MOVED while visible. It is also independent of CPR support —
 * the user's terminal does not answer CPR (their log says so), so the glyph
 * calibration path those earlier fixes touched never even runs for them.
 *
 * Two invariants keep it fixed, both pinned here at the source level because
 * they live in the injected Ink frame writer and in the panel's suffix string,
 * which unit tests cannot reach (they would have to boot the SEA binary on a
 * pty) — the same approach as the boot-screen hygiene and prompt-gate tests.
 *
 * Run with `bun test tests/frame-paint-cursor.test.ts`.
 *
 * @module dsh-tui/frame-paint-cursor-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const build = readFileSync(new URL('../apps/tui-bin/build.mjs', import.meta.url), 'utf8')
const panel = readFileSync(
  new URL('../packages/dsh-tui-app/src/panels/conversation.tsx', import.meta.url), 'utf8')

describe('the frame writer hides the cursor for the paint', () => {
  test('① the hide-before-paint helper exists and is wired into EVERY write path', () => {
    expect(build, 'helper').toContain('const __dshFrameEnvelope =')
    // The three writers: the normal frame, the calibration flush, and the
    // watchdog repaint. Every one of them must hide first — a path that appends
    // the suffix without hiding drags the visible cursor exactly as before.
    const suffixSites = build.match(/if \(suffix\) frame = .*;/g) ?? []
    expect(suffixSites.length, 'one site per writer').toBe(3)
    for (const site of suffixSites) {
      expect(site, 'wrapped by the envelope').toContain('__dshFrameEnvelope(frame, suffix)')
    }
    // …and there must be no writer left that appends a suffix on its own (that is
    // exactly the un-hidden, un-synchronized form that caused both defects).
    const naive = build.match(/if \(suffix\) frame \+= suffix;/g) ?? []
    expect(naive.length, 'no bare suffix append').toBe(0)
  })

  test('② the envelope is conditional (never strands the cursor hidden or the terminal buffering)', () => {
    // A build without the hook must change nothing: the envelope is a no-op
    // unless it is handed a non-empty suffix.
    const at = build.indexOf('const __dshFrameEnvelope =')
    const helper = build.slice(at, build.indexOf('};', at))
    expect(helper, 'suffix is required').toContain('!suffix')
    expect(helper, 'empty frame is left alone').toContain("frame === ''")
    expect(helper, 'the hide escape is ESC[?25l').toContain('\\x1b[?25l')
  })

  test('⑤ every frame is bracketed by synchronized output (?2026h … ?2026l)', () => {
    const at = build.indexOf('const __dshFrameEnvelope =')
    const helper = build.slice(at, build.indexOf('};', at))
    // Both ends must come from the SAME decision: emitting the opening mode
    // without its closing one would leave the terminal buffering forever.
    expect(helper, 'opens the mode').toContain('\\x1b[?2026h')
    expect(helper, 'closes the mode').toContain('\\x1b[?2026l')
    expect(helper, 'the close is gated on the same flag as the open').toMatch(/\(sync \? '[^']*2026l' : ''\)/)
    expect(helper, 'an opt-out exists').toContain('DSH_TUI_NO_SYNC')
    // The exit path must also close the mode, so a frame interrupted mid-write
    // cannot strand the terminal.
    const index = readFileSync(
      new URL('../packages/dsh-tui-app/src/index.tsx', import.meta.url), 'utf8')
    expect(index, 'exit closes the mode').toContain("'\\x1b[?2026l\\x1b[0 q")
  })
})

describe('the caret suffix parks BEFORE it reveals', () => {
  /** The suffix the conversation panel appends for the normal conversation view. */
  const suffix = (): string => {
    const at = panel.indexOf("if (store.sessionLoading !== null) return '\\x1b[?25l'")
    expect(at, 'the sessionLoading guard exists').toBeGreaterThan(-1)
    const ret = panel.indexOf('return `', at)
    return panel.slice(ret, panel.indexOf('\n', ret))
  }

  test('③ the show comes AFTER the CUP to the caret cell', () => {
    const line = suffix()
    // The exact shape: cursor shape, park at the caret cell, THEN reveal.
    const shape = line.indexOf('\\x1b[2 q')
    const cup = line.indexOf('\\x1b[${cell.row};${cell.col}H')
    const show = line.indexOf('\\x1b[?25h')
    expect(shape, 'the shape escape is emitted').toBeGreaterThan(-1)
    expect(cup, 'the suffix parks at the caret cell').toBeGreaterThan(-1)
    expect(show, 'the suffix reveals the cursor').toBeGreaterThan(-1)
    // Revealing first (`?25h...CUP`) flashes the cursor at the last painted row
    // for one round trip before the CUP moves it to the caret.
    expect(show, 'park, THEN reveal').toBeGreaterThan(cup)
    expect(cup, 'shape first, then the park').toBeGreaterThan(shape)
  })

  test('④ the reveal is one contiguous tail (no escape may follow it)', () => {
    const line = suffix()
    const show = line.indexOf('\\x1b[?25h')
    expect(line.slice(show), 'nothing after the reveal').toBe("\\x1b[?25h`")
  })
})
